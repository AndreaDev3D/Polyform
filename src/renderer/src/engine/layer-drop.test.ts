import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { createNode } from './types'
import type { FrameNode, InstanceNode } from './types'
import { dropAtEnd, dropOnRow, instanceRefusal } from './layer-drop'

/** A frame holding one rect, plus two rects at root. Panel order is reverse z. */
function fixture() {
  const scene = new SceneGraph()
  const bottom = createNode('RECTANGLE', 'Bottom')
  const frame = createNode('FRAME', 'Frame') as FrameNode
  const top = createNode('RECTANGLE', 'Top')
  scene.addNode(bottom, null, 0)
  scene.addNode(frame, null, 1)
  scene.addNode(top, null, 2)
  const child = createNode('RECTANGLE', 'Child')
  scene.addNode(child, frame.id, 0)
  return { scene, bottom, frame, top, child, page: scene.activePage.id }
}

describe('layer drop targets', () => {
  it('drops above a row into a higher index, because the panel is reverse z', () => {
    const { scene, bottom, top, page } = fixture()
    // Hovering the top quarter of "Bottom" (index 0) means in front of it.
    const above = dropOnRow(scene, [top.id], bottom.id, 0.1)
    expect(above.target).toEqual({ parentId: page, index: 1, nestInto: null })
    expect(above.side).toBe('top')

    const below = dropOnRow(scene, [top.id], bottom.id, 0.9)
    expect(below.target).toEqual({ parentId: page, index: 0, nestInto: null })
    expect(below.side).toBe('bottom')
  })

  it('nests into a container from its middle band, and reorders from its edges', () => {
    const { scene, frame, top } = fixture()
    const into = dropOnRow(scene, [top.id], frame.id, 0.5)
    expect(into.target).toEqual({ parentId: frame.id, index: 1, nestInto: frame.id })
    // Nothing to draw a line on: the row itself lights up instead.
    expect(into.side).toBeNull()

    expect(dropOnRow(scene, [top.id], frame.id, 0.15).target?.nestInto).toBeNull()
    expect(dropOnRow(scene, [top.id], frame.id, 0.85).target?.nestInto).toBeNull()
  })

  it('refuses a drop inside the dragged layer, with a reason', () => {
    const { scene, frame, child } = fixture()
    const r = dropOnRow(scene, [frame.id], child.id, 0.5)
    expect(r.target).toBeNull()
    expect(r.refuse).toMatch(/inside itself/)
  })

  it('says nothing when hovering the dragged row itself', () => {
    const { scene, top } = fixture()
    expect(dropOnRow(scene, [top.id], top.id, 0.5)).toEqual({
      target: null,
      side: null,
      refuse: null,
    })
  })

  it('locks structural moves in and out of an instance', () => {
    const { scene, frame, top, page } = fixture()
    const inst = createNode('INSTANCE', 'Inst') as InstanceNode
    scene.addNode(inst, null, 3)
    const inner = createNode('RECTANGLE', 'Inner')
    scene.addNode(inner, inst.id, 0)

    // Into the instance.
    expect(dropOnRow(scene, [top.id], inst.id, 0.5).refuse).toMatch(/into an instance/)
    // Beside one of its children — still inside it.
    expect(dropOnRow(scene, [top.id], inner.id, 0.9).refuse).toMatch(/into an instance/)
    // Out of it.
    expect(dropOnRow(scene, [inner.id], frame.id, 0.9).refuse).toMatch(/can’t be moved/)
    // Page roots and plain containers stay allowed.
    expect(instanceRefusal(scene, [top.id], page)).toBeNull()
    expect(instanceRefusal(scene, [top.id], frame.id)).toBeNull()
    expect(instanceRefusal(scene, [top.id], null)).toBeNull()
  })

  it('drops past the last row at the back of the page root list', () => {
    const { scene, child, page } = fixture()
    const r = dropAtEnd(scene, [child.id])
    expect(r.target).toEqual({ parentId: page, index: 0, nestInto: null })
    expect(r.side).toBe('bottom')
  })
})
