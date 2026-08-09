// Converts scene nodes into a universal outline representation (anchor points
// with optional cubic handles). One source of truth consumed by:
//   - the Canvas2D renderer (Path2D building)
//   - hit-testing (flattened rings)
//   - boolean operations (flattened rings)
//   - SVG export (path data strings)

import type { CornerRadius, SceneNode, Vec2, VectorNetwork } from './types'
import { applyMat, flattenCubic, type Mat } from './geometry'
import { useWasm, wasmHandle } from './backend'
import { decodeRings, decodeSubPaths, encodeNetwork, encodeSubPaths } from './wasm/codec'

export interface Anchor {
  p: Vec2
  /** Outgoing cubic control (toward next anchor); null for a straight segment. */
  cpOut: Vec2 | null
  /** Incoming cubic control (from previous anchor). */
  cpIn: Vec2 | null
}

export interface SubPath {
  closed: boolean
  anchors: Anchor[]
}

const KAPPA = 0.5522847498307936

function pt(x: number, y: number): Vec2 {
  return { x, y }
}

function anchor(p: Vec2, cpIn: Vec2 | null = null, cpOut: Vec2 | null = null): Anchor {
  return { p, cpIn, cpOut }
}

// ---------------------------------------------------------------------------
// Primitive outlines (node-local coordinates)
// ---------------------------------------------------------------------------

export function roundedRectPath(w: number, h: number, r: CornerRadius): SubPath {
  const maxR = Math.min(w, h) / 2
  const tl = Math.max(0, Math.min(r.tl, maxR))
  const tr = Math.max(0, Math.min(r.tr, maxR))
  const br = Math.max(0, Math.min(r.br, maxR))
  const bl = Math.max(0, Math.min(r.bl, maxR))
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
    return {
      closed: true,
      anchors: [anchor(pt(0, 0)), anchor(pt(w, 0)), anchor(pt(w, h)), anchor(pt(0, h))],
    }
  }
  const a: Anchor[] = []
  // Top-left corner: arc from (0, tl) to (tl, 0)
  a.push(anchor(pt(0, tl), null, tl ? pt(0, tl - KAPPA * tl) : null))
  a.push(anchor(pt(tl, 0), tl ? pt(tl - KAPPA * tl, 0) : null, null))
  a.push(anchor(pt(w - tr, 0), null, tr ? pt(w - tr + KAPPA * tr, 0) : null))
  a.push(anchor(pt(w, tr), tr ? pt(w, tr - KAPPA * tr) : null, null))
  a.push(anchor(pt(w, h - br), null, br ? pt(w, h - br + KAPPA * br) : null))
  a.push(anchor(pt(w - br, h), br ? pt(w - br + KAPPA * br, h) : null, null))
  a.push(anchor(pt(bl, h), null, bl ? pt(bl - KAPPA * bl, h) : null))
  a.push(anchor(pt(0, h - bl), bl ? pt(0, h - bl + KAPPA * bl) : null, null))
  return { closed: true, anchors: a }
}

export function ellipsePath(w: number, h: number): SubPath {
  const rx = w / 2
  const ry = h / 2
  const cx = rx
  const cy = ry
  const kx = KAPPA * rx
  const ky = KAPPA * ry
  return {
    closed: true,
    anchors: [
      anchor(pt(cx + rx, cy), pt(cx + rx, cy - ky), pt(cx + rx, cy + ky)),
      anchor(pt(cx, cy + ry), pt(cx + kx, cy + ry), pt(cx - kx, cy + ry)),
      anchor(pt(cx - rx, cy), pt(cx - rx, cy + ky), pt(cx - rx, cy - ky)),
      anchor(pt(cx, cy - ry), pt(cx - kx, cy - ry), pt(cx + kx, cy - ry)),
    ],
  }
}

/**
 * Arc / pie / ring / donut-segment from an ellipse (Figma's "Arc" fields).
 *
 * `start` and `sweep` are turns (0..1 = one full revolution), measured
 * clockwise from 12 o'clock so the numbers match what the inspector shows
 * in degrees. `ratio` is the inner radius as a fraction of the outer: 0 is
 * a solid pie, 0.5 leaves a hole half the size.
 *
 * A full sweep with no hole is exactly the plain ellipse, so callers can
 * always route through here — but the caller checks that case first and
 * uses `ellipsePath`, keeping byte-identical output for every existing
 * document (and the parity fixtures with it).
 */
export function arcPath(w: number, h: number, start: number, sweep: number, ratio: number): SubPath {
  const rx = w / 2
  const ry = h / 2
  const cx = rx
  const cy = ry
  const inner = Math.max(0, Math.min(0.999, ratio))
  // Clamp to a full turn; a longer sweep would overlap itself.
  const turns = Math.max(-1, Math.min(1, sweep))
  const total = turns * Math.PI * 2
  const from = start * Math.PI * 2 - Math.PI / 2

  // Cubic arc segments, at most a quarter turn each so the Kappa
  // approximation stays within a fraction of a pixel.
  const steps = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)))
  const step = total / steps

  const onEllipse = (angle: number, k: number): Vec2 =>
    pt(cx + rx * k * Math.cos(angle), cy + ry * k * Math.sin(angle))
  /** Tangent handle length for a cubic spanning `d` radians. */
  const handle = (d: number) => (4 / 3) * Math.tan(d / 4)

  const anchors: Anchor[] = []
  const walk = (k: number, forward: boolean) => {
    for (let i = 0; i <= steps; i++) {
      const t = forward ? i : steps - i
      const angle = from + step * t
      const p = onEllipse(angle, k)
      const hl = handle(step) * (forward ? 1 : -1)
      // Derivative of the parametric ellipse, scaled to the handle length.
      const dx = -rx * k * Math.sin(angle) * hl
      const dy = ry * k * Math.cos(angle) * hl
      const first = i === 0
      const last = i === steps
      anchors.push(anchor(p, first ? null : pt(p.x - dx, p.y - dy), last ? null : pt(p.x + dx, p.y + dy)))
    }
  }

  walk(1, true)
  if (inner > 0) walk(inner, false)
  else if (Math.abs(turns) < 1) anchors.push(anchor(pt(cx, cy)))
  return { closed: true, anchors }
}

/** True when the arc fields still describe a plain, unbroken ellipse. */
export function isFullEllipse(sweep: number, ratio: number): boolean {
  return Math.abs(Math.abs(sweep) - 1) < 1e-9 && ratio <= 0
}

export function linePath(w: number): SubPath {
  return { closed: false, anchors: [anchor(pt(0, 0)), anchor(pt(w, 0))] }
}

export function polygonPath(w: number, h: number, points: number): SubPath {
  const n = Math.max(3, Math.round(points))
  const cx = w / 2
  const cy = h / 2
  const anchors: Anchor[] = []
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    anchors.push(anchor(pt(cx + cx * Math.cos(angle), cy + cy * Math.sin(angle))))
  }
  return { closed: true, anchors }
}

export function starPath(w: number, h: number, points: number, innerRatio: number): SubPath {
  const n = Math.max(3, Math.round(points))
  const cx = w / 2
  const cy = h / 2
  const anchors: Anchor[] = []
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? 1 : Math.max(0.01, Math.min(1, innerRatio))
    const angle = -Math.PI / 2 + (i * Math.PI) / n
    anchors.push(anchor(pt(cx + cx * r * Math.cos(angle), cy + cy * r * Math.sin(angle))))
  }
  return { closed: true, anchors }
}

// ---------------------------------------------------------------------------
// Vector networks -> subpaths (walks edge chains)
// ---------------------------------------------------------------------------

/**
 * Replace sharp corners with circular fillets — one anchor becomes two, joined
 * by the arc. `radii[i]` is the request for `sp.anchors[i]`; 0 leaves it alone.
 *
 * Rules, all of them visible in the tests:
 *  - Only a corner between two STRAIGHT segments rounds. A point whose
 *    neighbour is already a curve stays sharp: trimming a curve back means
 *    splitting it, and a fillet tangent to two curves is not determined by a
 *    radius alone. The stored radius survives, so straightening the segment
 *    later rounds the point without the user re-entering anything.
 *  - The trim distance is capped at HALF the shorter neighbour, so two rounded
 *    corners in a row can never eat into each other.
 *  - The endpoints of an open path have only one neighbour, so they never round.
 *
 * No trigonometry, on purpose. This has a bit-exact Rust twin, and `acos`/`tan`
 * are libm calls whose last ULP is not specified — two engines can legitimately
 * disagree. Everything here is arithmetic and `sqrt`, which IEEE-754 pins:
 * with `c = cos θ` and `s = sin θ` straight from the dot and cross products,
 * tan(θ/2) = s/(1+c), and the quarter angle needed for the arc's control points
 * comes from tan(x/2) = (√(1+T²) − 1)/T.
 */
export function roundSubPathCorners(sp: SubPath, radii: number[]): SubPath {
  let wanted = false
  for (const r of radii) {
    if (r > 0) {
      wanted = true
      break
    }
  }
  // The common case: nothing to do, and no allocation for saying so.
  if (!wanted) return sp
  const n = sp.anchors.length
  if (n < 3) return sp

  const out: Anchor[] = []
  for (let i = 0; i < n; i++) {
    const a = sp.anchors[i]
    const r = radii[i] ?? 0
    const prev = sp.anchors[i === 0 ? n - 1 : i - 1]
    const next = sp.anchors[i === n - 1 ? 0 : i + 1]
    const isOpenEnd = !sp.closed && (i === 0 || i === n - 1)
    // A segment is straight only when NEITHER of its controls is set.
    const straightIn = a.cpIn === null && prev.cpOut === null
    const straightOut = a.cpOut === null && next.cpIn === null
    // `!(r > 0)`, not `r <= 0`: a NaN radius (a corrupt file, a bad agent
    // write) must take the same branch in both engines, and NaN fails both
    // comparisons. This way it stays a sharp corner instead of turning the
    // whole path into NaN coordinates.
    if (!(r > 0) || isOpenEnd || !straightIn || !straightOut) {
      out.push(a)
      continue
    }

    const ux = prev.p.x - a.p.x
    const uy = prev.p.y - a.p.y
    const vx = next.p.x - a.p.x
    const vy = next.p.y - a.p.y
    const lu = Math.sqrt(ux * ux + uy * uy)
    const lv = Math.sqrt(vx * vx + vy * vy)
    if (lu < 1e-9 || lv < 1e-9) {
      out.push(a)
      continue
    }
    const unx = ux / lu
    const uny = uy / lu
    const vnx = vx / lv
    const vny = vy / lv
    const c = unx * vnx + uny * vny
    const s = Math.abs(unx * vny - uny * vnx)
    // s ~ 0 is collinear (nothing to round) or a fold back on itself; 1+c ~ 0
    // is the straight-through case, where the tangent length would blow up.
    if (s < 1e-9 || 1 + c < 1e-9) {
      out.push(a)
      continue
    }
    const tanHalf = s / (1 + c)
    const t = Math.min(r / tanHalf, 0.5 * lu, 0.5 * lv)
    const radius = t * tanHalf
    // Turn angle φ = π − θ, so tan(φ/2) = 1/tan(θ/2); the arc's control arm is
    // (4/3)·tan(φ/4)·radius, which is κ·radius at a right angle.
    const tHalfTurn = 1 / tanHalf
    const tQuarterTurn = (Math.sqrt(1 + tHalfTurn * tHalfTurn) - 1) / tHalfTurn
    const k = (4 / 3) * tQuarterTurn * radius

    // Travel runs prev -> a -> next, so the direction into the corner is -un
    // and out of it is vn. The arc starts t back along each neighbour.
    const p0 = pt(a.p.x + unx * t, a.p.y + uny * t)
    const p3 = pt(a.p.x + vnx * t, a.p.y + vny * t)
    out.push({ p: p0, cpIn: null, cpOut: pt(p0.x - unx * k, p0.y - uny * k) })
    out.push({ p: p3, cpIn: pt(p3.x - vnx * k, p3.y - vny * k), cpOut: null })
  }
  return { closed: sp.closed, anchors: out }
}

export function networkToSubPaths(network: VectorNetwork): SubPath[] {
  const { vertices, edges } = network
  if (edges.length === 0) return []
  const vmap = new Map(vertices.map((v) => [v.id, v]))
  const adjacency = new Map<number, number[]>() // vertexId -> edge indices
  edges.forEach((e, i) => {
    if (!adjacency.has(e.v0)) adjacency.set(e.v0, [])
    if (!adjacency.has(e.v1)) adjacency.set(e.v1, [])
    adjacency.get(e.v0)!.push(i)
    adjacency.get(e.v1)!.push(i)
  })

  const used = new Set<number>()
  const paths: SubPath[] = []

  const takeChain = (startEdgeIdx: number) => {
    // Walk backward to a chain start (vertex of degree != 2 or loop closure).
    const chain: { edgeIdx: number; forward: boolean }[] = []
    let e = edges[startEdgeIdx]
    // walk forward from e.v0 -> e.v1
    chain.push({ edgeIdx: startEdgeIdx, forward: true })
    used.add(startEdgeIdx)
    // extend forward
    let tail = e.v1
    for (;;) {
      const nexts = (adjacency.get(tail) ?? []).filter((i) => !used.has(i))
      if (nexts.length === 0) break
      const ni = nexts[0]
      const ne = edges[ni]
      const forward = ne.v0 === tail
      chain.push({ edgeIdx: ni, forward })
      used.add(ni)
      tail = forward ? ne.v1 : ne.v0
      if (tail === e.v0) break // loop closed
    }
    // extend backward
    let head = e.v0
    for (;;) {
      if (head === tail) break // already a loop
      const prevs = (adjacency.get(head) ?? []).filter((i) => !used.has(i))
      if (prevs.length === 0) break
      const pi = prevs[0]
      const pe = edges[pi]
      const forward = pe.v1 === head
      chain.unshift({ edgeIdx: pi, forward })
      used.add(pi)
      head = forward ? pe.v0 : pe.v1
    }

    const closed = head === tail && chain.length > 1
    const anchors: Anchor[] = []
    // Radius requests ride alongside, one per anchor, for the rounding pass at
    // the end: SubPath has no room for them and the outline is where they stop
    // being a property of a point and become geometry.
    const radii: number[] = []
    const pushVertex = (vid: number) => {
      const v = vmap.get(vid)
      anchors.push(anchor(pt(v?.x ?? 0, v?.y ?? 0)))
      radii.push(v?.cornerRadius ?? 0)
    }
    pushVertex(head)
    let cursor = head
    for (const { edgeIdx, forward } of chain) {
      const edge = edges[edgeIdx]
      const from = forward ? edge.v0 : edge.v1
      const to = forward ? edge.v1 : edge.v0
      if (from !== cursor) {
        // Disconnected guard; shouldn't happen in well-formed chains.
        pushVertex(from)
      }
      const cpA = forward ? edge.cp0 : edge.cp1
      const cpB = forward ? edge.cp1 : edge.cp0
      const last = anchors[anchors.length - 1]
      last.cpOut = cpA ? { ...cpA } : null
      if (closed && to === head && chain[chain.length - 1].edgeIdx === edgeIdx) {
        anchors[0].cpIn = cpB ? { ...cpB } : null
      } else {
        const v = vmap.get(to)
        anchors.push(anchor(pt(v?.x ?? 0, v?.y ?? 0), cpB ? { ...cpB } : null))
        radii.push(v?.cornerRadius ?? 0)
      }
      cursor = to
    }
    paths.push(roundSubPathCorners({ closed, anchors }, radii))
  }

  for (let i = 0; i < edges.length; i++) {
    if (!used.has(i)) takeChain(i)
  }
  return paths
}

// ---------------------------------------------------------------------------
// Node -> outline dispatch (BOOLEAN handled by booleans.ts to avoid cycles)
// ---------------------------------------------------------------------------

export function nodeOutline(node: SceneNode): SubPath[] {
  if (useWasm('shapes')) return wasmNodeOutline(node)
  switch (node.type) {
    case 'RECTANGLE':
      return [roundedRectPath(node.width, node.height, node.cornerRadius)]
    case 'FRAME':
    case 'COMPONENT':
    case 'INSTANCE':
      return [roundedRectPath(node.width, node.height, node.cornerRadius)]
    case 'ELLIPSE': {
      const { arcStart = 0, arcSweep = 1, arcRatio = 0 } = node
      if (isFullEllipse(arcSweep, arcRatio)) return [ellipsePath(node.width, node.height)]
      return [arcPath(node.width, node.height, arcStart, arcSweep, arcRatio)]
    }
    case 'LINE':
      return [linePath(node.width)]
    case 'POLYGON':
      return [polygonPath(node.width, node.height, node.pointCount)]
    case 'STAR':
      return [starPath(node.width, node.height, node.pointCount, node.innerRatio)]
    case 'VECTOR':
      return networkToSubPaths(node.network)
    case 'TEXT':
    case 'GROUP':
    case 'BOOLEAN':
    case 'MODEL3D':
      return [
        {
          closed: true,
          anchors: [
            anchor(pt(0, 0)),
            anchor(pt(node.width, 0)),
            anchor(pt(node.width, node.height)),
            anchor(pt(0, node.height)),
          ],
        },
      ]
  }
}

/** Rust twin of the switch above (crates/polyform-core); same outputs per type. */
function wasmNodeOutline(node: SceneNode): SubPath[] {
  const w = wasmHandle()
  switch (node.type) {
    case 'RECTANGLE':
    case 'FRAME':
    case 'COMPONENT':
    case 'INSTANCE': {
      const r = node.cornerRadius
      return decodeSubPaths(w.roundedRectPath(node.width, node.height, r.tl, r.tr, r.br, r.bl))
    }
    case 'ELLIPSE': {
      const { arcStart = 0, arcSweep = 1, arcRatio = 0 } = node
      if (isFullEllipse(arcSweep, arcRatio)) {
        return decodeSubPaths(w.ellipsePath(node.width, node.height))
      }
      return decodeSubPaths(w.arcPath(node.width, node.height, arcStart, arcSweep, arcRatio))
    }
    case 'LINE':
      return decodeSubPaths(w.linePath(node.width))
    case 'POLYGON':
      return decodeSubPaths(w.polygonPath(node.width, node.height, node.pointCount))
    case 'STAR':
      return decodeSubPaths(w.starPath(node.width, node.height, node.pointCount, node.innerRatio))
    case 'VECTOR': {
      const { vertices, edges } = encodeNetwork(node.network)
      return decodeSubPaths(w.networkToSubPaths(vertices, edges))
    }
    case 'TEXT':
    case 'GROUP':
    case 'BOOLEAN':
    case 'MODEL3D':
      // Zero radii take the plain 4-anchor rectangle path in Rust, matching
      // the inline TS branch above.
      return decodeSubPaths(w.roundedRectPath(node.width, node.height, 0, 0, 0, 0))
  }
}

// ---------------------------------------------------------------------------
// Flattening & path strings
// ---------------------------------------------------------------------------

/**
 * The same subpath in another space.
 *
 * Control points move with the anchors and nothing is re-fitted, because the
 * affine image of a cubic bezier IS the cubic through the transformed control
 * points — exact, not an approximation.
 */
export function transformSubPath(sp: SubPath, m: Mat): SubPath {
  return {
    closed: sp.closed,
    anchors: sp.anchors.map((a) => ({
      p: applyMat(m, a.p),
      cpIn: a.cpIn ? applyMat(m, a.cpIn) : null,
      cpOut: a.cpOut ? applyMat(m, a.cpOut) : null,
    })),
  }
}

/** Closed polyline rings as subpaths — how boolean and mask coverage arrive. */
export function ringsToSubPaths(rings: readonly Vec2[][]): SubPath[] {
  const out: SubPath[] = []
  for (const ring of rings) {
    if (ring.length < 3) continue
    out.push({ closed: true, anchors: ring.map((p) => ({ p: { ...p }, cpIn: null, cpOut: null })) })
  }
  return out
}

/** Flatten a subpath to a polyline of points (closed rings do not repeat the first point). */
export function flattenSubPath(sp: SubPath, tolerance = 0.25): Vec2[] {
  if (useWasm('shapes')) {
    const rings = decodeRings(wasmHandle().flattenSubPaths(encodeSubPaths([sp]), tolerance))
    return rings[0] ?? []
  }
  const out: Vec2[] = []
  const n = sp.anchors.length
  if (n === 0) return out
  out.push({ ...sp.anchors[0].p })
  const segCount = sp.closed ? n : n - 1
  for (let i = 0; i < segCount; i++) {
    const a = sp.anchors[i]
    const b = sp.anchors[(i + 1) % n]
    if (a.cpOut || b.cpIn) {
      const c0 = a.cpOut ?? a.p
      const c1 = b.cpIn ?? b.p
      out.push(...flattenCubic(a.p, c0, c1, b.p, tolerance))
    } else {
      out.push({ ...b.p })
    }
  }
  if (sp.closed && out.length > 1) out.pop() // last point duplicates the first
  return out
}

/** SVG path `d` string for a list of subpaths. */
export function subPathsToSvg(paths: SubPath[], precision = 3): string {
  if (useWasm('shapes')) return wasmHandle().subPathsToSvg(encodeSubPaths(paths), precision)
  const f = (v: number) => Number(v.toFixed(precision))
  let d = ''
  for (const sp of paths) {
    const n = sp.anchors.length
    if (n === 0) continue
    d += `M ${f(sp.anchors[0].p.x)} ${f(sp.anchors[0].p.y)} `
    const segCount = sp.closed ? n : n - 1
    for (let i = 0; i < segCount; i++) {
      const a = sp.anchors[i]
      const b = sp.anchors[(i + 1) % n]
      if (a.cpOut || b.cpIn) {
        const c0 = a.cpOut ?? a.p
        const c1 = b.cpIn ?? b.p
        d += `C ${f(c0.x)} ${f(c0.y)} ${f(c1.x)} ${f(c1.y)} ${f(b.p.x)} ${f(b.p.y)} `
      } else {
        d += `L ${f(b.p.x)} ${f(b.p.y)} `
      }
    }
    if (sp.closed) d += 'Z '
  }
  return d.trim()
}
