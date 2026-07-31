// Pure geometry: 2D affine matrices, AABBs, bezier flattening, point tests.
// No DOM dependencies — unit-testable and portable to the Rust core.

import type { Vec2 } from './types'

/** Row-major 2x3 affine matrix matching canvas setTransform(a,b,c,d,e,f). */
export interface Mat {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface AABB {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function matMultiply(m1: Mat, m2: Mat): Mat {
  // Applies m2 first, then m1 (i.e. result = m1 * m2).
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

export function matTranslate(tx: number, ty: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }
}

export function matRotateDeg(deg: number): Mat {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
}

export function matInvert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) return { ...IDENTITY }
  const inv = 1 / det
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  }
}

export function applyMat(m: Mat, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

/**
 * Local-to-parent matrix for a node at (x, y) with size (w, h) rotated
 * `rotation` degrees about its center.
 */
export function nodeLocalMatrix(x: number, y: number, w: number, h: number, rotation: number): Mat {
  if (rotation === 0) return matTranslate(x, y)
  const cx = w / 2
  const cy = h / 2
  return matMultiply(
    matTranslate(x + cx, y + cy),
    matMultiply(matRotateDeg(rotation), matTranslate(-cx, -cy)),
  )
}

// ---------------------------------------------------------------------------
// AABB
// ---------------------------------------------------------------------------

export function emptyAABB(): AABB {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
}

export function aabbIsEmpty(b: AABB): boolean {
  return b.minX > b.maxX || b.minY > b.maxY
}

export function aabbUnion(a: AABB, b: AABB): AABB {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

export function aabbExpand(b: AABB, pad: number): AABB {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
}

export function aabbIntersects(a: AABB, b: AABB): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

export function aabbContainsPoint(b: AABB, p: Vec2, pad = 0): boolean {
  return p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad
}

export function aabbContainsAABB(outer: AABB, inner: AABB): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  )
}

/** AABB of a w x h rect transformed by m. */
export function transformedRectAABB(m: Mat, w: number, h: number): AABB {
  const pts = [
    applyMat(m, { x: 0, y: 0 }),
    applyMat(m, { x: w, y: 0 }),
    applyMat(m, { x: w, y: h }),
    applyMat(m, { x: 0, y: h }),
  ]
  const b = emptyAABB()
  for (const p of pts) {
    b.minX = Math.min(b.minX, p.x)
    b.minY = Math.min(b.minY, p.y)
    b.maxX = Math.max(b.maxX, p.x)
    b.maxY = Math.max(b.maxY, p.y)
  }
  return b
}

export function aabbOfPoints(pts: Vec2[]): AABB {
  const b = emptyAABB()
  for (const p of pts) {
    b.minX = Math.min(b.minX, p.x)
    b.minY = Math.min(b.minY, p.y)
    b.maxX = Math.max(b.maxX, p.x)
    b.maxY = Math.max(b.maxY, p.y)
  }
  return b
}

// ---------------------------------------------------------------------------
// Bezier flattening
// ---------------------------------------------------------------------------

/**
 * Flatten a cubic bezier into a polyline (excluding the start point).
 * Adaptive-ish: fixed subdivision scaled by control polygon length.
 */
export function flattenCubic(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, tolerance = 0.25): Vec2[] {
  const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y)
  const poly =
    Math.hypot(c0.x - p0.x, c0.y - p0.y) +
    Math.hypot(c1.x - c0.x, c1.y - c0.y) +
    Math.hypot(p1.x - c1.x, p1.y - c1.y)
  const steps = Math.max(2, Math.min(64, Math.ceil(Math.sqrt((poly + chord) / tolerance))))
  const out: Vec2[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const d = t * t * t
    out.push({
      x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
      y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Point tests
// ---------------------------------------------------------------------------

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Nonzero-winding point-in-polygon over one or more rings. */
export function pointInPolygonRings(p: Vec2, rings: Vec2[][], evenOdd = false): boolean {
  let winding = 0
  let crossings = 0
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      if (a.y <= p.y) {
        if (b.y > p.y && cross(a, b, p) > 0) {
          winding++
          crossings++
        }
      } else if (b.y <= p.y && cross(a, b, p) < 0) {
        winding--
        crossings++
      }
    }
  }
  return evenOdd ? crossings % 2 === 1 : winding !== 0
}

function cross(a: Vec2, b: Vec2, p: Vec2): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y)
}

export function pointInEllipse(p: Vec2, cx: number, cy: number, rx: number, ry: number): boolean {
  if (rx <= 0 || ry <= 0) return false
  const nx = (p.x - cx) / rx
  const ny = (p.y - cy) / ry
  return nx * nx + ny * ny <= 1
}

export function pointInRoundedRect(p: Vec2, w: number, h: number, r: { tl: number; tr: number; br: number; bl: number }): boolean {
  if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) return false
  const clamp = (v: number) => Math.max(0, Math.min(v, Math.min(w, h) / 2))
  const tl = clamp(r.tl)
  const tr = clamp(r.tr)
  const br = clamp(r.br)
  const bl = clamp(r.bl)
  if (tl && p.x < tl && p.y < tl && Math.hypot(p.x - tl, p.y - tl) > tl) return false
  if (tr && p.x > w - tr && p.y < tr && Math.hypot(p.x - (w - tr), p.y - tr) > tr) return false
  if (br && p.x > w - br && p.y > h - br && Math.hypot(p.x - (w - br), p.y - (h - br)) > br) return false
  if (bl && p.x < bl && p.y > h - bl && Math.hypot(p.x - bl, p.y - (h - bl)) > bl) return false
  return true
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
