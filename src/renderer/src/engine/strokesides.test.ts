// Per-side stroke weights, as geometry.
//
// The region is what all three back ends draw, so it is the thing worth pinning
// down: get it wrong and the border is wrong on the canvas, in the GPU mesh and in
// the SVG export at once. Every case here is stated as the two boxes the ring
// lies between, because that pair fully determines it.

import { describe, expect, it } from 'vitest'
import { createNode, uniformSides, type RectangleNode, type SceneNode, type StrokeSides } from './types'
import { effectiveStrokeWeight, perSideStroke, strokeSideOutline, strokeSideOutset } from './strokesides'
import { flattenSubPath, type SubPath } from './shapes'

function bbox(sp: SubPath): [number, number, number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of flattenSubPath(sp, 0.05)) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return [minX, minY, maxX, maxY].map((v) => Math.round(v * 100) / 100) as [number, number, number, number]
}

function rect(sides?: Partial<StrokeSides>, over: Partial<SceneNode> = {}): RectangleNode {
  const node = createNode('RECTANGLE', 'r') as RectangleNode
  node.width = 100
  node.height = 50
  node.strokeWeight = 2
  node.strokeAlign = 'INSIDE'
  if (sides) node.strokeSides = { top: 0, right: 0, bottom: 0, left: 0, ...sides }
  Object.assign(node, over)
  return node
}

describe('per-side strokes', () => {
  it('stays out of the way of an ordinary uniform stroke', () => {
    // Nothing set at all, four equal sides that agree with the weight, and a node
    // type with no sides to speak of: all three keep the rasterizer's own band,
    // which is cheaper and better anti-aliased than a region we tessellate.
    expect(perSideStroke(rect())).toBeNull()
    expect(perSideStroke(rect(uniformSides(2)))).toBeNull()
    const ellipse = createNode('ELLIPSE', 'e')
    ;(ellipse as unknown as { strokeSides: StrokeSides }).strokeSides = { top: 4, right: 0, bottom: 0, left: 0 }
    expect(perSideStroke(ellipse)).toBeNull()
  })

  it('takes four equal sides that disagree with the weight', () => {
    // The sides are the more specific statement, so they win — otherwise setting
    // all four to the same number would silently do nothing.
    expect(perSideStroke(rect(uniformSides(6)))).toEqual(uniformSides(6))
  })

  it('draws one side as a band on that side, and nowhere else', () => {
    const region = strokeSideOutline(rect({ left: 10 }))
    expect(region).toHaveLength(2)
    // Outer is the shape; inner is the shape with the left edge pushed in by 10.
    // Filled even-odd, that pair IS the left band and only the left band.
    expect(bbox(region[0])).toEqual([0, 0, 100, 50])
    expect(bbox(region[1])).toEqual([10, 0, 100, 50])
  })

  it('mitres two adjacent sides into their shared corner', () => {
    const region = strokeSideOutline(rect({ top: 8, left: 10 }))
    expect(bbox(region[0])).toEqual([0, 0, 100, 50])
    // The inner box moves in on BOTH edges, which leaves an L whose corner is
    // filled — the mitre falls out of the geometry with no case for it.
    expect(bbox(region[1])).toEqual([10, 8, 100, 50])
  })

  it('puts the band where the alignment says', () => {
    // INSIDE eats into the shape, OUTSIDE grows past it, CENTER straddles.
    expect(bbox(strokeSideOutline(rect({ left: 10 }))[0])).toEqual([0, 0, 100, 50])
    const outside = strokeSideOutline(rect({ left: 10 }, { strokeAlign: 'OUTSIDE' }))
    expect(bbox(outside[0])).toEqual([-10, 0, 100, 50])
    expect(bbox(outside[1])).toEqual([0, 0, 100, 50])
    const centre = strokeSideOutline(rect({ left: 10 }, { strokeAlign: 'CENTER' }))
    expect(bbox(centre[0])).toEqual([-5, 0, 100, 50])
    expect(bbox(centre[1])).toEqual([5, 0, 100, 50])
  })

  it('covers the whole shape when an inside stroke is wider than the shape', () => {
    // 40 a side on a 50-tall box leaves no hole. One contour, filled solid —
    // which is what the rasterizer does with an over-wide inside stroke too.
    expect(strokeSideOutline(rect({ top: 40, bottom: 40 }))).toHaveLength(1)
  })

  it('draws nothing when every side is zero', () => {
    expect(strokeSideOutline(rect({ top: 0 }))).toEqual([])
  })

  it('reports a weight even when the uniform one is zero', () => {
    // Every "is there a stroke here at all?" gate reads this. Asking strokeWeight
    // instead skipped the node: the GPU built the mesh and then never drew it.
    const node = rect({ top: 4, left: 4 }, { strokeWeight: 0 })
    expect(effectiveStrokeWeight(node)).toBe(4)
    expect(effectiveStrokeWeight(rect())).toBe(2)
  })

  it('reports how far the stroke reaches outside, for bounds', () => {
    expect(strokeSideOutset(rect({ left: 10 }))).toBe(0)
    expect(strokeSideOutset(rect({ left: 10 }, { strokeAlign: 'CENTER' }))).toBe(5)
    expect(strokeSideOutset(rect({ left: 10, top: 3 }, { strokeAlign: 'OUTSIDE' }))).toBe(10)
  })

  it('carries the corner radius through both offsets', () => {
    const node = rect({ top: 6, right: 6, bottom: 6, left: 0 }, { strokeAlign: 'OUTSIDE' })
    node.cornerRadius = { tl: 10, tr: 10, br: 10, bl: 10 }
    const region = strokeSideOutline(node)
    // Outer grows by the SMALLER of a corner's two outward offsets: at the top
    // left, left has none, so that corner keeps radius 10 rather than bulging
    // out past an edge that has no stroke at all.
    expect(bbox(region[0])).toEqual([0, -6, 106, 56])
    // Inner is the shape itself for an outside stroke, radius unchanged.
    expect(bbox(region[1])).toEqual([0, 0, 100, 50])
  })
})
