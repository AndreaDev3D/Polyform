// Glyph atlas for the WebGPU shaped-text path (Sprint E, ADR-018): glyph
// outlines rasterized once per (font, glyph, raster scale) into a shared
// shelf-packed OffscreenCanvas, uploaded as ONE texture — text draws become
// batched quads instead of per-node rasters.
//
// Overflow policy: the atlas clears wholesale and the renderer rebakes
// (content-addressed entries repopulate on demand). A bake that overflows
// twice falls back to legacy per-node rasters for the session.

import { glyphOutline } from '../../glyphs'

export interface AtlasGlyph {
  /** UV rect in the atlas texture (0..1). */
  u0: number
  v0: number
  u1: number
  v1: number
  /** Cell rect in raster px relative to the glyph origin (pen x, baseline
   * y), y-down. Node-local quad = origin + rect / rasterScale. */
  x0: number
  y0: number
  x1: number
  y1: number
  /** Whitespace / empty glyph — nothing to draw. */
  empty: boolean
}

const ATLAS_SIZE = 2048
const PAD = 2

export class GlyphAtlas {
  readonly size = ATLAS_SIZE
  canvas: OffscreenCanvas
  private ctx: OffscreenCanvasRenderingContext2D
  private entries = new Map<string, AtlasGlyph>()
  private shelfX = 0
  private shelfY = 0
  private shelfH = 0
  /** Set when new glyphs were rasterized since the last texture upload. */
  dirty = false
  /** Set when the atlas cleared during the current bake (uv refs stale). */
  clearedDuringBake = false

  constructor() {
    this.canvas = new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE)
    this.ctx = this.canvas.getContext('2d')!
  }

  beginBake(): void {
    this.clearedDuringBake = false
  }

  private clear(): void {
    this.entries.clear()
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
    this.shelfX = 0
    this.shelfY = 0
    this.shelfH = 0
    this.clearedDuringBake = true
    this.dirty = true
  }

  /**
   * Entry for (fontId, glyphId) at `unitScale` device px per font unit
   * (= fontSize * rasterScale / unitsPerEm). Returns null when the glyph
   * cannot be rasterized (engine unavailable / oversized) — the caller
   * falls back to the legacy per-node raster.
   */
  get(
    fontId: number,
    glyphId: number,
    unitScale: number,
  ): AtlasGlyph | null {
    const q = Math.round(unitScale * 1e5) / 1e5
    const key = `${fontId}:${glyphId}:${q}`
    const cached = this.entries.get(key)
    if (cached) return cached

    const outline = glyphOutline(fontId, glyphId)
    if (!outline) return null
    if (!outline.path) {
      const empty: AtlasGlyph = { u0: 0, v0: 0, u1: 0, v1: 0, x0: 0, y0: 0, x1: 0, y1: 0, empty: true }
      this.entries.set(key, empty)
      return empty
    }
    const x0 = Math.floor(outline.minX * q) - PAD
    const y0 = Math.floor(outline.minY * q) - PAD
    const x1 = Math.ceil(outline.maxX * q) + PAD
    const y1 = Math.ceil(outline.maxY * q) + PAD
    const w = x1 - x0
    const h = y1 - y0
    if (w <= 0 || h <= 0 || w > ATLAS_SIZE / 2 || h > ATLAS_SIZE / 2) return null

    // Shelf packing with wholesale clear on overflow.
    if (this.shelfX + w > ATLAS_SIZE) {
      this.shelfY += this.shelfH
      this.shelfX = 0
      this.shelfH = 0
    }
    if (this.shelfY + h > ATLAS_SIZE) {
      this.clear()
    }
    const cellX = this.shelfX
    const cellY = this.shelfY
    this.shelfX += w
    this.shelfH = Math.max(this.shelfH, h)

    const ctx = this.ctx
    ctx.save()
    ctx.setTransform(q, 0, 0, q, cellX - x0, cellY - y0)
    ctx.fillStyle = '#fff'
    ctx.fill(outline.path)
    ctx.restore()
    this.dirty = true

    const entry: AtlasGlyph = {
      u0: cellX / ATLAS_SIZE,
      v0: cellY / ATLAS_SIZE,
      u1: (cellX + w) / ATLAS_SIZE,
      v1: (cellY + h) / ATLAS_SIZE,
      x0,
      y0,
      x1,
      y1,
      empty: false,
    }
    this.entries.set(key, entry)
    return entry
  }
}
