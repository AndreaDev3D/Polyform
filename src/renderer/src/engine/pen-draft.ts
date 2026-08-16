// What the pen is drawing, as geometry.
//
// The preview on screen and the node that gets committed are the same curve,
// and they are built here so they cannot be built differently. That is not
// theoretical tidiness: the preview is what somebody aims with, so a preview
// drawn by its own code is a preview that can lie about where the shape will
// land, and the lie only shows up after the mouse is up.

import type { Vec2, VectorNetwork } from './types'

/**
 * One point of a pen run.
 *
 * `handleOut` is the forward arm, in world space, or null for a corner. There
 * is no second field for the backward arm: dragging the pen makes a SMOOTH
 * point, and a smooth point's arms are reflections of each other — storing both
 * would let them drift apart with nothing to notice it.
 */
export interface PenPoint {
  p: Vec2
  handleOut: Vec2 | null
}

/** The arm pointing back from a point, being its forward arm reflected. */
export function handleIn(point: PenPoint): Vec2 | null {
  if (!point.handleOut) return null
  return { x: 2 * point.p.x - point.handleOut.x, y: 2 * point.p.y - point.handleOut.y }
}

/** The two cubic controls for the segment a → b; both null is a straight line. */
export function penSegmentControls(a: PenPoint, b: PenPoint): { c0: Vec2 | null; c1: Vec2 | null } {
  return { c0: a.handleOut ? { ...a.handleOut } : null, c1: handleIn(b) }
}

/**
 * The finished run, in node-local coordinates with the origin at its own top
 * left, plus where that origin sits in the world.
 *
 * A dragged point is recorded as ANGLE_LENGTH so it stays smooth when it is
 * edited later — the curvature alone would not say so, and the first handle
 * drag in vector edit would break the point without being asked to.
 */
export function penNetwork(
  points: readonly PenPoint[],
  close: boolean,
): { network: VectorNetwork; x: number; y: number; width: number; height: number } | null {
  if (points.length < 2) return null
  // Handles count toward the box: a curve bulges past its anchors, and a node
  // sized to the anchors alone would have its own outline hanging outside it.
  const xs: number[] = []
  const ys: number[] = []
  for (const pt of points) {
    xs.push(pt.p.x)
    ys.push(pt.p.y)
    for (const h of [pt.handleOut, handleIn(pt)]) {
      if (h) {
        xs.push(h.x)
        ys.push(h.y)
      }
    }
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const local = (v: Vec2): Vec2 => ({ x: v.x - minX, y: v.y - minY })

  const network: VectorNetwork = { vertices: [], edges: [] }
  points.forEach((pt, i) => {
    const vertex = { id: i, ...local(pt.p) }
    network.vertices.push(pt.handleOut ? { ...vertex, mirror: 'ANGLE_LENGTH' as const } : vertex)
  })
  const segments = close ? points.length : points.length - 1
  for (let i = 0; i < segments; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const { c0, c1 } = penSegmentControls(a, b)
    network.edges.push({
      id: i,
      v0: i,
      v1: (i + 1) % points.length,
      cp0: c0 ? local(c0) : null,
      cp1: c1 ? local(c1) : null,
    })
  }
  return {
    network,
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...xs) - minX),
    height: Math.max(1, Math.max(...ys) - minY),
  }
}
