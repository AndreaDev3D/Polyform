import { describe, expect, it } from 'vitest'
import type { VectorNetwork } from './types'
import { applyMirror, bendEdge, bezierAt, partnerHandle, removeEdge, removeVertex, setVertexMirror } from './vector-edit'

/** A square path: 4 vertices, 4 straight edges, closed. */
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

describe('handle mirroring', () => {
  it('finds the other handle at a shared vertex, and nothing at a path end', () => {
    const net = square()
    // Vertex 2 is shared by edge 0 (as v1) and edge 1 (as v0).
    expect(partnerHandle(net, 0, 'cp1')).toEqual({ edgeIndex: 1, key: 'cp0' })
    // Open the path: vertex 1 then belongs to edge 0 only.
    net.edges.pop()
    expect(partnerHandle(net, 0, 'cp0')).toBeNull()
  })

  it('does nothing on a corner point', () => {
    const net = square()
    net.edges[0].cp1 = { x: 60, y: -40 }
    applyMirror(net, 0, 'cp1')
    expect(net.edges[1].cp0).toBeNull()
  })

  it('ANGLE_LENGTH reflects the partner exactly through the vertex', () => {
    const net = square()
    net.vertices[1].mirror = 'ANGLE_LENGTH'
    net.edges[0].cp1 = { x: 60, y: -40 } // 40 left, 40 up from (100,0)
    applyMirror(net, 0, 'cp1')
    // Mirrored: as far the other side, same distance.
    expect(net.edges[1].cp0).toEqual({ x: 140, y: 40 })
  })

  it('ANGLE takes the direction but keeps the partner’s own length', () => {
    const net = square()
    net.vertices[1].mirror = 'ANGLE'
    net.edges[1].cp0 = { x: 100, y: 10 } // length 10 from the vertex
    net.edges[0].cp1 = { x: 60, y: 0 } // pointing straight left, length 40
    applyMirror(net, 0, 'cp1')
    // Opposite direction (straight right), still length 10.
    expect(net.edges[1].cp0!.x).toBeCloseTo(110)
    expect(net.edges[1].cp0!.y).toBeCloseTo(0)
  })

  it('choosing a mirror mode makes a smooth point out of a bare corner', () => {
    const net = square()
    setVertexMirror(net, 2, 'ANGLE_LENGTH')
    // Both arms now exist and are opposite each other through vertex 2.
    const a = net.edges[0].cp1!
    const b = net.edges[1].cp0!
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    const v = net.vertices[1]
    expect(a.x - v.x).toBeCloseTo(-(b.x - v.x))
    expect(a.y - v.y).toBeCloseTo(-(b.y - v.y))
  })
})

describe('bending a segment', () => {
  it('lands the curve on the target at the parameter dragged', () => {
    const net = square()
    bendEdge(net, 0, 0.5, { x: 50, y: -30 })
    const e = net.edges[0]
    const at = bezierAt({ x: 0, y: 0 }, e.cp0!, e.cp1!, { x: 100, y: 0 }, 0.5)
    expect(at.x).toBeCloseTo(50)
    expect(at.y).toBeCloseTo(-30)
  })

  it('works off-centre too, and leaves the endpoints alone', () => {
    const net = square()
    bendEdge(net, 1, 0.25, { x: 130, y: 25 })
    const e = net.edges[1]
    const at = bezierAt({ x: 100, y: 0 }, e.cp0!, e.cp1!, { x: 100, y: 100 }, 0.25)
    expect(at.x).toBeCloseTo(130)
    expect(at.y).toBeCloseTo(25)
    expect(net.vertices.find((v) => v.id === 2)).toEqual({ id: 2, x: 100, y: 0 })
    expect(net.vertices.find((v) => v.id === 3)).toEqual({ id: 3, x: 100, y: 100 })
  })

  it('bending carries the mirror through to the neighbouring segment', () => {
    const net = square()
    net.vertices[1].mirror = 'ANGLE_LENGTH'
    bendEdge(net, 0, 0.5, { x: 50, y: -30 })
    // Edge 0's cp1 pulled up, so edge 1's cp0 must have gone the other way.
    expect(net.edges[1].cp0).toBeTruthy()
    const v = net.vertices[1]
    expect(net.edges[0].cp1!.y - v.y).toBeCloseTo(-(net.edges[1].cp0!.y - v.y))
  })
})

describe('removing points and segments', () => {
  it('heals the path through a deleted point instead of opening it', () => {
    const net = square()
    removeVertex(net, 2)
    expect(net.vertices.map((v) => v.id)).toEqual([1, 3, 4])
    expect(net.edges).toHaveLength(3)
    // A straight run from 1 to 3 replaces the two that met at 2.
    const bridging = net.edges.find((e) => (e.v0 === 1 && e.v1 === 3) || (e.v0 === 3 && e.v1 === 1))
    expect(bridging).toBeTruthy()
    expect(bridging!.cp0).toBeNull()
    // Still closed: every vertex still has two edges.
    for (const v of net.vertices) {
      expect(net.edges.filter((e) => e.v0 === v.id || e.v1 === v.id)).toHaveLength(2)
    }
  })

  it('deleting a segment opens the path and takes no vertex with it', () => {
    const net = square()
    removeEdge(net, 0)
    expect(net.edges).toHaveLength(3)
    expect(net.vertices).toHaveLength(4)
  })

  it('deleting the last segment at a point takes the orphan with it', () => {
    const net: VectorNetwork = {
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 10, y: 0 },
      ],
      edges: [{ id: 1, v0: 1, v1: 2, cp0: null, cp1: null }],
    }
    removeEdge(net, 0)
    expect(net.vertices).toHaveLength(0)
  })
})
