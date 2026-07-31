// Text measurement & line layout on Canvas2D. HarfBuzz shaping is a planned
// upgrade (docs/Roadmap.md); Canvas2D gives kerning via the platform shaper.
// Falls back to a heuristic estimator in non-DOM environments (unit tests).

import type { TextNode } from './types'

export interface TextLine {
  text: string
  width: number
  /** X offset inside the node (alignment applied). */
  x: number
  /** Baseline Y inside the node. */
  baseline: number
}

export interface TextLayout {
  lines: TextLine[]
  lineHeightPx: number
  ascent: number
  totalWidth: number
  totalHeight: number
  font: string
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

/**
 * Lay out a text node's characters into positioned lines. When the node
 * auto-resizes, the caller applies `totalWidth`/`totalHeight` back onto it.
 */
export function layoutText(node: TextNode): TextLayout {
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
