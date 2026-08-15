// Telling the separate parts of one network apart, and connecting them.
//
// The whole point of these two modules is that a VECTOR node is a flat bag of
// vertices and edges with no notion of "this outline" — so every case here is
// stated as which anchors end up in which part, because that grouping is the
// only thing the tools above them can read.

import { describe, expect, it } from 'vitest'
import type { VectorNetwork } from './types'
import { groupByPart, networkParts, partOfVertex } from './vector-parts'
import { bridgeVertices, joinVertices, weldLooseEnds } from './vector-connect'

/** A closed loop of `n` points on a circle centred at (cx, cy), ids from `base`. */
function loop(base: number, cx: number, cy: number, r: number, n = 4): VectorNetwork {
  const vertices = Array.from({ length: n }, (_, i) => ({
    id: base + i,
    x: cx + r * Math.cos((i / n) * Math.PI * 2),
    y: cy + r * Math.sin((i / n) * Math.PI * 2),
  }))
  const edges = Array.from({ length: n }, (_, i) => ({
    id: base + i,
    v0: base + i,
    v1: base + ((i + 1) % n),
    cp0: null,
    cp1: null,
  }))
  return { vertices, edges }
}

/** Two detached squares, ids 1-4 on the left and 11-14 on the right. */
function twoParts(): VectorNetwork {
  const a = loop(1, 0, 0, 10)
  const b = loop(11, 100, 0, 10)
  return { vertices: [...a.vertices, ...b.vertices], edges: [...a.edges, ...b.edges] }
}

describe('network parts', () => {
  it('finds one part in a single closed loop', () => {
    const parts = networkParts(loop(1, 0, 0, 10))
    expect(parts).toHaveLength(1)
    expect(parts[0].vertices).toEqual([1, 2, 3, 4])
    expect(parts[0].closed).toBe(true)
  })

  it('finds two parts in two detached loops', () => {
    const parts = networkParts(twoParts())
    expect(parts).toHaveLength(2)
    expect(parts[0].vertices).toEqual([1, 2, 3, 4])
    expect(parts[1].vertices).toEqual([11, 12, 13, 14])
    expect(parts.every((p) => p.closed)).toBe(true)
  })

  it('calls an open chain open', () => {
    const net = loop(1, 0, 0, 10)
    net.edges.pop()
    // Two ends of degree 1: nothing is enclosed, so Paint and Dissolve have
    // nothing to act on and need to be able to say so.
    expect(networkParts(net)[0].closed).toBe(false)
  })

  it('keeps a lone vertex as a part of its own', () => {
    const net = loop(1, 0, 0, 10)
    net.vertices.push({ id: 99, x: 50, y: 50 })
    // It cannot be drawn, but it CAN be selected and joined. A walk that started
    // from edges would leave it invisible to every tool here.
    const parts = networkParts(net)
    expect(parts).toHaveLength(2)
    expect(parts[1].vertices).toEqual([99])
    expect(parts[1].closed).toBe(false)
  })

  it('orders parts by their smallest anchor, whatever order the edges are in', () => {
    const net = twoParts()
    net.edges.reverse()
    // Stable order is load-bearing: Paint keys a fill to a part index, so a part
    // that renumbers itself when an edge moves would repaint the wrong outline.
    expect(networkParts(net).map((p) => p.vertices[0])).toEqual([1, 11])
  })

  it('locates a vertex and groups a selection', () => {
    const parts = networkParts(twoParts())
    expect(partOfVertex(parts, 12)).toBe(1)
    expect(partOfVertex(parts, 777)).toBe(-1)
    expect(groupByPart(parts, [11, 2, 13, 4])).toEqual([
      { part: 0, vids: [2, 4] },
      { part: 1, vids: [11, 13] },
    ])
  })
})

describe('join', () => {
  it('runs a segment between two anchors', () => {
    const net = twoParts()
    expect(joinVertices(net, [3, 11])).toBeNull()
    expect(net.edges.some((e) => e.v0 === 3 && e.v1 === 11)).toBe(true)
    // The two loops are now one part, which is exactly what joining them means.
    expect(networkParts(net)).toHaveLength(1)
  })

  it('declines anything that is not two distinct, connectable points', () => {
    expect(joinVertices(twoParts(), [1])).toMatch(/two points/)
    expect(joinVertices(twoParts(), [1, 2, 3])).toMatch(/two points/)
    expect(joinVertices(twoParts(), [1, 1])).toMatch(/two different/)
    expect(joinVertices(twoParts(), [1, 404])).toMatch(/no longer in the path/)
    // 1-2 is already an edge of the left square. Adding a second one would be a
    // duplicate nothing can see and nothing can select.
    expect(joinVertices(twoParts(), [1, 2])).toMatch(/already connected/)
  })
})

describe('welding loose ends', () => {
  /** A lens outline in two halves, ends stacked exactly — an imported path. */
  function twoHalves(): VectorNetwork {
    return {
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 50, y: 40 },
        { id: 3, x: 100, y: 0 },
        // The same two corners again, as far as the eye is concerned.
        { id: 11, x: 0, y: 0 },
        { id: 12, x: 50, y: -40 },
        { id: 13, x: 100, y: 0 },
      ],
      edges: [
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
        { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
        { id: 11, v0: 11, v1: 12, cp0: null, cp1: null },
        { id: 12, v0: 12, v1: 13, cp0: null, cp1: null },
      ],
    }
  }

  it('closes a path whose ends are stacked on top of each other', () => {
    const net = twoHalves()
    // Two open chains, so nothing encloses anything and a fill has nowhere to go.
    expect(networkParts(net).some((p) => p.closed)).toBe(false)
    expect(weldLooseEnds(net, 0.5)).toBe(2)
    const parts = networkParts(net)
    expect(parts).toHaveLength(1)
    expect(parts[0].closed).toBe(true)
    expect(net.vertices).toHaveLength(4)
  })

  it('leaves ends that are genuinely apart alone', () => {
    const net = twoHalves()
    net.vertices[3].x = 20 // one end pulled well clear
    const before = structuredClone(net)
    // One pair still coincides, so one weld — and the other gap survives,
    // because closing a visible gap is a move the user should make.
    expect(weldLooseEnds(net, 0.5)).toBe(1)
    expect(net.vertices).toHaveLength(5)
    expect(before.vertices).toHaveLength(6)
  })

  it('does not weld the two ends of one segment into a loop of nothing', () => {
    const net: VectorNetwork = {
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 0, y: 0 },
      ],
      edges: [{ id: 1, v0: 1, v1: 2, cp0: null, cp1: null }],
    }
    // Both ends of a zero-length segment. Merging them leaves a self-loop
    // enclosing nothing, which is not a shape — it is a way to lose a line.
    expect(weldLooseEnds(net, 0.5)).toBe(0)
    expect(net.vertices).toHaveLength(2)
  })

  it('leaves a point in the middle of a path where it is', () => {
    const net = twoHalves()
    // Move a MIDDLE anchor onto another one. It is not an end, so it is not a
    // join anybody asked for — welding it would reshape the path, not close it.
    net.vertices[1] = { id: 2, x: 50, y: -40 }
    weldLooseEnds(net, 0.5)
    expect(net.vertices.some((v) => v.id === 2)).toBe(true)
    expect(net.vertices.some((v) => v.id === 12)).toBe(true)
  })

  it('closes a lens made of two curves that share both ends', () => {
    // The shape this command exists for, and the one the fixture above misses:
    // no middle anchors at all, so after welding BOTH curves run between the
    // same pair of ids. Treating that as a duplicate deleted one of them and
    // left an open chain — turning "the fill will not apply" into "half the
    // shape is gone". They are only duplicates if they also bow the same way.
    const net: VectorNetwork = {
      vertices: [
        { id: 1, x: 0, y: 80 },
        { id: 2, x: 300, y: 80 },
        { id: 11, x: 0, y: 80 },
        { id: 12, x: 300, y: 80 },
      ],
      edges: [
        { id: 1, v0: 1, v1: 2, cp0: { x: 90, y: 0 }, cp1: { x: 210, y: 0 } },
        { id: 11, v0: 11, v1: 12, cp0: { x: 90, y: 160 }, cp1: { x: 210, y: 160 } },
      ],
    }
    expect(weldLooseEnds(net, 0.5)).toBe(2)
    expect(net.vertices).toHaveLength(2)
    expect(net.edges).toHaveLength(2)
    const parts = networkParts(net)
    expect(parts).toHaveLength(1)
    expect(parts[0].closed).toBe(true)
  })

  it('still drops a segment that really is the same one twice', () => {
    const net: VectorNetwork = {
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 100, y: 0 },
        { id: 11, x: 0, y: 0 },
        { id: 12, x: 100, y: 0 },
      ],
      edges: [
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
        { id: 11, v0: 11, v1: 12, cp0: null, cp1: null },
      ],
    }
    // Same ends, same (absent) curvature: one line drawn on top of another.
    weldLooseEnds(net, 0.5)
    expect(net.edges).toHaveLength(1)
  })

  it('reports nothing to do when the path is already closed', () => {
    expect(weldLooseEnds(loop(1, 0, 0, 10), 0.5)).toBe(0)
  })
})

describe('bridge', () => {
  it('pairs anchors across two parts, shortest total first', () => {
    const net = twoParts()
    // Right side of the left square (2 = top, 4 = bottom by construction) to the
    // left side of the right square. The wrong pairing crosses; the shortest
    // one does not.
    expect(bridgeVertices(net, [2, 4, 12, 14])).toBeNull()
    const added = net.edges.filter((e) => e.id > 14)
    expect(added).toHaveLength(2)
    const pairs = added.map((e) => [e.v0, e.v1].sort((a, b) => a - b).join('-')).sort()
    expect(pairs).toEqual(['2-12', '4-14'])
    expect(networkParts(net)).toHaveLength(1)
  })

  it('picks the non-crossing pairing whichever order the points were selected in', () => {
    const a = bridgeVertices(twoParts(), [2, 4, 12, 14])
    const b = bridgeVertices(twoParts(), [4, 2, 14, 12])
    expect(a).toBeNull()
    expect(b).toBeNull()
    const netA = twoParts()
    const netB = twoParts()
    bridgeVertices(netA, [2, 4, 12, 14])
    bridgeVertices(netB, [4, 2, 14, 12])
    const key = (n: VectorNetwork) =>
      n.edges
        .filter((e) => e.id > 14)
        .map((e) => [e.v0, e.v1].sort((x, y) => x - y).join('-'))
        .sort()
        .join(',')
    // Selection order is not a statement about pairing; it is just the order you
    // happened to click. Two clicks that mean the same bridge must build it.
    expect(key(netA)).toBe(key(netB))
  })

  it('bridges one pair as happily as two', () => {
    const net = twoParts()
    expect(bridgeVertices(net, [2, 12])).toBeNull()
    expect(net.edges.filter((e) => e.id > 14)).toHaveLength(1)
  })

  it('declines when the points do not describe two sides', () => {
    // All in one part: that is a Join, and saying so is more use than a shrug.
    // Opposite corners, not neighbours — 1 and 2 are already an edge, which is
    // a different refusal and would hide this one.
    expect(bridgeVertices(twoParts(), [1, 3])).toMatch(/same part/)
    expect(bridgeVertices(twoParts(), [1])).toMatch(/two separate parts/)
    // Lopsided: with two here and one there, "which one is left over" has no
    // answer worth guessing at.
    expect(bridgeVertices(twoParts(), [1, 2, 11])).toMatch(/same number of points/)
  })

  it('declines a bridge that is already there, without blaming the merge it made', () => {
    const net = twoParts()
    bridgeVertices(net, [2, 12])
    // The bridge merged the two parts, so asking again finds both anchors in
    // ONE part. Reporting that ("use Join instead") is true and useless; what
    // actually happened is that this bridge already exists.
    expect(bridgeVertices(net, [2, 12])).toMatch(/already connected/)
  })
})
