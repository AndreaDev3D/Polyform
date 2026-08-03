import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { createNode } from './types'
import type { FrameNode, GroupNode } from './types'

describe('SceneGraph', () => {
  it('tracks parents, order and reparenting', () => {
    const scene = new SceneGraph()
    const a = createNode('RECTANGLE', 'A')
    const b = createNode('RECTANGLE', 'B')
    const frame = createNode('FRAME', 'F') as FrameNode
    scene.addNode(frame, null, 0)
    scene.addNode(a, null, 1)
    scene.addNode(b, frame.id, 0)

    expect(scene.rootIds()).toEqual([frame.id, a.id])
    expect(scene.parentOf(b.id)).toBe(frame.id)
    expect(scene.indexInParent(a.id)).toBe(1)

    scene.moveNode(a.id, frame.id, 1)
    expect(frame.children).toEqual([b.id, a.id])
    expect(scene.rootIds()).toEqual([frame.id])
    expect(scene.isAncestorOf(frame.id, a.id)).toBe(true)
    expect(scene.topLevelAncestor(a.id)).toBe(frame.id)
  })

  it('computes world matrices through nested containers', () => {
    const scene = new SceneGraph()
    const group = createNode('GROUP', 'G') as GroupNode
    group.x = 100
    group.y = 50
    scene.addNode(group, null, 0)
    const rect = createNode('RECTANGLE', 'R')
    rect.x = 10
    rect.y = 20
    scene.addNode(rect, group.id, 0)
    const m = scene.worldMatrix(rect.id)
    expect(m.e).toBeCloseTo(110)
    expect(m.f).toBeCloseTo(70)
  })

  it('worldAABB includes children and stroke padding', () => {
    const scene = new SceneGraph()
    const group = createNode('GROUP', 'G') as GroupNode
    scene.addNode(group, null, 0)
    const rect = createNode('RECTANGLE', 'R')
    rect.x = -50
    rect.y = 0
    rect.width = 30
    rect.height = 30
    scene.addNode(rect, group.id, 0)
    const box = scene.worldAABB(group.id)
    expect(box.minX).toBeLessThanOrEqual(-50)
    expect(box.maxX).toBeGreaterThanOrEqual(100) // group's own 100x100 frame
  })

  it("a container's effect padding reaches around its children, not just itself", () => {
    // A group has no geometry of its own, so its drop shadow is cast by what
    // is inside it. Padding only the (zero-sized) group rect left the shadow
    // outside the box, which cropped it out of exports.
    const scene = new SceneGraph()
    const group = createNode('GROUP', 'G') as GroupNode
    group.width = 0
    group.height = 0
    group.x = 200
    group.y = 200
    scene.addNode(group, null, 0)
    const rect = createNode('RECTANGLE', 'R')
    rect.x = 0
    rect.y = 0
    rect.width = 100
    rect.height = 100
    scene.addNode(rect, group.id, 0)

    const plain = scene.worldAABB(group.id)
    expect(plain.maxX).toBeCloseTo(300)
    expect(plain.maxY).toBeCloseTo(300)

    group.effects = [
      { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 8 }, blur: 16 },
    ]
    scene.bump()
    const shadowed = scene.worldAABB(group.id)
    // pad = max(|offset| + blur) = 24 on every side.
    expect(shadowed.minX).toBeCloseTo(176)
    expect(shadowed.minY).toBeCloseTo(176)
    expect(shadowed.maxX).toBeCloseTo(324)
    expect(shadowed.maxY).toBeCloseTo(324)
  })

  it('render order excludes boolean children and respects z', () => {
    const scene = new SceneGraph()
    const bool = createNode('BOOLEAN', 'B')
    scene.addNode(bool, null, 0)
    const r1 = createNode('RECTANGLE', 'R1')
    scene.addNode(r1, bool.id, 0)
    const r2 = createNode('RECTANGLE', 'R2')
    scene.addNode(r2, null, 1)
    const order = scene.renderOrder()
    expect(order).toEqual([bool.id, r2.id])
    expect(scene.zRank().get(r2.id)).toBeGreaterThan(scene.zRank().get(bool.id)!)
  })
})
