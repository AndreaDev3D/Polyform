// Flatten geometry: primitives become editable anchors, contours keep their
// curves, and overlapping contours union instead of cancelling.

import { describe, expect, it } from 'vitest'
import { createNode } from './types'
import { nodeOutline, flattenSubPath } from './shapes'
import {
  anchorNetworkAtOrigin,
  networkBounds,
  normalizeWinding,
  reverseSubPath,
  ringsToSubPaths,
  signedArea,
  subPathsToNetwork,
  transformSubPath,
} from './flatten'
import type { SubPath } from './shapes'

function ellipse(w = 200, h = 120): SubPath[] {
  const node = createNode('ELLIPSE', 'e')
  node.width = w
  node.height = h
  return nodeOutline(node)
}

describe('subPathsToNetwork', () => {
  it('gives an ellipse four anchors, each with both handles', () => {
    const net = subPathsToNetwork(ellipse())
    expect(net.vertices).toHaveLength(4)
    expect(net.edges).toHaveLength(4) // closed: four segments
    // Every segment is a curve — that is the point of flattening a primitive:
    // you get the bezier handles, not a polygon.
    for (const e of net.edges) {
      expect(e.cp0).not.toBeNull()
      expect(e.cp1).not.toBeNull()
    }
    // The ring closes back on itself.
    expect(net.edges[3].v1).toBe(net.edges[0].v0)
  })

  it('keeps a rounded rectangle’s eight anchors and only curves the corners', () => {
    const rect = createNode('RECTANGLE', 'r')
    rect.width = 100
    rect.height = 60
    if (rect.type === 'RECTANGLE') rect.cornerRadius = { tl: 10, tr: 10, br: 10, bl: 10 }
    const net = subPathsToNetwork(nodeOutline(rect))
    expect(net.vertices).toHaveLength(8)
    const curved = net.edges.filter((e) => e.cp0 || e.cp1)
    expect(curved).toHaveLength(4) // the four corner arcs
  })

  it('numbers vertices per subpath without collisions', () => {
    const net = subPathsToNetwork([...ellipse(), ...ellipse(50, 50)])
    expect(net.vertices).toHaveLength(8)
    expect(new Set(net.vertices.map((v) => v.id)).size).toBe(8)
    // Edges of the second contour must reference the second contour's vertices.
    expect(net.edges.slice(4).every((e) => e.v0 >= 4 && e.v1 >= 4)).toBe(true)
  })

  it('leaves an open subpath open (one fewer segment than anchors)', () => {
    const open: SubPath = {
      closed: false,
      anchors: [
        { p: { x: 0, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 10, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 20, y: 10 }, cpIn: null, cpOut: null },
      ],
    }
    const net = subPathsToNetwork([open])
    expect(net.vertices).toHaveLength(3)
    expect(net.edges).toHaveLength(2)
  })
})

describe('reverseSubPath', () => {
  it('traces the same curve backwards', () => {
    const [sp] = ellipse()
    const back = reverseSubPath(sp)
    expect(signedArea(back.anchors.map((a) => a.p))).toBeCloseTo(-signedArea(sp.anchors.map((a) => a.p)), 6)
    // Same shape: the flattened point sets match as sets, so no handle was
    // dropped or attached to the wrong end (which would deform the curve).
    const forward = flattenSubPath(sp, 0.05)
    const reversed = flattenSubPath(back, 0.05)
    expect(reversed).toHaveLength(forward.length)
    const key = (p: { x: number; y: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`
    expect(new Set(reversed.map(key))).toEqual(new Set(forward.map(key)))
  })

  it('round-trips', () => {
    const [sp] = ellipse()
    const twice = reverseSubPath(reverseSubPath(sp))
    expect(twice.anchors.map((a) => a.p)).toEqual(sp.anchors.map((a) => a.p))
  })
})

describe('normalizeWinding', () => {
  it('makes every closed contour turn the same way', () => {
    const [a] = ellipse()
    const b = reverseSubPath(ellipse(80, 80)[0])
    expect(signedArea(a.anchors.map((x) => x.p)) > 0).not.toBe(
      signedArea(b.anchors.map((x) => x.p)) > 0,
    )
    const [na, nb] = normalizeWinding([a, b])
    const sa = signedArea(na.anchors.map((x) => x.p))
    const sb = signedArea(nb.anchors.map((x) => x.p))
    expect(Math.sign(sa)).toBe(Math.sign(sb))
  })

  it('does not touch open contours', () => {
    const open: SubPath = {
      closed: false,
      anchors: [
        { p: { x: 10, y: 0 }, cpIn: null, cpOut: null },
        { p: { x: 0, y: 0 }, cpIn: null, cpOut: null },
      ],
    }
    expect(normalizeWinding([open])[0].anchors.map((a) => a.p)).toEqual(open.anchors.map((a) => a.p))
  })
})

describe('placement', () => {
  it('measures bounds over handles too, not just anchors', () => {
    // A primitive's handles land on its box, so it cannot show this. A hand
    // pulled curve can put a control point well outside the anchor hull, and
    // the node's box has to contain it — the vector editor draws and drags
    // those points, and exitVectorEdit normalises the same way.
    const bulge: SubPath = {
      closed: false,
      anchors: [
        { p: { x: 0, y: 0 }, cpIn: null, cpOut: { x: 50, y: -80 } },
        { p: { x: 100, y: 0 }, cpIn: { x: 150, y: -80 }, cpOut: null },
      ],
    }
    const b = networkBounds(subPathsToNetwork([bulge]))
    expect(b.minY).toBeCloseTo(-80, 6)
    expect(b.maxX).toBeCloseTo(150, 6)
    // Anchors alone would have said 0..100 by 0..0.
    expect(b.maxX - b.minX).toBeGreaterThan(100)
  })

  it('re-anchors at the origin and reports the offset it removed', () => {
    const moved = transformSubPath(ellipse(100, 100)[0], { a: 1, b: 0, c: 0, d: 1, e: 40, f: 25 })
    const net = subPathsToNetwork([moved])
    const before = networkBounds(net)
    const { network, dx, dy } = anchorNetworkAtOrigin(net)
    expect(dx).toBeCloseTo(before.minX, 6)
    expect(dy).toBeCloseTo(before.minY, 6)
    const after = networkBounds(network)
    expect(after.minX).toBeCloseTo(0, 6)
    expect(after.minY).toBeCloseTo(0, 6)
    expect(after.maxX - after.minX).toBeCloseTo(before.maxX - before.minX, 6)
  })

  it('carries a transform onto handles, not only anchors', () => {
    const [sp] = ellipse(100, 100)
    const scaled = transformSubPath(sp, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 })
    const src = sp.anchors[0]
    const dst = scaled.anchors[0]
    expect(dst.p.x).toBeCloseTo(src.p.x * 2, 6)
    expect(dst.cpOut!.x).toBeCloseTo(src.cpOut!.x * 2, 6)
  })
})

describe('ringsToSubPaths', () => {
  it('turns boolean rings into closed straight-edged contours', () => {
    const paths = ringsToSubPaths([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ x: 0, y: 0 }, { x: 1, y: 1 }], // degenerate: dropped
    ])
    expect(paths).toHaveLength(1)
    expect(paths[0].closed).toBe(true)
    expect(paths[0].anchors.every((a) => a.cpIn === null && a.cpOut === null)).toBe(true)
  })
})
