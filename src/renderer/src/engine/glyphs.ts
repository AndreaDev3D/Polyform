// Glyph outline cache for the shaped text stack (Sprint E): decodes SubPath
// blobs from the WASM engine into Path2D objects (font units, y-down,
// baseline at 0) plus a conservative bounding box. Shared by the Canvas2D
// shaped-text draw path and the WebGPU glyph atlas.

import { useWasm, wasmHandle } from './backend'
import { decodeSubPaths } from './wasm/codec'
import { transformSubPath, type SubPath } from './shapes'
import { layoutText } from './text'
import type { Mat } from './geometry'
import type { TextNode } from './types'

export interface GlyphOutline {
  /** null for whitespace / empty glyphs. */
  path: Path2D | null
  /**
   * The same outline before it became a Path2D. Kept because a Path2D can only
   * be drawn: it cannot be transformed, unioned or tessellated, which is what a
   * text MASK and the WebGPU backend need from the very same curves.
   */
  subpaths: SubPath[]
  /** Conservative bbox over anchors + control points, font units, y-down. */
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const cache = new Map<string, GlyphOutline>()

function buildPath(paths: SubPath[]): Path2D {
  const path = new Path2D()
  for (const sp of paths) {
    const n = sp.anchors.length
    if (n === 0) continue
    path.moveTo(sp.anchors[0].p.x, sp.anchors[0].p.y)
    const segCount = sp.closed ? n : n - 1
    for (let i = 0; i < segCount; i++) {
      const a = sp.anchors[i]
      const b = sp.anchors[(i + 1) % n]
      if (a.cpOut || b.cpIn) {
        const c0 = a.cpOut ?? a.p
        const c1 = b.cpIn ?? b.p
        path.bezierCurveTo(c0.x, c0.y, c1.x, c1.y, b.p.x, b.p.y)
      } else {
        path.lineTo(b.p.x, b.p.y)
      }
    }
    if (sp.closed) path.closePath()
  }
  return path
}

/**
 * Outline for (fontId, glyphId), cached for the session. Returns null only
 * when the engine is unavailable (callers should already be gated).
 */
export function glyphOutline(fontId: number, glyphId: number): GlyphOutline | null {
  const key = `${fontId}:${glyphId}`
  const cached = cache.get(key)
  if (cached) return cached
  if (!useWasm('text') || typeof Path2D === 'undefined') return null
  const blob = wasmHandle().glyphSubPaths(fontId, glyphId)
  const subpaths = decodeSubPaths(blob)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let points = 0
  for (const sp of subpaths) {
    for (const a of sp.anchors) {
      for (const p of [a.p, a.cpIn, a.cpOut]) {
        if (!p) continue
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
        points++
      }
    }
  }
  const outline: GlyphOutline =
    points === 0
      ? { path: null, subpaths: [], minX: 0, minY: 0, maxX: 0, maxY: 0 }
      : { path: buildPath(subpaths), subpaths, minX, minY, maxX, maxY }
  cache.set(key, outline)
  return outline
}

/**
 * A text node's glyphs as geometry, in the node's own coordinates.
 *
 * Empty when this node did not go through the shaping engine (no WASM, font
 * bytes still loading, non-DOM test environment) — there are no outlines to be
 * had in that case, only a font name handed to `fillText`, so callers need a
 * fallback rather than a wrong shape.
 *
 * Why it exists: `nodeOutline` answers "what box is this text in", which is the
 * right answer for selection and the wrong one for a mask. Clipping to the box
 * clips nothing, so text used as a mask showed the whole picture underneath
 * instead of showing it inside the letters (F-33).
 */
export function textSubPaths(node: TextNode): SubPath[] {
  const layout = layoutText(node)
  if (!layout.shaped) return []
  // Font units -> node units. The glyph positions are already in node space.
  const s = node.fontSize / layout.shaped.unitsPerEm
  const out: SubPath[] = []
  for (const line of layout.lines) {
    const glyphs = line.glyphs
    if (!glyphs) continue
    for (let i = 0; i + 3 <= glyphs.length; i += 3) {
      const outline = glyphOutline(layout.shaped.fontId, glyphs[i])
      if (!outline || outline.subpaths.length === 0) continue
      const m: Mat = { a: s, b: 0, c: 0, d: s, e: glyphs[i + 1], f: glyphs[i + 2] }
      for (const sp of outline.subpaths) out.push(transformSubPath(sp, m))
    }
  }
  return out
}
