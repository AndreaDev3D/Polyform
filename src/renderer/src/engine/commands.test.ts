import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import {
  History,
  addBundleOps,
  applyOps,
  extractBundle,
  makeUpdateOp,
  reIdBundle,
  removeSubtreeOps,
  undoOps,
} from './commands'
import { createNode } from './types'
import type { FrameNode } from './types'

function makeScene(): { scene: SceneGraph; frame: FrameNode; rectId: string } {
  const scene = new SceneGraph()
  const frame = createNode('FRAME', 'Frame 1') as FrameNode
  scene.addNode(frame, null, 0)
  const rect = createNode('RECTANGLE', 'Rect')
  scene.addNode(rect, frame.id, 0)
  return { scene, frame, rectId: rect.id }
}

describe('patch ops', () => {
  it('update op round-trips through undo', () => {
    const { scene, rectId } = makeScene()
    const rect = scene.requireNode(rectId)
    const op = makeUpdateOp(rect, { x: 42, y: 7 })
    applyOps(scene, [op])
    expect(scene.requireNode(rectId).x).toBe(42)
    undoOps(scene, [op])
    expect(scene.requireNode(rectId).x).toBe(0)
  })

  it('removeSubtreeOps removes and undo restores structure', () => {
    const { scene, frame, rectId } = makeScene()
    const ops = removeSubtreeOps(scene, frame.id)
    applyOps(scene, ops)
    expect(scene.hasNode(frame.id)).toBe(false)
    expect(scene.hasNode(rectId)).toBe(false)
    expect(scene.rootIds()).toHaveLength(0)
    undoOps(scene, ops)
    expect(scene.hasNode(frame.id)).toBe(true)
    expect(scene.hasNode(rectId)).toBe(true)
    expect(scene.parentOf(rectId)).toBe(frame.id)
    expect((scene.requireNode(frame.id) as FrameNode).children).toEqual([rectId])
  })

  it('bundle extract -> reId -> add preserves hierarchy', () => {
    const { scene, frame, rectId } = makeScene()
    const bundle = reIdBundle(extractBundle(scene, [frame.id]), () => `new-${Math.random().toString(36).slice(2)}`)
    const ops = addBundleOps(bundle, null, 1)
    applyOps(scene, ops)
    expect(scene.rootIds()).toHaveLength(2)
    const copyId = bundle.rootIds[0]
    expect(copyId).not.toBe(frame.id)
    const copy = scene.requireNode(copyId) as FrameNode
    expect(copy.children).toHaveLength(1)
    expect(copy.children[0]).not.toBe(rectId)
  })
})

describe('History', () => {
  it('commit/undo/redo with journal hooks', () => {
    const { scene, rectId } = makeScene()
    const history = new History()
    const appended: string[] = []
    const cursors: number[] = []
    history.hooks = {
      onAppend: (e) => appended.push(e.label),
      onCursor: (c) => cursors.push(c),
    }
    const rect = scene.requireNode(rectId)
    history.commit(scene, [makeUpdateOp(rect, { x: 100 })], 'Move')
    expect(scene.requireNode(rectId).x).toBe(100)
    expect(appended).toEqual(['Move'])
    expect(history.canUndo).toBe(true)

    history.undo(scene)
    expect(scene.requireNode(rectId).x).toBe(0)
    expect(history.canRedo).toBe(true)
    expect(cursors).toEqual([0])

    history.redo(scene)
    expect(scene.requireNode(rectId).x).toBe(100)
    expect(cursors).toEqual([0, 1])
  })

  it('load() restores session-spanning stacks', () => {
    const { scene, rectId } = makeScene()
    const rect = scene.requireNode(rectId)
    // Simulate a journal: one applied entry, one redoable entry.
    const e1 = { label: 'Move', ops: [makeUpdateOp(rect, { x: 5 })] }
    rect.x = 5
    const e2 = { label: 'Move again', ops: [makeUpdateOp(rect, { x: 10 })] }
    const history = new History()
    history.load([e1, e2], 1)
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(true)
    expect(history.peekUndoLabel()).toBe('Move')
    expect(history.peekRedoLabel()).toBe('Move again')
    history.undo(scene)
    expect(scene.requireNode(rectId).x).toBe(0)
  })
})
