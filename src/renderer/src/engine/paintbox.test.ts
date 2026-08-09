// A line has no height. These are the two things that fall out of that.

import { describe, expect, it } from 'vitest'
import { createNode } from './types'
import {
  fillPaintBox,
  gradientAngle,
  openStrokeOffset,
  paintPoint,
  strokeAlignApplies,
  strokePaintBox,
  withGradientAngle,
} from './paintbox'
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

  it('on a line, because the band can sit to one side of it', () => {
    // Briefly false, which was wrong: pushing a line's stroke to one side is an
    // ordinary thing to want, and `openStrokeOffset` makes it exact for a segment.
    expect(strokeAlignApplies(line())).toBe(true)
  })

  it('offsets the band, and the paint box follows it', () => {
    const inside = line()
    inside.strokeAlign = 'INSIDE'
    expect(openStrokeOffset(inside)).toBe(-32.5)
    // The band now occupies y ∈ [-65, 0]; the gradient has to cover exactly that.
    expect(strokePaintBox(inside)).toEqual({ x: 0, y: -65, w: 564, h: 65 })

    const outside = line()
    outside.strokeAlign = 'OUTSIDE'
    expect(openStrokeOffset(outside)).toBe(32.5)
    expect(strokePaintBox(outside)).toEqual({ x: 0, y: 0, w: 564, h: 65 })

    const centre = line()
    expect(openStrokeOffset(centre)).toBe(0)
  })

  it('does not offset a closed shape — clipping does that job', () => {
    const r = createNode('RECTANGLE', 'Card')
    r.strokeAlign = 'OUTSIDE'
    r.strokeWeight = 10
    expect(openStrokeOffset(r)).toBe(0)
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

describe('gradient direction', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 }
  const g = (start: { x: number; y: number }, end: { x: number; y: number }) => ({ start, end })

  it('reads the angle you can see, not the one in unit space', () => {
    // Corner to corner on a 200×100 box is 26.57° on screen, not 45°.
    expect(gradientAngle(g({ x: 0, y: 0 }, { x: 1, y: 1 }), box)).toBeCloseTo(26.565, 3)
    expect(gradientAngle(g({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }), box)).toBe(0)
    expect(gradientAngle(g({ x: 0.5, y: 0 }, { x: 0.5, y: 1 }), box)).toBe(90)
  })

  it('round-trips every quarter turn', () => {
    for (const deg of [0, 90, 180, -90, 45, -135]) {
      const turned = withGradientAngle(g({ x: 0, y: 0 }, { x: 1, y: 1 }), box, deg)
      expect(gradientAngle(turned, box)).toBeCloseTo(deg, 6)
    }
  })

  it('keeps the centre and spans the box, CSS-style', () => {
    const turned = withGradientAngle(g({ x: 0, y: 0 }, { x: 1, y: 1 }), box, 90)
    // Vertical on a 100-tall box: exactly top edge to bottom edge, centred.
    expect(turned.start).toEqual({ x: 0.5, y: 0 })
    expect(turned.end).toEqual({ x: 0.5, y: 1 })
    const diagonal = withGradientAngle(g({ x: 0, y: 0 }, { x: 1, y: 1 }), box, 45)
    const mid = { x: (diagonal.start.x + diagonal.end.x) / 2, y: (diagonal.start.y + diagonal.end.y) / 2 }
    expect(mid.x).toBeCloseTo(0.5, 6)
    expect(mid.y).toBeCloseTo(0.5, 6)
  })

  it('turns a stroke gradient inside the band it is painted in', () => {
    const l = line()
    const bandBox = strokePaintBox(l)
    const across = withGradientAngle(g({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }), bandBox, 90)
    // 90° across a 65-unit band: the two ends are 65 apart, which is what made the
    // difference between a visible gradient and nothing at all (F-30).
    const a = paintPoint(bandBox, across.start)
    const b = paintPoint(bandBox, across.end)
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(65, 6)
  })
})
