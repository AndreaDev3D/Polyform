// DocumentStore: owns the SceneGraph, History, and SpatialIndex outside of
// React (ADR-010). React subscribes via useSyncExternalStore; the canvas
// reads directly every frame.

import { useSyncExternalStore } from 'react'
import { SceneGraph } from '../engine/scene'
import { History, applyOps, type PatchOp } from '../engine/commands'
import { SpatialIndex } from '../engine/spatial-index'
import { runDerivedPasses } from '../engine/layout'
import { ROOT_INHERITED_KEYS, sanitizeOverride } from '../engine/components'
import type { NodeId, SceneNode } from '../engine/types'
import { decodeScene, encodeScene } from '../engine/serialization'
import { assetCache } from '../engine/assets'
import { refreshProjectShaders } from '../engine/materials/load'
import { renderThumbnail } from '../engine/export/png'
import type { OpenProjectResult, ProjectInfo, ViewportState } from '../../../shared/types'

/**
 * Merge a gesture's stream of update ops into one op per node: the FIRST
 * `before` seen for a key (the pre-gesture value) and the LAST `after`.
 * Anything other than plain updates is passed through untouched.
 */
function coalesceUpdates(ops: PatchOp[]): PatchOp[] {
  if (!ops.every((op) => op.kind === 'update')) return ops
  const merged = new Map<NodeId, { before: Record<string, unknown>; after: Record<string, unknown> }>()
  for (const op of ops) {
    if (op.kind !== 'update') continue
    let entry = merged.get(op.id)
    if (!entry) {
      entry = { before: {}, after: {} }
      merged.set(op.id, entry)
    }
    for (const [key, value] of Object.entries(op.before)) {
      if (!(key in entry.before)) entry.before[key] = value
    }
    Object.assign(entry.after, op.after)
  }
  return [...merged].map(([id, e]) => ({ kind: 'update' as const, id, before: e.before, after: e.after }))
}

class DocumentStore {
  scene = new SceneGraph()
  history = new History()
  index = new SpatialIndex()
  projectInfo: ProjectInfo | null = null
  dirty = false

  private listeners = new Set<() => void>()
  private changeCounter = 0

  constructor() {
    this.history.hooks = {
      onAppend: (entry) => {
        void window.polyform.historyAppend(entry.label, JSON.stringify(entry.ops))
      },
      onCursor: (cursor) => {
        void window.polyform.historySetCursor(cursor)
      },
      onChange: () => {
        this.markDirty(true)
      },
    }
  }

  // ---------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): number => this.changeCounter

  emit(): void {
    this.changeCounter++
    for (const fn of this.listeners) fn()
  }

  // ---------------------------------------------------------------------
  // Mutation pipeline
  // ---------------------------------------------------------------------

  // -------------------------------------------------------------------
  // Scrub gestures
  //
  // While the user drags a value in the inspector, every step applies to
  // the scene (so the canvas updates live) but must land in history as ONE
  // entry. Between beginScrub() and endScrub() commits are diverted into a
  // buffer and merged on release — this sits at the commit sink, so it
  // covers every action the inspector can reach, not just simple patches.
  // -------------------------------------------------------------------

  private scrubOps: PatchOp[] | null = null
  private scrubLabel = 'Edit'

  /** True while a drag/scrub gesture is accumulating — autosave waits it out. */
  get scrubbing(): boolean {
    return this.scrubOps !== null
  }

  beginScrub(): void {
    this.scrubOps = []
  }

  endScrub(): void {
    const ops = this.scrubOps
    this.scrubOps = null
    if (!ops || ops.length === 0) return
    this.commit(coalesceUpdates(ops), this.scrubLabel, true)
  }

  /** Commit ops through history (applied=true when scene already mutated). */
  commit(ops: PatchOp[], label: string, applied = false): void {
    if (ops.length === 0) return
    if (!applied) applyOps(this.scene, ops)
    if (this.scrubOps) {
      // Mid-gesture: the scene is already updated; defer the journal entry.
      this.scrubLabel = label
      this.scrubOps.push(...ops)
      this.afterMutation()
      return
    }
    // Edits inside instances also update the instance's override map so the
    // change survives component re-syncs (same journal entry, same undo).
    const extra = this.captureInstanceOverrides(ops)
    this.history.commit(this.scene, extra.length > 0 ? [...ops, ...extra] : ops, label, true)
    this.afterMutation()
  }

  private captureInstanceOverrides(ops: PatchOp[]): PatchOp[] {
    const scene = this.scene
    const touched = new Map<NodeId, Map<NodeId, Record<string, unknown>>>()
    const record = (instId: NodeId, sourceId: NodeId, props: Record<string, unknown>) => {
      if (Object.keys(props).length === 0) return
      let m = touched.get(instId)
      if (!m) {
        m = new Map()
        touched.set(instId, m)
      }
      m.set(sourceId, { ...(m.get(sourceId) ?? {}), ...structuredClone(props) })
    }
    for (const op of ops) {
      if (op.kind !== 'update') continue
      const node = scene.getNode(op.id)
      if (!node) continue
      if (node.type === 'INSTANCE' && node.componentId) {
        // Direct edits of inherited root props become root overrides.
        const rootProps: Record<string, unknown> = {}
        for (const key of Object.keys(op.after)) {
          if ((ROOT_INHERITED_KEYS as readonly string[]).includes(key)) rootProps[key] = op.after[key]
        }
        record(node.id, node.componentId, rootProps)
      } else if (node.sourceId) {
        let instId: NodeId | null = null
        for (const aid of scene.ancestors(op.id)) {
          if (scene.getNode(aid)?.type === 'INSTANCE') {
            instId = aid
            break
          }
        }
        if (instId) record(instId, node.sourceId, sanitizeOverride(op.after))
      }
    }
    const extra: PatchOp[] = []
    for (const [instId, sources] of touched) {
      const inst = scene.getNode(instId)
      if (!inst || inst.type !== 'INSTANCE') continue
      const before = structuredClone(inst.overrides ?? {})
      const after = structuredClone(before)
      for (const [sourceId, props] of sources) {
        after[sourceId] = { ...(after[sourceId] ?? {}), ...props }
      }
      if (JSON.stringify(before) === JSON.stringify(after)) continue
      scene.updateNode(instId, { overrides: after } as Partial<SceneNode>)
      extra.push({
        kind: 'update',
        id: instId,
        before: { overrides: before },
        after: { overrides: structuredClone(after) },
      })
    }
    return extra
  }

  /** Time travel: jump to a history position (0..applied+pending length). */
  jumpTo(target: number): void {
    let steps = 0
    while (this.history.cursor > target && this.history.canUndo && steps++ < 10_000) {
      this.history.undo(this.scene)
    }
    while (this.history.cursor < target && this.history.canRedo && steps++ < 10_000) {
      this.history.redo(this.scene)
    }
    this.afterMutation()
  }

  /** Direct transient mutation happened (live drag) — refresh derived state. */
  transient(): void {
    this.afterMutation(false)
  }

  undo(): void {
    if (this.history.undo(this.scene)) this.afterMutation()
  }

  redo(): void {
    if (this.history.redo(this.scene)) this.afterMutation()
  }

  private afterMutation(dirty = true): void {
    runDerivedPasses(this.scene)
    if (dirty) this.markDirty(true)
    this.emit()
  }

  markDirty(d: boolean): void {
    if (this.dirty !== d) {
      this.dirty = d
      window.polyform.setDirty(d)
      // The dirty dot in the toolbar reads this flag — repaint subscribers.
      this.emit()
    }
  }

  // ---------------------------------------------------------------------
  // Project lifecycle
  // ---------------------------------------------------------------------

  private loadFromResult(result: OpenProjectResult): void {
    assetCache.clear()
    let doc = null
    if (result.sceneBytes && result.sceneBytes.byteLength > 0) {
      try {
        doc = decodeScene(new Uint8Array(result.sceneBytes))
      } catch (err) {
        console.error('Failed to decode scene.bin:', err)
        doc = null
      }
    }
    this.scene = new SceneGraph(doc ?? undefined)
    this.index = new SpatialIndex()
    this.history = new History()
    this.history.hooks = {
      onAppend: (entry) => void window.polyform.historyAppend(entry.label, JSON.stringify(entry.ops)),
      onCursor: (cursor) => void window.polyform.historySetCursor(cursor),
      onChange: () => this.markDirty(true),
    }
    // Restore session-spanning undo/redo from the SQLite journal.
    const entries = result.journal.entries.flatMap((e) => {
      try {
        return [{ label: e.label, ops: JSON.parse(e.ops) as PatchOp[], at: e.created_at }]
      } catch {
        return []
      }
    })
    this.history.load(entries, result.journal.cursor)
    this.projectInfo = result.info
    runDerivedPasses(this.scene)
    this.markDirty(false)
    this.dirty = false
    this.emit()
  }

  async newProject(): Promise<ViewportState | null> {
    const result = await window.polyform.projectNew()
    if (!result) return null
    this.loadFromResult(result)
    // Import-on-use, like libraries: the bundle's shaders/ is read at open
    // and on the explicit Reload action, never watched (ADR-013). Fire and
    // forget — a shader arriving late repaints via the material cache.
    void refreshProjectShaders()
    return result.info.manifest.viewport_state
  }

  async openProject(path?: string): Promise<ViewportState | null> {
    const result = await window.polyform.projectOpen(path)
    if (!result) return null
    this.loadFromResult(result)
    void refreshProjectShaders()
    return result.info.manifest.viewport_state
  }

  private savePromise: Promise<boolean> | null = null

  /** Saves are serialized: overlapping requests await the in-flight save. */
  async save(viewport: ViewportState, includeThumbnail = true): Promise<boolean> {
    if (!this.projectInfo) return false
    if (this.savePromise) return this.savePromise
    const p = this.doSave(viewport, includeThumbnail)
    this.savePromise = p
    try {
      return await p
    } finally {
      this.savePromise = null
    }
  }

  private async doSave(viewport: ViewportState, includeThumbnail: boolean): Promise<boolean> {
    const sceneBytes = encodeScene(this.scene.doc)
    let thumbnailPng: Uint8Array | undefined
    if (includeThumbnail) {
      try {
        thumbnailPng = (await renderThumbnail(this.scene, this.index, assetCache)) ?? undefined
      } catch {
        thumbnailPng = undefined
      }
    }
    const ok = await window.polyform.projectSave({ sceneBytes, viewport, thumbnailPng })
    if (ok) this.markDirty(false)
    return ok
  }

  async saveAs(viewport: ViewportState): Promise<boolean> {
    if (!this.projectInfo) return false
    const sceneBytes = encodeScene(this.scene.doc)
    const info = await window.polyform.projectSaveAs({ sceneBytes, viewport })
    if (info) {
      this.projectInfo = info
      this.markDirty(false)
      this.emit()
      return true
    }
    return false
  }
}

export const documentStore = new DocumentStore()

/** Re-render a component whenever the document (or history) changes. */
export function useDocVersion(): number {
  return useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot)
}
