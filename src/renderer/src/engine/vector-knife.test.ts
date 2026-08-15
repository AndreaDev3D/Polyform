// Cutting an outline in two.
//
// A knife has two jobs and the second one is the one that gets forgotten: make
// the cut, and leave everything it did not cut ALONE. So the cases here check
// the resulting parts and also that curves elsewhere on the shape came through
// as curves — a knife that quietly polygonises the rest of the path would pass
// every "is it two pieces now" assertion there is.

import { describe, expect, it } from 'vitest'
import { flattenCubic } from './geometry'
import type { VectorNetwork } from './types'
import { networkParts } from './vector-parts'
import { knifeCut } from './vector-knife'

/** Axis-aligned square, corners (0,0) (100,0) (100,100) (0,100). */
function square(): VectorNetwork {
  return {
    vertices: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 100, y: 0 },
      { id: 3, x: 100, y: 100 },
      { id: 4, x: 0, y: 100 },
    ],
    edges: [
      { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
      { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
      { id: 3, v0: 3, v1: 4, cp0: null, cp1: null },
      { id: 4, v0: 4, v1: 1, cp0: null, cp1: null },
    ],
  }
}

function area(pts: { x: number; y: number }[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

function partPoints(net: VectorNetwork, index: number): { x: number; y: number }[] {
  const part = networkParts(net)[index]
  const at = new Map(net.vertices.map((v) => [v.id, v]))
  return part.vertices.map((vid) => ({ x: at.get(vid)!.x, y: at.get(vid)!.y }))
}

describe('knife', () => {
  it('cuts a square in half, and the halves are closed', () => {
    const net = square()
    expect(knifeCut(net, { x: 50, y: -20 }, { x: 50, y: 120 })).toBeNull()
    const parts = networkParts(net)
    expect(parts).toHaveLength(2)
    expect(parts.every((p) => p.closed)).toBe(true)
    // Two halves of a 100x100 square. Checked by AREA rather than by anchor
    // count: a cut that produced the right number of points in the wrong places
    // would otherwise pass.
    const areas = [partPoints(net, 0), partPoints(net, 1)].map(area).sort((a, b) => a - b)
    expect(areas[0]).toBeCloseTo(5000, 6)
    expect(areas[1]).toBeCloseTo(5000, 6)
  })

  it('makes two DETACHED parts, not one shape with a crossbar', () => {
    const net = square()
    knifeCut(net, { x: 50, y: -20 }, { x: 50, y: 120 })
    // Each half owns its own copy of the cut edge. Sharing them would leave one
    // part with anchors of degree 3, which is a shape you cannot drag apart —
    // and dragging the halves apart is the point of cutting them.
    const parts = networkParts(net)
    expect(parts[0].vertices.some((v) => parts[1].vertices.includes(v))).toBe(false)
    expect(net.vertices).toHaveLength(8)
  })

  it('leaves curves it did not cut as curves', () => {
    const net = square()
    // Bow the top edge out. The cut below it must not touch this.
    net.edges[0].cp0 = { x: 30, y: -40 }
    net.edges[0].cp1 = { x: 70, y: -40 }
    expect(knifeCut(net, { x: -20, y: 60 }, { x: 120, y: 60 })).toBeNull()
    const curved = net.edges.filter((e) => e.cp0 || e.cp1)
    expect(curved).toHaveLength(1)
    expect(curved[0].cp0).toEqual({ x: 30, y: -40 })
    expect(curved[0].cp1).toEqual({ x: 70, y: -40 })
  })

  it('splits a curve it does cut, keeping both halves on the original curve', () => {
    const net = square()
    net.edges[0].cp0 = { x: 30, y: -40 }
    net.edges[0].cp1 = { x: 70, y: -40 }
    // A vertical cut through the bowed top edge and out the bottom.
    expect(knifeCut(net, { x: 50, y: -60 }, { x: 50, y: 120 })).toBeNull()
    // The bow is now two curved segments, both still curved: a De Casteljau
    // split, not a straight line drawn between the same endpoints.
    expect(net.edges.filter((e) => e.cp0 || e.cp1)).toHaveLength(2)
    // The cut lands on the curve at x=50, which by symmetry is its lowest point.
    const onCut = net.vertices.filter((v) => Math.abs(v.x - 50) < 1e-6)
    expect(onCut).toHaveLength(4) // two halves x two ends of the cut
    expect(onCut.some((v) => v.y < -20)).toBe(true)
  })

  it('keeps a curve stored against the walk direction pointing the right way', () => {
    // Every edge in the fixture above happens to be stored in walk order, so the
    // branch that swaps cp0/cp1 for a REVERSED edge never ran — deleting it left
    // all nine tests green. An edge's direction is a storage detail nothing in
    // the editor normalises: draw a path, join two ends, and half of them point
    // backwards.
    const net = square()
    // The bottom edge stored 4 -> 3, against the walk, with lopsided handles so
    // that swapping them changes the curve instead of mirroring it.
    net.edges[2] = { id: 3, v0: 4, v1: 3, cp0: { x: 10, y: 180 }, cp1: { x: 70, y: 120 } }

    // Three points ON that curve, straight from the cubic. Asserted
    // GEOMETRICALLY rather than by reading cp0/cp1 back, because an edge
    // re-emitted the other way round SHOULD have its handles swapped — the
    // question is only whether the curve still runs where it ran.
    const cubicAt = (t: number) => {
      const u = 1 - t
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
      const px = [0, 10, 70, 100]
      const py = [100, 180, 120, 100]
      return {
        x: w[0] * px[0] + w[1] * px[1] + w[2] * px[2] + w[3] * px[3],
        y: w[0] * py[0] + w[1] * py[1] + w[2] * py[2] + w[3] * py[3],
      }
    }
    const probes = [0.25, 0.5, 0.75].map(cubicAt)

    // Cut across the middle, nowhere near the bottom edge, so it comes through
    // untouched — and either right, or visibly not.
    expect(knifeCut(net, { x: -20, y: 50 }, { x: 120, y: 50 })).toBeNull()
    const at = new Map(net.vertices.map((v) => [v.id, v]))
    const outline: { x: number; y: number }[] = []
    for (const e of net.edges) {
      const p = at.get(e.v0)!
      const q = at.get(e.v1)!
      outline.push(p, ...flattenCubic(p, e.cp0 ?? p, e.cp1 ?? q, q, 0.01))
    }
    for (const probe of probes) {
      const nearest = Math.min(...outline.map((o) => Math.hypot(o.x - probe.x, o.y - probe.y)))
      expect(nearest).toBeLessThan(0.5)
    }
  })

  it('slices every outline the one stroke crosses', () => {
    // Two detached squares side by side, one horizontal cut through both.
    const net = square()
    const right = square()
    for (const v of right.vertices) {
      v.id += 10
      v.x += 200
    }
    for (const e of right.edges) {
      e.id += 10
      e.v0 += 10
      e.v1 += 10
    }
    net.vertices.push(...right.vertices)
    net.edges.push(...right.edges)
    expect(networkParts(net)).toHaveLength(2)
    expect(knifeCut(net, { x: -20, y: 50 }, { x: 420, y: 50 })).toBeNull()
    // One stroke of a knife, not one per shape.
    expect(networkParts(net)).toHaveLength(4)
  })

  it('declines a cut that does not cross anything', () => {
    const net = square()
    const before = structuredClone(net)
    expect(knifeCut(net, { x: 200, y: 200 }, { x: 300, y: 300 })).toMatch(/cross a closed outline/)
    expect(net).toEqual(before)
  })

  it('declines a cut that stops inside the shape', () => {
    const net = square()
    // Only one crossing: a knife that closed the cut on its own would invent an
    // edge the user never drew.
    expect(knifeCut(net, { x: -20, y: 50 }, { x: 50, y: 50 })).toMatch(/cross a closed outline/)
  })

  it('declines a zero-length cut', () => {
    expect(knifeCut(square(), { x: 50, y: 50 }, { x: 50, y: 50 })).toMatch(/no length/)
  })

  it('leaves an open path alone', () => {
    const net = square()
    net.edges.pop()
    const before = structuredClone(net)
    // Nothing is enclosed, so there is no "two halves" to produce.
    expect(knifeCut(net, { x: 50, y: -20 }, { x: 50, y: 120 })).toMatch(/cross a closed outline/)
    expect(net).toEqual(before)
  })
})
