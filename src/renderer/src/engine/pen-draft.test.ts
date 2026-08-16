// What the pen draws, and what it commits.
//
// The preview and the finished node are the same curve because they are built
// from the same functions — so what is worth pinning is that those functions
// say what the drawing looks like, and that the node they produce actually
// contains the shape rather than being cropped to its anchors.

import { describe, expect, it } from 'vitest'
import { handleIn, penNetwork, penSegmentControls, type PenPoint } from './pen-draft'

const corner = (x: number, y: number): PenPoint => ({ p: { x, y }, handleOut: null })
const smooth = (x: number, y: number, hx: number, hy: number): PenPoint => ({
  p: { x, y },
  handleOut: { x: hx, y: hy },
})

describe('pen draft', () => {
  it('leaves a clicked point a corner', () => {
    const { c0, c1 } = penSegmentControls(corner(0, 0), corner(10, 0))
    expect(c0).toBeNull()
    expect(c1).toBeNull()
  })

  it('reflects a dragged point, so its two arms are one arm', () => {
    // Dragging makes a SMOOTH point, and the backward arm is the forward one
    // reflected — the reason only `handleOut` is stored. Two stored arms could
    // drift apart with nothing to catch it.
    const pt = smooth(10, 10, 16, 6)
    expect(handleIn(pt)).toEqual({ x: 4, y: 14 })
  })

  it('uses the dragged handle on both segments that meet the point', () => {
    const pts = [corner(0, 0), smooth(10, 10, 16, 6), corner(20, 0)]
    const before = penSegmentControls(pts[0], pts[1])
    const after = penSegmentControls(pts[1], pts[2])
    // Arriving, the curve comes in along the reflected arm…
    expect(before.c1).toEqual({ x: 4, y: 14 })
    // …and leaves along the arm itself. A point that curved on one side only
    // would have a kink exactly where the user dragged for smoothness.
    expect(after.c0).toEqual({ x: 16, y: 6 })
  })

  it('records a dragged point as mirrored, so editing it later keeps it smooth', () => {
    // The curvature alone does not say the point is smooth. Without the mode
    // stored, the first handle drag in vector edit breaks a point that was
    // drawn smooth, without being asked to.
    const built = penNetwork([corner(0, 0), smooth(10, 10, 16, 6), corner(20, 0)], false)
    expect(built?.network.vertices.map((v) => v.mirror)).toEqual([undefined, 'ANGLE_LENGTH', undefined])
  })

  it('sizes the node around the CURVE, not just the anchors', () => {
    // A curve bulges past the points it runs between. Measured from the anchors
    // alone, the node's own outline hangs outside its box — which is the bug
    // that cropped stroke caps out of every export (F-42), in a new place.
    const built = penNetwork([corner(0, 0), smooth(10, -40, 10, -60), corner(20, 0)], false)
    expect(built).not.toBeNull()
    expect(built!.y).toBeLessThanOrEqual(-60)
    expect(built!.height).toBeGreaterThanOrEqual(60)
    for (const e of built!.network.edges) {
      for (const cp of [e.cp0, e.cp1]) {
        if (!cp) continue
        expect(cp.x).toBeGreaterThanOrEqual(0)
        expect(cp.y).toBeGreaterThanOrEqual(0)
        expect(cp.x).toBeLessThanOrEqual(built!.width)
        expect(cp.y).toBeLessThanOrEqual(built!.height)
      }
    }
  })

  it('closes the ring when asked, and leaves it open when not', () => {
    const pts = [corner(0, 0), corner(10, 0), corner(10, 10)]
    expect(penNetwork(pts, false)?.network.edges).toHaveLength(2)
    const closed = penNetwork(pts, true)?.network.edges
    expect(closed).toHaveLength(3)
    // The closing segment runs from the last point back to the first, which is
    // what makes the run a ring rather than a chain with a stray edge.
    expect(closed?.[2]).toMatchObject({ v0: 2, v1: 0 })
  })

  it('will not build a run of fewer than two points', () => {
    expect(penNetwork([corner(0, 0)], false)).toBeNull()
    expect(penNetwork([], true)).toBeNull()
  })
})
