// A line has no height. These are the two things that fall out of that.

import { describe, expect, it } from 'vitest'
import { createNode } from './types'
import { fillPaintBox, paintPoint, strokeAlignApplies, strokePaintBox } from './paintbox'
import type { SceneNode, VectorNetwork } from './types'

/** A 564×0 line with a fat stroke: the shape from the bug report. */
function line(weight = 65): SceneNode {
  const n = createNode('LINE', 'Line 1')
  n.width = 564
  n.height = 0
  n.strokeWeight = weight
  return n
}

describe('paint boxes', () => {
  it('gives a line the box its stroke covers, not its zero-height box', () => {
    expect(strokePaintBox(line())).toEqual({ x: 0, y: -32.5, w: 564, h: 65 })
  })

  it('maps a VERTICAL gradient across a line to two different points', () => {
    // The regression itself. `start` and `end` of the default vertical gradient are
    // (0.5, 0) and (0.5, 1); through the node's own box they both land on y = 0, and
    // a zero-length gradient paints nothing at all.
    const box = strokePaintBox(line())
    const start = paintPoint(box, { x: 0.5, y: 0 })
    const end = paintPoint(box, { x: 0.5, y: 1 })
    expect(start).toEqual({ x: 282, y: -32.5 })
    expect(end).toEqual({ x: 282, y: 32.5 })
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeCloseTo(65, 6)

    // And the old behaviour, for contrast: the same two points through the node box.
    const naive = fillPaintBox(line())
    expect(paintPoint(naive, { x: 0.5, y: 0 })).toEqual(paintPoint(naive, { x: 0.5, y: 1 }))
  })

  it('leaves a gradient along the line alone', () => {
    const box = strokePaintBox(line())
    expect(paintPoint(box, { x: 0, y: 0.5 })).toEqual({ x: 0, y: 0 })
    expect(paintPoint(box, { x: 1, y: 0.5 })).toEqual({ x: 564, y: 0 })
  })

  it('substitutes only the axis that has no extent', () => {
    const n = createNode('RECTANGLE', 'Card')
    n.width = 200
    n.height = 100
    n.strokeWeight = 8
    expect(strokePaintBox(n)).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    // A vertical line: zero WIDTH, so the horizontal axis is the one to grow.
    const v = createNode('LINE', 'Vertical')
    v.width = 0
    v.height = 300
    v.strokeWeight = 10
    expect(strokePaintBox(v)).toEqual({ x: -5, y: 0, w: 10, h: 300 })
  })
})

describe('stroke alignment applies', () => {
  const withNetwork = (network: VectorNetwork): SceneNode => {
    const n = createNode('VECTOR', 'Path')
    if (n.type === 'VECTOR') n.network = network
    return n
  }

  it('never on a line — there is no inside', () => {
    expect(strokeAlignApplies(line())).toBe(false)
  })

  it('always on a rectangle', () => {
    expect(strokeAlignApplies(createNode('RECTANGLE', 'Card'))).toBe(true)
  })

  it('on a vector only when a contour closes', () => {
    // Open: two vertices, one edge.
    const open = withNetwork({
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 10, y: 0 },
      ],
      edges: [{ id: 1, v0: 1, v1: 2, cp0: null, cp1: null }],
    })
    expect(strokeAlignApplies(open)).toBe(false)

    // Closed: a triangle.
    const closed = withNetwork({
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 10, y: 0 },
        { id: 3, x: 5, y: 9 },
      ],
      edges: [
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
        { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
        { id: 3, v0: 3, v1: 1, cp0: null, cp1: null },
      ],
    })
    expect(strokeAlignApplies(closed)).toBe(true)
  })
})
