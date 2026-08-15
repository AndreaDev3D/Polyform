// Merging two overlapping parts of one shape into one outline.
//
// Area is the assertion that matters. "Is it one part now" is easy to satisfy
// by accident — chain the arcs in the wrong order and you still get one closed
// ring, just one that traces a bowtie. The union of two known squares has a
// known area, and that pins the boundary down.

import { describe, expect, it } from 'vitest'
import type { VectorNetwork } from './types'
import { networkParts } from './vector-parts'
import { cycleSteps, ringPolyline } from './vector-rings'
import { dissolveParts } from './vector-dissolve'

/** Axis-aligned rectangle as a closed part, ids from `base`. */
function rect(base: number, x0: number, y0: number, x1: number, y1: number): VectorNetwork {
  return {
    vertices: [
      { id: base + 1, x: x0, y: y0 },
      { id: base + 2, x: x1, y: y0 },
      { id: base + 3, x: x1, y: y1 },
      { id: base + 4, x: x0, y: y1 },
    ],
    edges: [
      { id: base + 1, v0: base + 1, v1: base + 2, cp0: null, cp1: null },
      { id: base + 2, v0: base + 2, v1: base + 3, cp0: null, cp1: null },
      { id: base + 3, v0: base + 3, v1: base + 4, cp0: null, cp1: null },
      { id: base + 4, v0: base + 4, v1: base + 1, cp0: null, cp1: null },
    ],
  }
}

function merge(...nets: VectorNetwork[]): VectorNetwork {
  return {
    vertices: nets.flatMap((n) => n.vertices),
    edges: nets.flatMap((n) => n.edges),
  }
}

/** Area of the one remaining part, from its flattened outline. */
function soleArea(net: VectorNetwork): number {
  const parts = networkParts(net)
  expect(parts).toHaveLength(1)
  const steps = cycleSteps(net, parts[0])
  expect(steps).not.toBeNull()
  const pts = ringPolyline(steps!, 0.01)
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

describe('dissolve', () => {
  it('merges two overlapping squares into their union', () => {
    // 100x100 at the origin, and the same square shifted 50 right and 50 down.
    // Union = 2 x 10000 minus the 50x50 they share = 17500.
    const net = merge(rect(0, 0, 0, 100, 100), rect(10, 50, 50, 150, 150))
    expect(dissolveParts(net)).toBeNull()
    expect(soleArea(net)).toBeCloseTo(17500, 2)
  })

  it('swallows a part that sits wholly inside another', () => {
    // No crossings at all, so there is no boundary to walk — but it is the same
    // request, and the outer outline already IS the union.
    const net = merge(rect(0, 0, 0, 100, 100), rect(10, 25, 25, 75, 75))
    expect(dissolveParts(net)).toBeNull()
    expect(soleArea(net)).toBeCloseTo(10000, 2)
  })

  it('keeps going until nothing overlaps', () => {
    // Three squares in a chain, each overlapping the next.
    const net = merge(rect(0, 0, 0, 100, 100), rect(10, 60, 0, 160, 100), rect(20, 120, 0, 220, 100))
    expect(dissolveParts(net)).toBeNull()
    // One row 220 wide and 100 tall, with nothing double-counted.
    expect(soleArea(net)).toBeCloseTo(22000, 2)
  })

  it('keeps a curve that is nowhere near the overlap', () => {
    const net = merge(rect(0, 0, 0, 100, 100), rect(10, 50, 50, 150, 150))
    // Bow the first square's top edge upward. It is far from the overlap in the
    // bottom right, so it must come through as a curve — this is the whole
    // reason dissolve walks the union instead of calling the boolean core,
    // which would hand back polygons and straighten it.
    net.edges[0].cp0 = { x: 30, y: -40 }
    net.edges[0].cp1 = { x: 70, y: -40 }
    expect(dissolveParts(net)).toBeNull()
    const curved = net.edges.filter((e) => e.cp0 || e.cp1)
    expect(curved).toHaveLength(1)
    expect(curved[0].cp0).toEqual({ x: 30, y: -40 })
    expect(curved[0].cp1).toEqual({ x: 70, y: -40 })
  })

  it('declines when the parts are separate', () => {
    const net = merge(rect(0, 0, 0, 100, 100), rect(10, 300, 300, 400, 400))
    const before = structuredClone(net)
    expect(dissolveParts(net)).toMatch(/do not overlap/)
    expect(net).toEqual(before)
  })

  it('declines when there is only one part', () => {
    expect(dissolveParts(rect(0, 0, 0, 100, 100))).toMatch(/two closed parts/)
  })
})
