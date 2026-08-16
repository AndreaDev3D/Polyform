import { describe, expect, it } from 'vitest'
import type { VectorNetwork } from './types'
import {
  applyMirror,
  bendEdge,
  bezierAt,
  marqueeVertices,
  partnerHandle,
  removeEdge,
  removeVertex,
  setVertexMirror,
  MIRROR_CYCLE,
  applyMirrorChoice,
  makeVertexSharp,
  nextMirrorChoice,
  vertexIsSharp,
  vertexMirrorChoice,
  type MirrorChoice,
} from './vector-edit'

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

describe('rubber-band anchor selection', () => {
  const pts = [
    { id: 1, x: 10, y: 10 },
    { id: 2, x: 50, y: 50 },
    // Two anchors in the SAME place — an outline that arrived in pieces. This
    // is the pair that clicking cannot separate, and the whole reason a box
    // selection exists in here.
    { id: 3, x: 90, y: 90 },
    { id: 4, x: 90, y: 90 },
  ]

  it('catches two anchors stacked on top of each other', () => {
    expect(marqueeVertices(pts, { minX: 80, minY: 80, maxX: 100, maxY: 100 }, [], false)).toEqual([3, 4])
  })

  it('replaces the selection unless you asked to add', () => {
    expect(marqueeVertices(pts, { minX: 0, minY: 0, maxX: 20, maxY: 20 }, [2], false)).toEqual([1])
    expect(marqueeVertices(pts, { minX: 0, minY: 0, maxX: 20, maxY: 20 }, [2], true)).toEqual([2, 1])
  })

  it('adds without toggling', () => {
    // A box is dragged, not clicked: crossing the same anchor twice during one
    // gesture is ordinary, and a toggle would quietly drop it again.
    expect(marqueeVertices(pts, { minX: 0, minY: 0, maxX: 20, maxY: 20 }, [1], true)).toEqual([1])
  })

  it('takes anchors exactly on the edge of the box', () => {
    // Drawn to the pixel, an anchor on the boundary is one you meant.
    expect(marqueeVertices(pts, { minX: 10, minY: 10, maxX: 50, maxY: 50 }, [], false)).toEqual([1, 2])
  })

  it('selects nothing from an empty box, which is how you clear', () => {
    expect(marqueeVertices(pts, { minX: 200, minY: 200, maxX: 210, maxY: 210 }, [1, 2], false)).toEqual([])
  })
})

describe('sharp, and the choice the control offers', () => {
  /** A three-point open path with a curve into the middle vertex. */
  function curved(): VectorNetwork {
    return {
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 10, y: 10 },
        { id: 3, x: 20, y: 0 },
      ],
      edges: [
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: { x: 4, y: 10 } },
        { id: 2, v0: 2, v1: 3, cp0: { x: 16, y: 10 }, cp1: null },
      ],
    }
  }

  it('calls a point with no handles sharp, whatever the stored mode says', () => {
    const net = curved()
    setVertexMirror(net, 2, 'ANGLE_LENGTH')
    expect(vertexMirrorChoice(net, 2)).toBe('ANGLE_LENGTH')
    makeVertexSharp(net, 2)
    // The geometry is the answer. A vertex still claiming ANGLE_LENGTH while
    // carrying nothing to mirror would make the control describe a shape that
    // is not on screen.
    expect(vertexMirrorChoice(net, 2)).toBe('SHARP')
    expect(vertexIsSharp(net, 2)).toBe(true)
  })

  it('takes the stored mode off with the handles', () => {
    const net = curved()
    setVertexMirror(net, 2, 'ANGLE')
    makeVertexSharp(net, 2)
    // Left behind, it is invisible until the next handle appears — at which
    // point the corner springs smooth for no reason anyone can see.
    expect(net.vertices.find((v) => v.id === 2)?.mirror).toBeUndefined()
    expect(net.edges[0].cp1).toBeNull()
    expect(net.edges[1].cp0).toBeNull()
  })

  it('leaves the other points alone', () => {
    const net = curved()
    makeVertexSharp(net, 2)
    expect(net.vertices).toHaveLength(3)
    expect(net.edges).toHaveLength(2)
  })

  it('cycles through every choice and comes back', () => {
    const seen: MirrorChoice[] = []
    let choice = nextMirrorChoice(null)
    for (let i = 0; i < MIRROR_CYCLE.length; i++) {
      seen.push(choice)
      choice = nextMirrorChoice(choice)
    }
    expect(new Set(seen).size).toBe(MIRROR_CYCLE.length)
    // Back where it started, or the button walks off the end of its own list.
    expect(choice).toBe(seen[0])
  })

  it('starts the cycle from the top when the points disagree', () => {
    expect(nextMirrorChoice(null)).toBe(MIRROR_CYCLE[0])
  })

  it('applies sharp as a command and the rest as modes', () => {
    const net = curved()
    applyMirrorChoice(net, 2, 'ANGLE_LENGTH')
    expect(vertexMirrorChoice(net, 2)).toBe('ANGLE_LENGTH')
    applyMirrorChoice(net, 2, 'SHARP')
    expect(vertexMirrorChoice(net, 2)).toBe('SHARP')
    // …and back out of sharp: choosing a mirror mode on a corner has to give it
    // arms, or the setting reads back and does nothing.
    applyMirrorChoice(net, 2, 'ANGLE_LENGTH')
    expect(vertexIsSharp(net, 2)).toBe(false)
  })
})

describe('the cycle moves every time', () => {
  /** A plain corner: three points, no handles anywhere. */
  function corner(): VectorNetwork {
    return {
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 10, y: 10 },
        { id: 3, x: 20, y: 0 },
      ],
      edges: [
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
        { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
      ],
    }
  }

  it('gives a corner arms whichever mirroring is chosen, NONE included', () => {
    // Sharp and no-mirroring are the same picture on a point with no handles,
    // so a NONE that only set a field left the Bend cycle looking stuck: two of
    // its four steps drew the same thing.
    for (const mode of ['NONE', 'ANGLE', 'ANGLE_LENGTH'] as const) {
      const net = corner()
      setVertexMirror(net, 2, mode)
      expect(vertexIsSharp(net, 2), `${mode} left the corner with no handles`).toBe(false)
      expect(vertexMirrorChoice(net, 2)).toBe(mode)
    }
  })

  it('lands somewhere new on every step, all the way round', () => {
    // The property that matters for a cycling button: press it four times from
    // a corner and see four different things, ending back where it began.
    const net = corner()
    const seen: MirrorChoice[] = []
    for (let i = 0; i < MIRROR_CYCLE.length; i++) {
      const next = nextMirrorChoice(vertexMirrorChoice(net, 2))
      applyMirrorChoice(net, 2, next)
      seen.push(vertexMirrorChoice(net, 2))
    }
    expect(seen).toEqual(MIRROR_CYCLE.slice(1).concat(MIRROR_CYCLE[0]))
  })
})
