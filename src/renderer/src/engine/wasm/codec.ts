// Boundary codecs for the WASM engine core. Formats are defined (and
// mirrored) in crates/polyform-core/src/wasm.rs:
//
//   SubPath blob:  [closed(0|1), anchorCount,
//                   (px, py, cpInX, cpInY, cpOutX, cpOutY) * anchorCount]*
//   Network:       vertices [id, x, y]*, edges [v0, v1, cp0x, cp0y, cp1x, cp1y]*
//   Rings blob:    [ringCount, (len, (x, y) * len)*]
//
// NaN,NaN encodes a null control point — real control points are always
// finite (scene documents never carry NaN coordinates).

import type { SubPath } from '../shapes'
import type { Vec2, VectorNetwork } from '../types'

export function encodeSubPaths(paths: SubPath[]): Float64Array {
  let len = 0
  for (const sp of paths) len += 2 + sp.anchors.length * 6
  const out = new Float64Array(len)
  let i = 0
  for (const sp of paths) {
    out[i++] = sp.closed ? 1 : 0
    out[i++] = sp.anchors.length
    for (const a of sp.anchors) {
      out[i++] = a.p.x
      out[i++] = a.p.y
      out[i++] = a.cpIn ? a.cpIn.x : NaN
      out[i++] = a.cpIn ? a.cpIn.y : NaN
      out[i++] = a.cpOut ? a.cpOut.x : NaN
      out[i++] = a.cpOut ? a.cpOut.y : NaN
    }
  }
  return out
}

function cp(x: number, y: number): Vec2 | null {
  return Number.isNaN(x) && Number.isNaN(y) ? null : { x, y }
}

export function decodeSubPaths(buf: Float64Array): SubPath[] {
  const paths: SubPath[] = []
  let i = 0
  while (i + 2 <= buf.length) {
    const closed = buf[i] !== 0
    const n = buf[i + 1]
    i += 2
    const anchors: SubPath['anchors'] = []
    for (let k = 0; k < n && i + 6 <= buf.length; k++) {
      anchors.push({
        p: { x: buf[i], y: buf[i + 1] },
        cpIn: cp(buf[i + 2], buf[i + 3]),
        cpOut: cp(buf[i + 4], buf[i + 5]),
      })
      i += 6
    }
    paths.push({ closed, anchors })
  }
  return paths
}

export function encodeNetwork(network: VectorNetwork): {
  vertices: Float64Array
  edges: Float64Array
} {
  const vertices = new Float64Array(network.vertices.length * 3)
  network.vertices.forEach((v, i) => {
    vertices[i * 3] = v.id
    vertices[i * 3 + 1] = v.x
    vertices[i * 3 + 2] = v.y
  })
  const edges = new Float64Array(network.edges.length * 6)
  network.edges.forEach((e, i) => {
    edges[i * 6] = e.v0
    edges[i * 6 + 1] = e.v1
    edges[i * 6 + 2] = e.cp0 ? e.cp0.x : NaN
    edges[i * 6 + 3] = e.cp0 ? e.cp0.y : NaN
    edges[i * 6 + 4] = e.cp1 ? e.cp1.x : NaN
    edges[i * 6 + 5] = e.cp1 ? e.cp1.y : NaN
  })
  return { vertices, edges }
}

export function decodeRings(buf: Float64Array): Vec2[][] {
  const rings: Vec2[][] = []
  if (buf.length === 0) return rings
  const count = buf[0]
  let i = 1
  for (let r = 0; r < count && i < buf.length; r++) {
    const len = buf[i++]
    const ring: Vec2[] = []
    for (let k = 0; k < len && i + 2 <= buf.length; k++) {
      ring.push({ x: buf[i], y: buf[i + 1] })
      i += 2
    }
    rings.push(ring)
  }
  return rings
}
