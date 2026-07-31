// DocumentStore: owns the SceneGraph, History, and SpatialIndex outside of
// React (ADR-010). React subscribes via useSyncExternalStore; the canvas
// reads directly every frame.

import { useSyncExternalStore } from 'react'
import { SceneGraph } from '../engine/scene'
import { History, type PatchOp } from '../engine/commands'
import { SpatialIndex } from '../engine/spatial-index'
import { runDerivedPasses } from '../engine/layout'
import { decodeScene, encodeScene } from '../engine/serialization'
import { assetCache } from '../engine/assets'
import { renderThumbnail } from '../engine/export/png'
import type { OpenProjectResult, ProjectInfo, ViewportState } from '../../../shared/types'

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

  /** Commit ops through history (applied=true when scene already mutated). */
  commit(ops: PatchOp[], label: string, applied = false): void {
    if (ops.length === 0) return
    this.history.commit(this.scene, ops, label, applied)
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
        return [{ label: e.label, ops: JSON.parse(e.ops) as PatchOp[] }]
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
    return result.info.manifest.viewport_state
  }

  async openProject(path?: string): Promise<ViewportState | null> {
    const result = await window.polyform.projectOpen(path)
    if (!result) return null
    this.loadFromResult(result)
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
