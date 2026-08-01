// SVG export. Vector-faithful for shapes/text; image fills are embedded as
// base64 data URIs. Stroke align INSIDE/OUTSIDE approximates to CENTER (SVG
// has no native stroke alignment) — noted in docs/Feature-Matrix.md.

import type { NodeId, Paint, SceneNode, TextNode } from '../types'
import { isContainer } from '../types'
import type { SceneGraph } from '../scene'
import { aabbIsEmpty, aabbUnion, emptyAABB } from '../geometry'
import { nodeOutline, subPathsToSvg } from '../shapes'
import { booleanRings } from '../booleans'
import { layoutText } from '../text'
import { rgbaToCss } from '../color'

type BytesFetcher = (hash: string) => Promise<{ bytes: Uint8Array; mime: string } | null>

let defsCounter = 0

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function num(v: number): string {
  return String(Math.round(v * 1000) / 1000)
}

interface SvgCtx {
  scene: SceneGraph
  defs: string[]
  fetchBytes: BytesFetcher
  imageCache: Map<string, string | null>
}

async function imageHref(ctx: SvgCtx, hash: string): Promise<string | null> {
  if (ctx.imageCache.has(hash)) return ctx.imageCache.get(hash) ?? null
  const data = await ctx.fetchBytes(hash)
  let href: string | null = null
  if (data) {
    let binary = ''
    const bytes = data.bytes
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)))
    }
    href = `data:${data.mime};base64,${btoa(binary)}`
  }
  ctx.imageCache.set(hash, href)
  return href
}

function paintToSvgFill(ctx: SvgCtx, paint: Paint, node: SceneNode): string | null {
  if (paint.type === 'SOLID') return rgbaToCss(paint.color, paint.opacity)
  if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') {
    const id = `grad${++defsCounter}`
    const w = node.width
    const h = node.height
    const stops = paint.stops
      .map(
        (s) =>
          `<stop offset="${num(Math.max(0, Math.min(1, s.position)))}" stop-color="${rgbaToCss(s.color, paint.opacity)}"/>`,
      )
      .join('')
    // userSpaceOnUse matches the canvas renderer exactly (objectBoundingBox
    // would turn radial gradients into ellipses on non-square shapes).
    if (paint.type === 'GRADIENT_LINEAR') {
      ctx.defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(paint.start.x * w)}" y1="${num(paint.start.y * h)}" x2="${num(paint.end.x * w)}" y2="${num(paint.end.y * h)}">${stops}</linearGradient>`,
      )
    } else {
      const r = Math.max(0.001, Math.hypot((paint.end.x - paint.start.x) * w, (paint.end.y - paint.start.y) * h))
      ctx.defs.push(
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(paint.start.x * w)}" cy="${num(paint.start.y * h)}" r="${num(r)}">${stops}</radialGradient>`,
      )
    }
    return `url(#${id})`
  }
  return null
}

function strokeAttrs(ctx: SvgCtx, node: SceneNode): string {
  const paint = node.strokes.find((s) => s.visible && s.type !== 'IMAGE')
  if (!paint || node.strokeWeight <= 0) return ''
  const stroke = paintToSvgFill(ctx, paint, node)
  if (!stroke) return ''
  let attrs = ` stroke="${stroke}" stroke-width="${num(node.strokeWeight)}"`
  if (node.strokeDash.length > 0) attrs += ` stroke-dasharray="${node.strokeDash.map(num).join(' ')}"`
  return attrs
}

function transformAttr(node: SceneNode): string {
  if (node.rotation === 0) {
    if (node.x === 0 && node.y === 0) return ''
    return ` transform="translate(${num(node.x)} ${num(node.y)})"`
  }
  const cx = node.width / 2
  const cy = node.height / 2
  return ` transform="translate(${num(node.x)} ${num(node.y)}) rotate(${num(node.rotation)} ${num(cx)} ${num(cy)})"`
}

function commonAttrs(node: SceneNode): string {
  let attrs = ''
  if (node.opacity < 1) attrs += ` opacity="${num(node.opacity)}"`
  if (node.blendMode !== 'NORMAL') {
    attrs += ` style="mix-blend-mode:${node.blendMode.toLowerCase().replace(/_/g, '-')}"`
  }
  return attrs
}

function effectsFilter(ctx: SvgCtx, node: SceneNode): string {
  const parts: string[] = []
  for (const fx of node.effects) {
    if (!fx.visible) continue
    if (fx.type === 'DROP_SHADOW') {
      parts.push(
        `<feDropShadow dx="${num(fx.offset.x)}" dy="${num(fx.offset.y)}" stdDeviation="${num(fx.blur / 2)}" flood-color="${rgbaToCss(fx.color)}"/>`,
      )
    } else if (fx.type === 'LAYER_BLUR' && fx.radius > 0) {
      parts.push(`<feGaussianBlur stdDeviation="${num(fx.radius / 2)}"/>`)
    }
  }
  if (parts.length === 0) return ''
  const id = `fx${++defsCounter}`
  ctx.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${parts.join('')}</filter>`)
  return ` filter="url(#${id})"`
}

async function fillElements(ctx: SvgCtx, node: SceneNode, d: string, fillRule: string): Promise<string> {
  let out = ''
  const visible = node.fills.filter((f) => f.visible)
  for (const paint of visible) {
    if (paint.type === 'IMAGE') {
      const href = await imageHref(ctx, paint.assetHash)
      if (!href) continue
      const clipId = `clip${++defsCounter}`
      ctx.defs.push(`<clipPath id="${clipId}"><path d="${d}"/></clipPath>`)
      out += `<image href="${href}" x="0" y="0" width="${num(node.width)}" height="${num(node.height)}" preserveAspectRatio="${paint.scaleMode === 'FIT' ? 'xMidYMid meet' : paint.scaleMode === 'FILL' ? 'xMidYMid slice' : 'none'}" clip-path="url(#${clipId})" opacity="${num(paint.opacity)}"/>`
    } else {
      const fill = paintToSvgFill(ctx, paint, node)
      if (fill) out += `<path d="${d}" fill="${fill}" fill-rule="${fillRule}"/>`
    }
  }
  return out
}

async function nodeToSvg(ctx: SvgCtx, id: NodeId, skipTransform = false): Promise<string> {
  const scene = ctx.scene
  const node = scene.getNode(id)
  if (!node || !node.visible) return ''
  const common = commonAttrs(node) + effectsFilter(ctx, node)
  const tf = skipTransform ? '' : transformAttr(node)

  if (node.type === 'GROUP') {
    let inner = ''
    for (const cid of node.children) inner += await nodeToSvg(ctx, cid)
    return `<g${tf}${common}>${inner}</g>`
  }

  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
    const d = subPathsToSvg(nodeOutline(node))
    let inner = await fillElements(ctx, node, d, 'nonzero')
    let clipAttr = ''
    if (node.clipsContent) {
      const clipId = `clip${++defsCounter}`
      ctx.defs.push(`<clipPath id="${clipId}"><path d="${d}"/></clipPath>`)
      clipAttr = ` clip-path="url(#${clipId})"`
    }
    let children = ''
    for (const cid of node.children) children += await nodeToSvg(ctx, cid)
    const stroke = strokeAttrs(ctx, node)
    const border = stroke ? `<path d="${d}" fill="none"${stroke}/>` : ''
    return `<g${tf}${common}><g${clipAttr}>${inner}${children}</g>${border}</g>`
  }

  if (node.type === 'BOOLEAN') {
    const rings = booleanRings(scene, node)
    if (rings.length === 0) return ''
    let d = ''
    for (const ring of rings) {
      if (ring.length < 3) continue
      d += `M ${ring.map((p) => `${num(p.x)} ${num(p.y)}`).join(' L ')} Z `
    }
    const fills = await fillElements(ctx, node, d.trim(), 'evenodd')
    const stroke = strokeAttrs(ctx, node)
    const border = stroke ? `<path d="${d.trim()}" fill="none"${stroke}/>` : ''
    return `<g${tf}${common}>${fills}${border}</g>`
  }

  if (node.type === 'TEXT') {
    return textToSvg(ctx, node, common, tf)
  }

  const d = subPathsToSvg(nodeOutline(node))
  if (!d) return ''
  const isOpen = node.type === 'LINE'
  const fillRule = node.type === 'VECTOR' && node.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero'
  const fills = isOpen ? '' : await fillElements(ctx, node, d, fillRule)
  const stroke = strokeAttrs(ctx, node)
  const border = stroke ? `<path d="${d}" fill="none"${stroke}/>` : ''
  return `<g${tf}${common}>${fills}${border}</g>`
}

function textToSvg(ctx: SvgCtx, node: TextNode, common: string, tf: string): string {
  const layout = layoutText(node)
  const paint = node.fills.find((f) => f.visible)
  const fill = paint && paint.type !== 'IMAGE' ? (paintToSvgFill(ctx, paint, node) ?? '#000') : '#000'
  const style = node.italic ? ' font-style="italic"' : ''
  const spacing = node.letterSpacing !== 0 ? ` letter-spacing="${num(node.letterSpacing)}"` : ''
  let spans = ''
  for (const line of layout.lines) {
    if (!line.text) continue
    spans += `<tspan x="${num(line.x)}" y="${num(line.baseline)}">${esc(line.text)}</tspan>`
  }
  return `<g${tf}${common}><text font-family="${esc(node.fontFamily)}" font-size="${num(node.fontSize)}" font-weight="${node.fontWeight}"${style}${spacing} fill="${fill}">${spans}</text></g>`
}

/**
 * Export the given root nodes as a standalone SVG document. Node transforms
 * are made relative to the union bounding box.
 */
export async function exportSvg(
  scene: SceneGraph,
  ids: NodeId[],
  fetchBytes: BytesFetcher,
): Promise<string> {
  defsCounter = 0
  const ctx: SvgCtx = { scene, defs: [], fetchBytes, imageCache: new Map() }
  let box = emptyAABB()
  for (const id of ids) {
    const b = scene.worldAABB(id)
    if (!aabbIsEmpty(b)) box = aabbIsEmpty(box) ? b : aabbUnion(box, b)
  }
  if (aabbIsEmpty(box)) box = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY

  const rank = scene.zRank()
  const sorted = [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  let body = ''
  for (const id of sorted) {
    const node = scene.getNode(id)
    if (!node) continue
    // Re-anchor top-level exported nodes relative to the export box by
    // temporarily offsetting via a wrapper group.
    const parentId = scene.parentOf(id)
    void parentId
    body += `<g transform="translate(${num(-box.minX)} ${num(-box.minY)})">${await nodeToSvgWorld(ctx, id)}</g>`
  }

  const defs = ctx.defs.length > 0 ? `<defs>${ctx.defs.join('')}</defs>` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}">${defs}${body}</svg>`
}

/** Render a node using its WORLD transform (used for top-level export roots). */
async function nodeToSvgWorld(ctx: SvgCtx, id: NodeId): Promise<string> {
  const scene = ctx.scene
  const node = scene.getNode(id)
  if (!node) return ''
  const m = scene.worldMatrix(id)
  const inner = await nodeToSvg(ctx, id, true)
  return `<g transform="matrix(${num(m.a)} ${num(m.b)} ${num(m.c)} ${num(m.d)} ${num(m.e)} ${num(m.f)})">${inner}</g>`
}

export function isExportableContainer(node: SceneNode): boolean {
  return isContainer(node)
}
