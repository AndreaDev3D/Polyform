import { describe, expect, it } from 'vitest'
import {
  ellipsePath,
  flattenSubPath,
  networkToSubPaths,
  polygonPath,
  roundSubPathCorners,
  roundedRectPath,
  starPath,
  subPathsToSvg,
  type SubPath,
} from './shapes'
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

// ---------------------------------------------------------------------------
// Per-point corner radius
// ---------------------------------------------------------------------------

describe('roundSubPathCorners', () => {
  /** A square, corners at (0,0) (100,0) (100,100) (0,100). */
  const square = (): SubPath => ({
    closed: true,
    anchors: [
      { p: { x: 0, y: 0 }, cpIn: null, cpOut: null },
      { p: { x: 100, y: 0 }, cpIn: null, cpOut: null },
      { p: { x: 100, y: 100 }, cpIn: null, cpOut: null },
      { p: { x: 0, y: 100 }, cpIn: null, cpOut: null },
    ],
  })

  it('leaves the path untouched — the same object — when nothing is rounded', () => {
    const sp = square()
    expect(roundSubPathCorners(sp, [0, 0, 0, 0])).toBe(sp)
  })

  it('turns one corner into two anchors joined by an arc', () => {
    const out = roundSubPathCorners(square(), [0, 20, 0, 0])
    expect(out.anchors).toHaveLength(5)
    // The corner at (100,0) becomes (80,0) -> (100,20): 20 back along each
    // neighbour, which is what a radius of 20 means at a right angle.
    const [a, b] = [out.anchors[1], out.anchors[2]]
    expect(a.p).toEqual({ x: 80, y: 0 })
    expect(b.p).toEqual({ x: 100, y: 20 })
    // Controls point at the corner that was cut, κ·r along each tangent.
    expect(a.cpOut!.x).toBeCloseTo(80 + KAPPA_R(20), 12)
    expect(a.cpOut!.y).toBe(0)
    expect(b.cpIn!.x).toBe(100)
    expect(b.cpIn!.y).toBeCloseTo(20 - KAPPA_R(20), 12)
    // ...and the untouched corners are still the same objects.
    expect(out.anchors[0].p).toEqual({ x: 0, y: 0 })
    expect(out.anchors[3].p).toEqual({ x: 100, y: 100 })
  })

  it('matches the rounded-rectangle generator, which is the same geometry', () => {
    const rounded = roundSubPathCorners(square(), [15, 15, 15, 15])
    const rect = roundedRectPath(100, 100, { tl: 15, tr: 15, br: 15, bl: 15 })
    // Same eight anchors and the same arcs; only the starting point differs
    // (the rect generator starts on the left edge), so compare as sets of
    // rounded coordinates.
    const key = (sp: SubPath) =>
      sp.anchors
        .map((a) => `${a.p.x.toFixed(6)},${a.p.y.toFixed(6)}`)
        .sort()
        .join(' ')
    expect(rounded.anchors).toHaveLength(8)
    expect(key(rounded)).toBe(key(rect))
  })

  it('caps the radius at half the shorter neighbour, so two corners cannot collide', () => {
    // A 100x10 sliver: rounding the two right-hand corners with r=40 each
    // would need 40px of a 10px edge.
    const sliver: SubPath = {
      closed: true,
      anchors: [
        { p: { x: 0, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 100, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 100, y: 10 }, cpIn: null, cpOut: null },
        { p: { x: 0, y: 10 }, cpIn: null, cpOut: null },
      ],
    }
    const out = roundSubPathCorners(sliver, [0, 40, 40, 0])
    // 5 of the short edge each: they meet exactly, never cross.
    expect(out.anchors[1].p).toEqual({ x: 95, y: 0 })
    expect(out.anchors[2].p).toEqual({ x: 100, y: 5 })
    expect(out.anchors[3].p).toEqual({ x: 100, y: 5 })
    expect(out.anchors[4].p).toEqual({ x: 95, y: 10 })
  })

  it('refuses a point whose neighbour is a curve, and keeps the radius stored', () => {
    const withCurve = square()
    // Curve the top edge, between anchors 0 and 1.
    withCurve.anchors[0].cpOut = { x: 30, y: -40 }
    withCurve.anchors[1].cpIn = { x: 70, y: -40 }
    const out = roundSubPathCorners(withCurve, [0, 20, 20, 0])
    // Anchor 1's incoming segment is curved, so it stays sharp; anchor 2 has
    // two straight neighbours and rounds.
    expect(out.anchors.map((a) => `${a.p.x},${a.p.y}`)).toEqual([
      '0,0',
      '100,0',
      '100,80',
      '80,100',
      '0,100',
    ])
  })

  it('never rounds the ends of an open path', () => {
    const open: SubPath = {
      closed: false,
      anchors: [
        { p: { x: 0, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 100, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 100, y: 100 }, cpIn: null, cpOut: null },
      ],
    }
    const out = roundSubPathCorners(open, [30, 30, 30])
    // Only the middle point has two neighbours.
    expect(out.anchors).toHaveLength(4)
    expect(out.anchors[0].p).toEqual({ x: 0, y: 0 })
    expect(out.anchors[3].p).toEqual({ x: 100, y: 100 })
  })

  it('leaves collinear and degenerate corners alone', () => {
    const collinear: SubPath = {
      closed: true,
      anchors: [
        { p: { x: 0, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 50, y: 0 }, cpIn: null, cpOut: null }, // straight through
        { p: { x: 100, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 50, y: 50 }, cpIn: null, cpOut: null },
      ],
    }
    const out = roundSubPathCorners(collinear, [0, 25, 0, 0])
    expect(out.anchors).toHaveLength(4)
    expect(out.anchors[1].p).toEqual({ x: 50, y: 0 })

    // Two coincident points have no direction to round toward.
    const doubled: SubPath = {
      closed: true,
      anchors: [
        { p: { x: 0, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 0, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 50, y: 0 }, cpIn: null, cpOut: null },
      ],
    }
    expect(roundSubPathCorners(doubled, [10, 10, 10]).anchors).toHaveLength(3)
  })

  it('treats a NaN radius as sharp rather than poisoning the path', () => {
    const out = roundSubPathCorners(square(), [0, NaN, 0, 0])
    expect(out.anchors).toHaveLength(4)
    for (const a of out.anchors) {
      expect(Number.isFinite(a.p.x) && Number.isFinite(a.p.y)).toBe(true)
    }
  })

  it('reaches the outline through the network, per vertex', () => {
    const net: VectorNetwork = {
      vertices: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 100, y: 0, cornerRadius: 20 },
        { id: 2, x: 100, y: 100 },
      ],
      edges: [
        { id: 0, v0: 0, v1: 1, cp0: null, cp1: null },
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
        { id: 2, v0: 2, v1: 0, cp0: null, cp1: null },
      ],
    }
    const [sp] = networkToSubPaths(net)
    expect(sp.anchors).toHaveLength(4)
    expect(sp.anchors.some((a) => a.cpOut !== null)).toBe(true)
    // Without the radius it is a plain triangle again.
    net.vertices[1].cornerRadius = 0
    expect(networkToSubPaths(net)[0].anchors).toHaveLength(3)
  })
})

/** κ·r — the control arm of a quarter-circle arc of radius r. */
function KAPPA_R(r: number): number {
  return 0.5522847498307936 * r
}
