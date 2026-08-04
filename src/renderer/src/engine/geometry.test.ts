import { describe, expect, it } from 'vitest'
import {
  aabbContainsPoint,
  aabbIntersects,
  applyMat,
  distToSegment,
  flattenCubic,
  matInvert,
  matMultiply,
  matRotateDeg,
  matTranslate,
  nodeLocalMatrix,
  pointInEllipse,
  pointInPolygonRings,
  pointInRoundedRect,
  transformedRectAABB,
} from './geometry'

describe('matrices', () => {
  it('multiplies translate then rotate correctly', () => {
    const m = matMultiply(matTranslate(10, 20), matRotateDeg(90))
    const p = applyMat(m, { x: 1, y: 0 })
    expect(p.x).toBeCloseTo(10)
    expect(p.y).toBeCloseTo(21)
  })

  it('inverts a matrix', () => {
    const m = matMultiply(matTranslate(5, -3), matRotateDeg(37))
    const inv = matInvert(m)
    const p = applyMat(inv, applyMat(m, { x: 7, y: 11 }))
    expect(p.x).toBeCloseTo(7)
    expect(p.y).toBeCloseTo(11)
  })

  it('nodeLocalMatrix mirrors about the center, and leaves the box alone', () => {
    // A 100x40 node at (10, 20): flipping H swaps its left and right edges but
    // the box it occupies is identical, which is why a flip never moves a node.
    const m = nodeLocalMatrix(10, 20, 100, 40, 0, true, false)
    expect(applyMat(m, { x: 0, y: 0 })).toEqual({ x: 110, y: 20 })
    expect(applyMat(m, { x: 100, y: 0 })).toEqual({ x: 10, y: 20 })
    expect(applyMat(m, { x: 50, y: 20 })).toEqual({ x: 60, y: 40 }) // centre holds
    const v = nodeLocalMatrix(10, 20, 100, 40, 0, false, true)
    expect(applyMat(v, { x: 0, y: 0 })).toEqual({ x: 10, y: 60 })
    expect(applyMat(v, { x: 0, y: 40 })).toEqual({ x: 10, y: 20 })
  })

  it('flips before it rotates, so a mirror never spins the node', () => {
    // Flipping after the rotation would mirror the rotation itself: a 90° node
    // flipped H would come out at -90°. Mirroring first keeps the turn.
    const m = nodeLocalMatrix(0, 0, 100, 40, 90, true, false)
    // Node-local +x is mirrored to -x, then rotated 90° (x -> +y): so the
    // node's own right edge ends up ABOVE its centre, not below.
    const right = applyMat(m, { x: 100, y: 20 })
    const centre = applyMat(m, { x: 50, y: 20 })
    expect(right.y).toBeLessThan(centre.y)
    // Two flips are the identity.
    const twice = nodeLocalMatrix(7, 9, 100, 40, 33, true, true)
    const plain = nodeLocalMatrix(7, 9, 100, 40, 33)
    const p = { x: 81, y: 12 }
    const a = applyMat(twice, p)
    const b = applyMat(nodeLocalMatrix(7, 9, 100, 40, 33 + 180), p)
    // flipH+flipV about the centre IS a half turn: 33° flipped both ways
    // equals 213°.
    expect(a.x).toBeCloseTo(b.x, 9)
    expect(a.y).toBeCloseTo(b.y, 9)
    expect(applyMat(plain, p).x).not.toBeCloseTo(a.x, 6)
  })

  it('nodeLocalMatrix rotates about the center', () => {
    const m = nodeLocalMatrix(0, 0, 100, 50, 180)
    const center = applyMat(m, { x: 50, y: 25 })
    expect(center.x).toBeCloseTo(50)
    expect(center.y).toBeCloseTo(25)
    const corner = applyMat(m, { x: 0, y: 0 })
    expect(corner.x).toBeCloseTo(100)
    expect(corner.y).toBeCloseTo(50)
  })
})

describe('AABB', () => {
  it('computes rotated rect bounds', () => {
    const m = nodeLocalMatrix(0, 0, 100, 100, 45)
    const box = transformedRectAABB(m, 100, 100)
    const half = (Math.SQRT2 * 100) / 2
    expect(box.minX).toBeCloseTo(50 - half, 4)
    expect(box.maxX).toBeCloseTo(50 + half, 4)
  })

  it('intersections and containment', () => {
    expect(aabbIntersects({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { minX: 5, minY: 5, maxX: 15, maxY: 15 })).toBe(true)
    expect(aabbIntersects({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { minX: 11, minY: 0, maxX: 15, maxY: 5 })).toBe(false)
    expect(aabbContainsPoint({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { x: 5, y: 5 })).toBe(true)
  })
})

describe('point tests', () => {
  it('distToSegment', () => {
    expect(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5)
    expect(distToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5)
  })

  it('pointInPolygonRings (square with hole, even-odd)', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    const hole = [
      { x: 3, y: 3 },
      { x: 7, y: 3 },
      { x: 7, y: 7 },
      { x: 3, y: 7 },
    ]
    expect(pointInPolygonRings({ x: 1, y: 1 }, [outer, hole], true)).toBe(true)
    expect(pointInPolygonRings({ x: 5, y: 5 }, [outer, hole], true)).toBe(false)
    expect(pointInPolygonRings({ x: 11, y: 5 }, [outer, hole], true)).toBe(false)
  })

  it('pointInEllipse and rounded rect', () => {
    expect(pointInEllipse({ x: 5, y: 5 }, 5, 5, 5, 5)).toBe(true)
    expect(pointInEllipse({ x: 0.2, y: 0.2 }, 5, 5, 5, 5)).toBe(false)
    const r = { tl: 5, tr: 0, br: 0, bl: 0 }
    expect(pointInRoundedRect({ x: 0.5, y: 0.5 }, 20, 20, r)).toBe(false)
    expect(pointInRoundedRect({ x: 10, y: 10 }, 20, 20, r)).toBe(true)
  })

  it('flattenCubic endpoints', () => {
    const pts = flattenCubic({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 })
    const last = pts[pts.length - 1]
    expect(last.x).toBeCloseTo(10)
    expect(last.y).toBeCloseTo(0)
  })
})
