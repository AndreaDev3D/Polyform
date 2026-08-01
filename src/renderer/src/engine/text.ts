// Text measurement & line layout. Two paths behind the 'text' backend flag
// (Sprint E, ADR-018):
//  - SHAPED (default when WASM + font bytes are loaded): rustybuzz shaping
//    with deterministic engine layout — kerning, ligatures, real metrics,
//    identical on every machine (closes F-02). Returns per-glyph positions
//    that both renderers consume (Canvas2D fills outlines, WebGPU draws
//    atlas quads).
//  - LEGACY Canvas2D measureText + fillText, kept as the per-node fallback
//    while a font's bytes are loading/missing, when the flag is off, and as
//    the heuristic estimator in non-DOM environments (unit tests).

import type { TextNode } from './types'
import { poisonWasmEngine, useWasm, wasmHandle } from './backend'
import { fontEntryFor } from './fontstore'

export interface TextLine {
  text: string
  width: number
  /** X offset inside the node (alignment applied). */
  x: number
  /** Baseline Y inside the node. */
  baseline: number
  /** Shaped path only: flat [glyphId, x, y]* (y = baseline, y-down). */
  glyphs?: number[]
}

export interface TextLayout {
  lines: TextLine[]
  lineHeightPx: number
  ascent: number
  totalWidth: number
  totalHeight: number
  font: string
  /** Present when this layout came from the shaping engine. */
  shaped?: { fontId: number; unitsPerEm: number }
}

let measureCtx: CanvasRenderingContext2D | null = null

function getCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  measureCtx = canvas.getContext('2d')
  return measureCtx
}

export function fontString(node: TextNode): string {
  const style = node.italic ? 'italic ' : ''
  return `${style}${node.fontWeight} ${node.fontSize}px "${node.fontFamily}"`
}

function measureWidth(text: string, node: TextNode): number {
  const ctx = getCtx()
  if (!ctx) {
    return text.length * node.fontSize * 0.6 + Math.max(0, text.length - 1) * node.letterSpacing
  }
  ctx.font = fontString(node)
  try {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${node.letterSpacing}px`
  } catch {
    /* older engines */
  }
  return ctx.measureText(text).width
}

function wrapLine(text: string, node: TextNode, maxWidth: number): string[] {
  if (measureWidth(text, node) <= maxWidth || maxWidth <= 0) return [text]
  const words = text.split(/(\s+)/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current + word
    if (current !== '' && measureWidth(candidate.trimEnd(), node) > maxWidth) {
      lines.push(current.trimEnd())
      current = word.trimStart()
      // Hard-break overlong single words.
      while (measureWidth(current, node) > maxWidth && current.length > 1) {
        let lo = 1
        let hi = current.length
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2)
          if (measureWidth(current.slice(0, mid), node) > maxWidth) hi = mid - 1
          else lo = mid
        }
        lines.push(current.slice(0, lo))
        current = current.slice(lo)
      }
    } else {
      current = candidate
    }
  }
  if (current.trimEnd() !== '' || lines.length === 0) lines.push(current.trimEnd())
  return lines
}

const ALIGN_H = { LEFT: 0, CENTER: 1, RIGHT: 2 } as const
const ALIGN_V = { TOP: 0, CENTER: 1, BOTTOM: 2 } as const
const AUTO_RESIZE = { WIDTH_AND_HEIGHT: 0, HEIGHT: 1, NONE: 2 } as const

interface ShapedLineJson {
  text: string
  width: number
  x: number
  baseline: number
  glyphs: number[]
}

interface ShapedLayoutJson {
  ascent: number
  lineHeightPx: number
  totalWidth: number
  totalHeight: number
  lines: ShapedLineJson[]
}

function shapedLayout(node: TextNode): TextLayout | null {
  if (!useWasm('text')) return null
  const entry = fontEntryFor(node.fontFamily, node.fontWeight, node.italic)
  if (!entry) return null
  try {
    const raw = wasmHandle().layoutTextJson(
      entry.id,
      JSON.stringify({
        text: node.characters,
        size: node.fontSize,
        lineHeight: node.lineHeight,
        letterSpacing: node.letterSpacing,
        width: node.width,
        height: node.height,
        alignH: ALIGN_H[node.textAlignH],
        alignV: ALIGN_V[node.textAlignV],
        autoResize: AUTO_RESIZE[node.autoResize],
      }),
    )
    const parsed = JSON.parse(raw) as ShapedLayoutJson | null
    if (!parsed) return null
    return {
      lines: parsed.lines,
      lineHeightPx: parsed.lineHeightPx,
      ascent: parsed.ascent,
      totalWidth: parsed.totalWidth,
      totalHeight: parsed.totalHeight,
      font: fontString(node),
      shaped: { fontId: entry.id, unitsPerEm: entry.metrics.unitsPerEm },
    }
  } catch (err) {
    poisonWasmEngine(err)
    return null
  }
}

/**
 * Lay out a text node's characters into positioned lines. When the node
 * auto-resizes, the caller applies `totalWidth`/`totalHeight` back onto it.
 */
export function layoutText(node: TextNode): TextLayout {
  const shaped = shapedLayout(node)
  if (shaped) return shaped
  return legacyLayout(node)
}

function legacyLayout(node: TextNode): TextLayout {
  const lineHeightPx = node.fontSize * node.lineHeight
  const ascent = node.fontSize * 0.8 // approximation consistent across renderer + export
  const raw = node.characters.length > 0 ? node.characters.split('\n') : ['']
  let texts: string[]
  if (node.autoResize === 'WIDTH_AND_HEIGHT') {
    texts = raw
  } else {
    texts = raw.flatMap((l) => wrapLine(l, node, node.width))
  }
  const widths = texts.map((t) => measureWidth(t, node))
  const totalWidth = Math.max(1, ...widths)
  const totalHeight = Math.max(lineHeightPx, texts.length * lineHeightPx)

  const boxWidth = node.autoResize === 'WIDTH_AND_HEIGHT' ? totalWidth : node.width
  const boxHeight = node.autoResize === 'NONE' ? node.height : totalHeight

  let yStart = 0
  if (node.textAlignV === 'CENTER') yStart = (boxHeight - texts.length * lineHeightPx) / 2
  else if (node.textAlignV === 'BOTTOM') yStart = boxHeight - texts.length * lineHeightPx

  const lines: TextLine[] = texts.map((text, i) => {
    const width = widths[i]
    let x = 0
    if (node.textAlignH === 'CENTER') x = (boxWidth - width) / 2
    else if (node.textAlignH === 'RIGHT') x = boxWidth - width
    return {
      text,
      width,
      x,
      baseline: yStart + i * lineHeightPx + ascent + (lineHeightPx - node.fontSize) / 2,
    }
  })

  return { lines, lineHeightPx, ascent, totalWidth, totalHeight, font: fontString(node) }
}
