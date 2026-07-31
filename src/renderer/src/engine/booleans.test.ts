import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { booleanRings } from './booleans'
import { aabbOfPoints, pointInPolygonRings } from './geometry'
import { createNode } from './types'
import type { BooleanNode } from './types'

function boolWithTwoRects(op: BooleanNode['booleanOp']): { scene: SceneGraph; bool: BooleanNode } {
  const scene = new SceneGraph()
  const bool = createNode('BOOLEAN', 'Bool') as BooleanNode
  bool.booleanOp = op
  scene.addNode(bool, null, 0)
  const r1 = createNode('RECTANGLE', 'R1')
  r1.x = 0
  r1.y = 0
  r1.width = 100
  r1.height = 100
  scene.addNode(r1, bool.id, 0)
  const r2 = createNode('RECTANGLE', 'R2')
  r2.x = 50
  r2.y = 50
  r2.width = 100
  r2.height = 100
  scene.addNode(r2, bool.id, 1)
  return { scene, bool }
}

describe('boolean operations', () => {
  it('union covers both rects', () => {
    const { scene, bool } = boolWithTwoRects('UNION')
    const rings = booleanRings(scene, bool)
    expect(rings.length).toBeGreaterThan(0)
    const box = aabbOfPoints(rings.flat())
    expect(box.minX).toBeCloseTo(0)
    expect(box.maxX).toBeCloseTo(150)
    expect(pointInPolygonRings({ x: 25, y: 25 }, rings, true)).toBe(true)
    expect(pointInPolygonRings({ x: 125, y: 125 }, rings, true)).toBe(true)
  })

  it('subtract removes the overlap', () => {
    const { scene, bool } = boolWithTwoRects('SUBTRACT')
    const rings = booleanRings(scene, bool)
    expect(pointInPolygonRings({ x: 25, y: 25 }, rings, true)).toBe(true)
    expect(pointInPolygonRings({ x: 75, y: 75 }, rings, true)).toBe(false)
    expect(pointInPolygonRings({ x: 125, y: 125 }, rings, true)).toBe(false)
  })

  it('intersect keeps only the overlap', () => {
    const { scene, bool } = boolWithTwoRects('INTERSECT')
    const rings = booleanRings(scene, bool)
    expect(pointInPolygonRings({ x: 75, y: 75 }, rings, true)).toBe(true)
    expect(pointInPolygonRings({ x: 25, y: 25 }, rings, true)).toBe(false)
  })

  it('exclude removes only the overlap', () => {
    const { scene, bool } = boolWithTwoRects('EXCLUDE')
    const rings = booleanRings(scene, bool)
    expect(pointInPolygonRings({ x: 25, y: 25 }, rings, true)).toBe(true)
    expect(pointInPolygonRings({ x: 75, y: 75 }, rings, true)).toBe(false)
    expect(pointInPolygonRings({ x: 125, y: 125 }, rings, true)).toBe(true)
  })

  it('caches per scene version', () => {
    const { scene, bool } = boolWithTwoRects('UNION')
    const first = booleanRings(scene, bool)
    const second = booleanRings(scene, bool)
    expect(second).toBe(first)
    scene.bump()
    const third = booleanRings(scene, bool)
    expect(third).not.toBe(first)
  })
})
