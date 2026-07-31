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
