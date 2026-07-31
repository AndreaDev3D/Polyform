import { describe, expect, it } from 'vitest'
import { ellipsePath, flattenSubPath, networkToSubPaths, polygonPath, roundedRectPath, starPath, subPathsToSvg } from './shapes'
import { aabbOfPoints } from './geometry'
import type { VectorNetwork } from './types'

describe('shape outlines', () => {
  it('rounded rect stays within bounds', () => {
    const sp = roundedRectPath(100, 60, { tl: 10, tr: 20, br: 30, bl: 0 })
    const pts = flattenSubPath(sp)
    const box = aabbOfPoints(pts)
    expect(box.minX).toBeGreaterThanOrEqual(-0.01)
    expect(box.maxX).toBeLessThanOrEqual(100.01)
    expect(box.maxY).toBeLessThanOrEqual(60.01)
  })

  it('ellipse approximation covers the box', () => {
    const pts = flattenSubPath(ellipsePath(100, 40))
    const box = aabbOfPoints(pts)
    expect(box.minX).toBeCloseTo(0, 0)
    expect(box.maxX).toBeCloseTo(100, 0)
    expect(box.maxY).toBeCloseTo(40, 0)
  })

  it('polygon and star vertex counts', () => {
    expect(polygonPath(10, 10, 6).anchors).toHaveLength(6)
    expect(starPath(10, 10, 5, 0.5).anchors).toHaveLength(10)
  })

  it('vector network chain walking produces open and closed paths', () => {
    const open: VectorNetwork = {
      vertices: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 10, y: 0 },
        { id: 2, x: 20, y: 5 },
      ],
      edges: [
        { id: 0, v0: 0, v1: 1, cp0: null, cp1: null },
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
      ],
    }
    const openPaths = networkToSubPaths(open)
    expect(openPaths).toHaveLength(1)
    expect(openPaths[0].closed).toBe(false)
    expect(openPaths[0].anchors).toHaveLength(3)

    const closed: VectorNetwork = {
      vertices: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 10, y: 0 },
        { id: 2, x: 5, y: 8 },
      ],
      edges: [
        { id: 0, v0: 0, v1: 1, cp0: null, cp1: null },
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
        { id: 2, v0: 2, v1: 0, cp0: null, cp1: null },
      ],
    }
    const closedPaths = networkToSubPaths(closed)
    expect(closedPaths).toHaveLength(1)
    expect(closedPaths[0].closed).toBe(true)
  })

  it('emits valid-looking SVG path data', () => {
    const d = subPathsToSvg([roundedRectPath(10, 10, { tl: 0, tr: 0, br: 0, bl: 0 })])
    expect(d.startsWith('M ')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
  })
})
