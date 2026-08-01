// Reversible patch-based command system (Technical-Specification §4).
// Every mutation is a serializable PatchOp list; undo applies inverted ops in
// reverse. Ops are JSON-encoded into the SQLite journal for session-spanning
// history.

import type { DocumentStyles, NodeId, Page, PolyformDocument, SceneNode } from './types'
import { cloneNode, createPage, emptyStyles, isContainer } from './types'
import { SCHEMA_VERSION } from './types'
import type { SceneGraph } from './scene'

export type PatchOp =
  | { kind: 'add'; parentId: NodeId | null; index: number; node: SceneNode }
  | { kind: 'remove'; parentId: NodeId | null; index: number; node: SceneNode }
  | { kind: 'update'; id: NodeId; before: Record<string, unknown>; after: Record<string, unknown> }
  | {
      kind: 'move'
      id: NodeId
      from: { parentId: NodeId | null; index: number }
      to: { parentId: NodeId | null; index: number }
    }
  | { kind: 'page-add'; index: number; page: Page }
  | { kind: 'page-remove'; index: number; page: Page }
  | { kind: 'page-rename'; pageId: string; before: string; after: string }
  | { kind: 'styles-set'; before: DocumentStyles; after: DocumentStyles }

export function applyOp(scene: SceneGraph, op: PatchOp): void {
  switch (op.kind) {
    case 'add':
      scene.addNode(cloneNode(op.node), op.parentId, op.index)
      break
    case 'remove':
      scene.removeNode(op.node.id)
      break
    case 'update':
      scene.updateNode(op.id, structuredClone(op.after) as Partial<SceneNode>)
      break
    case 'move':
      scene.moveNode(op.id, op.to.parentId, op.to.index)
      break
    case 'page-add': {
      const page = structuredClone(op.page)
      page.rootIds = [] // node ops populate the page
      scene.doc.pages.splice(Math.min(op.index, scene.doc.pages.length), 0, page)
      scene.bump()
      break
    }
    case 'page-remove': {
      const idx = scene.doc.pages.findIndex((p) => p.id === op.page.id)
      if (idx >= 0) scene.doc.pages.splice(idx, 1)
      if (scene.doc.activePageId === op.page.id && scene.doc.pages.length > 0) {
        scene.doc.activePageId = scene.doc.pages[Math.min(idx, scene.doc.pages.length - 1)].id
      }
      scene.bump()
      break
    }
    case 'page-rename': {
      const page = scene.getPage(op.pageId)
      if (page) page.name = op.after
      scene.bump()
      break
    }
    case 'styles-set': {
      scene.doc.styles = structuredClone(op.after)
      scene.bump()
      break
    }
  }
}

export function invertOp(op: PatchOp): PatchOp {
  switch (op.kind) {
    case 'add':
      return { kind: 'remove', parentId: op.parentId, index: op.index, node: op.node }
    case 'remove':
      return { kind: 'add', parentId: op.parentId, index: op.index, node: op.node }
    case 'update':
      return { kind: 'update', id: op.id, before: op.after, after: op.before }
    case 'move':
      return { kind: 'move', id: op.id, from: op.to, to: op.from }
    case 'page-add':
      return { kind: 'page-remove', index: op.index, page: op.page }
    case 'page-remove':
      return { kind: 'page-add', index: op.index, page: op.page }
    case 'page-rename':
      return { kind: 'page-rename', pageId: op.pageId, before: op.after, after: op.before }
    case 'styles-set':
      return { kind: 'styles-set', before: op.after, after: op.before }
  }
}

export function applyOps(scene: SceneGraph, ops: PatchOp[]): void {
  for (const op of ops) applyOp(scene, op)
}

export function undoOps(scene: SceneGraph, ops: PatchOp[]): void {
  for (let i = ops.length - 1; i >= 0; i--) applyOp(scene, invertOp(ops[i]))
}

// ---------------------------------------------------------------------------
// Op builders
// ---------------------------------------------------------------------------

/**
 * Build an update op containing only the keys present in `after`, capturing
 * `before` from the current node state.
 */
export function makeUpdateOp(node: SceneNode, after: Record<string, unknown>): PatchOp {
  const before: Record<string, unknown> = {}
  const rec = node as unknown as Record<string, unknown>
  for (const key of Object.keys(after)) {
    before[key] = structuredClone(rec[key])
  }
  return { kind: 'update', id: node.id, before, after: structuredClone(after) }
}

/**
 * Ops that remove a whole subtree. Children are removed front-to-back (each
 * at index 0 of its parent), containers after their children; inversion
 * rebuilds the exact structure.
 */
export function removeSubtreeOps(scene: SceneGraph, id: NodeId): PatchOp[] {
  const ops: PatchOp[] = []
  const walk = (nid: NodeId) => {
    const node = scene.requireNode(nid)
    if (isContainer(node)) {
      for (const cid of [...node.children]) walk(cid)
    }
    const snapshot = cloneNode(node)
    if (isContainer(snapshot)) snapshot.children = []
    ops.push({
      kind: 'remove',
      parentId: scene.parentOf(nid),
      index: nid === id ? scene.indexInParent(nid) : 0,
      node: snapshot,
    })
  }
  walk(id)
  return ops
}

/** A detached bundle of nodes (used by clipboard / duplicate / grouping). */
export interface NodeBundle {
  nodes: Record<NodeId, SceneNode>
  rootIds: NodeId[]
}

/**
 * Ops that insert a bundle's roots under `parentId` starting at `baseIndex`.
 * Container ops carry empty children arrays; child add-ops fill them in order.
 */
export function addBundleOps(bundle: NodeBundle, parentId: NodeId | null, baseIndex: number): PatchOp[] {
  const ops: PatchOp[] = []
  const addSubtree = (id: NodeId, parent: NodeId | null, index: number) => {
    const node = bundle.nodes[id]
    if (!node) return
    const snapshot = cloneNode(node)
    const childIds = isContainer(snapshot) ? [...snapshot.children] : []
    if (isContainer(snapshot)) snapshot.children = []
    ops.push({ kind: 'add', parentId: parent, index, node: snapshot })
    childIds.forEach((cid, i) => addSubtree(cid, id, i))
  }
  bundle.rootIds.forEach((rid, i) => addSubtree(rid, parentId, baseIndex + i))
  return ops
}

/** Deep-copy a subtree out of the scene into a detached bundle. */
export function extractBundle(scene: SceneGraph, rootIds: NodeId[]): NodeBundle {
  const bundle: NodeBundle = { nodes: {}, rootIds: [...rootIds] }
  const walk = (id: NodeId) => {
    const node = scene.getNode(id)
    if (!node) return
    bundle.nodes[id] = cloneNode(node)
    if (isContainer(node)) for (const cid of node.children) walk(cid)
  }
  for (const id of rootIds) walk(id)
  return bundle
}

/** Re-id every node in a bundle (for paste/duplicate). */
export function reIdBundle(bundle: NodeBundle, makeId: () => NodeId): NodeBundle {
  const mapping = new Map<NodeId, NodeId>()
  for (const id of Object.keys(bundle.nodes)) mapping.set(id, makeId())
  const nodes: Record<NodeId, SceneNode> = {}
  for (const [oldId, node] of Object.entries(bundle.nodes)) {
    const copy = cloneNode(node)
    copy.id = mapping.get(oldId)!
    if (isContainer(copy)) copy.children = copy.children.map((c) => mapping.get(c) ?? c)
    nodes[copy.id] = copy
  }
  return { nodes, rootIds: bundle.rootIds.map((r) => mapping.get(r) ?? r) }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  label: string
  ops: PatchOp[]
  /** ISO timestamp (from the journal for restored sessions). */
  at?: string
}

export interface HistoryHooks {
  /** Persist a newly committed entry (journal append). */
  onAppend?: (entry: HistoryEntry) => void
  /** Persist the undo cursor (number of applied entries). */
  onCursor?: (cursor: number) => void
  /** Fired after any commit/undo/redo. */
  onChange?: () => void
}

export class History {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  hooks: HistoryHooks = {}

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  get cursor(): number {
    return this.undoStack.length
  }

  peekUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null
  }

  peekRedoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null
  }

  /**
   * Commit an entry. When `applied` is true the scene already reflects the
   * ops (live-drag pattern: only `update` ops may be pre-applied).
   */
  commit(scene: SceneGraph, ops: PatchOp[], label: string, applied = false): void {
    if (ops.length === 0) return
    if (!applied) applyOps(scene, ops)
    const entry: HistoryEntry = { label, ops, at: new Date().toISOString() }
    this.undoStack.push(entry)
    this.redoStack = []
    this.hooks.onAppend?.(entry)
    this.hooks.onChange?.()
  }

  /** Read-only views for the history browser. */
  entriesApplied(): readonly HistoryEntry[] {
    return this.undoStack
  }

  entriesPending(): readonly HistoryEntry[] {
    return [...this.redoStack].reverse()
  }

  undo(scene: SceneGraph): HistoryEntry | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    undoOps(scene, entry.ops)
    this.redoStack.push(entry)
    this.hooks.onCursor?.(this.cursor)
    this.hooks.onChange?.()
    return entry
  }

  redo(scene: SceneGraph): HistoryEntry | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    applyOps(scene, entry.ops)
    this.undoStack.push(entry)
    this.hooks.onCursor?.(this.cursor)
    this.hooks.onChange?.()
    return entry
  }

  /** Restore stacks from a persisted journal (without touching the scene). */
  load(entries: { label: string; ops: PatchOp[]; at?: string }[], cursor: number): void {
    const c = Math.max(0, Math.min(cursor, entries.length))
    this.undoStack = entries.slice(0, c)
    this.redoStack = entries.slice(c).reverse()
    this.hooks.onChange?.()
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.hooks.onChange?.()
  }
}

// ---------------------------------------------------------------------------
// Structural helpers used by editor actions
// ---------------------------------------------------------------------------

export function emptyDocument(): PolyformDocument {
  const page = createPage('Page 1')
  return {
    schemaVersion: SCHEMA_VERSION,
    nodes: {},
    pages: [page],
    activePageId: page.id,
    styles: emptyStyles(),
  }
}
