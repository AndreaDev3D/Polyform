// SVG import: parses an SVG document into native Polyform nodes.
// Paths/polygons become VECTOR nodes (full d-grammar incl. arcs); rects,
// circles, ellipses, lines and text map to native primitives. Transforms are
// baked into leaf geometry (rotation preserved where the model supports it).
// Unsupported paint servers (gradients/patterns via url()) fall back to gray.

import type { NodeBundle } from '../commands'
import type { RGBA, SceneNode, Vec2, VectorNetwork } from '../types'
import { createNode, isContainer, solid } from '../types'
import type { Mat } from '../geometry'
import { IDENTITY, applyMat, matMultiply, matRotateDeg, matTranslate } from '../geometry'
import { hexToRgba } from '../color'

export interface SvgImportResult {
  bundle: NodeBundle
  warnings: string[]
  /** viewBox (or width/height) of the source document. */
  viewBox: { x: number; y: number; w: number; h: number }
}

// ---------------------------------------------------------------------------
// Style context
// ---------------------------------------------------------------------------

interface StyleCtx {
  fill: RGBA | null | 'unsupported'
  stroke: RGBA | null
  strokeWidth: number
  opacity: number
  fillRule: 'NONZERO' | 'EVENODD'
}

const NAMED_COLORS: Record<string, string> = {
  black: '000000',
  white: 'ffffff',
  red: 'ff0000',
  green: '008000',
  blue: '0000ff',
  yellow: 'ffff00',
  orange: 'ffa500',
  purple: '800080',
  gray: '808080',
  grey: '808080',
  silver: 'c0c0c0',
  cyan: '00ffff',
  magenta: 'ff00ff',
  pink: 'ffc0cb',
  brown: 'a52a2a',
  transparent: '',
  none: '',
}

function parseColor(value: string | null, warnings: string[]): RGBA | null | 'unsupported' {
  if (!value) return undefined as unknown as null
  const v = value.trim().toLowerCase()
  if (v === 'none' || v === 'transparent') return null
  if (v.startsWith('url(')) {
    warnings.push(`Unsupported paint server: ${v.slice(0, 40)}`)
    return 'unsupported'
  }
  if (v.startsWith('#')) return hexToRgba(v) ?? null
  const rgbMatch = v.match(/^rgba?\(([^)]+)\)$/)
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat)
    if (parts.length >= 3) {
      return {
        r: Math.min(255, parts[0]) / 255,
        g: Math.min(255, parts[1]) / 255,
        b: Math.min(255, parts[2]) / 255,
        a: parts[3] !== undefined ? Math.min(1, parts[3]) : 1,
      }
    }
  }
  if (v in NAMED_COLORS) {
    const hex = NAMED_COLORS[v]
    return hex ? hexToRgba(`#${hex}`) : null
  }
  return hexToRgba(v) ?? null
}

function styleFromElement(el: Element, parent: StyleCtx, warnings: string[]): StyleCtx {
  const out: StyleCtx = { ...parent }
  const attrs = new Map<string, string>()
  for (const key of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'fill-rule']) {
    const v = el.getAttribute(key)
    if (v !== null) attrs.set(key, v)
  }
  const styleAttr = el.getAttribute('style')
  if (styleAttr) {
    for (const decl of styleAttr.split(';')) {
      const [k, v] = decl.split(':').map((s) => s?.trim())
      if (k && v) attrs.set(k, v)
    }
  }
  if (attrs.has('fill')) {
    const c = parseColor(attrs.get('fill')!, warnings)
    out.fill = c === ('unsupported' as const) ? 'unsupported' : c
  }
  if (attrs.has('stroke')) {
    const c = parseColor(attrs.get('stroke')!, warnings)
    out.stroke = c === 'unsupported' ? { r: 0, g: 0, b: 0, a: 1 } : c
  }
  if (attrs.has('stroke-width')) out.strokeWidth = parseFloat(attrs.get('stroke-width')!) || out.strokeWidth
  if (attrs.has('opacity')) out.opacity = out.opacity * (parseFloat(attrs.get('opacity')!) || 1)
  if (attrs.has('fill-opacity')) {
    const fo = parseFloat(attrs.get('fill-opacity')!) || 1
    if (out.fill && out.fill !== 'unsupported') out.fill = { ...out.fill, a: out.fill.a * fo }
  }
  if (attrs.has('fill-rule')) out.fillRule = attrs.get('fill-rule') === 'evenodd' ? 'EVENODD' : 'NONZERO'
  return out
}

function applyStyle(node: SceneNode, style: StyleCtx): void {
  if (style.fill === 'unsupported') {
    node.fills = [solid({ r: 0.6, g: 0.6, b: 0.6, a: 1 })]
  } else if (style.fill) {
    node.fills = [solid(style.fill)]
  } else {
    node.fills = []
  }
  if (style.stroke) {
    node.strokes = [solid(style.stroke)]
    node.strokeWeight = style.strokeWidth
    node.strokeAlign = 'CENTER'
  } else {
    node.strokes = []
  }
  node.opacity = Math.max(0, Math.min(1, style.opacity))
}

// ---------------------------------------------------------------------------
// Transform parsing
// ---------------------------------------------------------------------------

function parseTransform(value: string | null, warnings: string[]): Mat {
  if (!value) return { ...IDENTITY }
  let m = { ...IDENTITY }
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value))) {
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(parseFloat)
    let t: Mat = { ...IDENTITY }
    switch (match[1]) {
      case 'matrix':
        if (args.length === 6) t = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] }
        break
      case 'translate':
        t = matTranslate(args[0] || 0, args[1] || 0)
        break
      case 'scale':
        t = { a: args[0] ?? 1, b: 0, c: 0, d: args[1] ?? args[0] ?? 1, e: 0, f: 0 }
        break
      case 'rotate':
        if (args.length >= 3) {
          t = matMultiply(matTranslate(args[1], args[2]), matMultiply(matRotateDeg(args[0]), matTranslate(-args[1], -args[2])))
        } else {
          t = matRotateDeg(args[0] || 0)
        }
        break
      default:
        warnings.push(`Unsupported transform: ${match[1]}`)
        break
    }
    m = matMultiply(m, t)
  }
  return m
}

/** Decompose into translate/rotate/scale (skew is dropped with a warning). */
function decompose(m: Mat): { rotationDeg: number; scaleX: number; scaleY: number } {
  const scaleX = Math.hypot(m.a, m.b) || 1
  const det = m.a * m.d - m.b * m.c
  const scaleY = det / scaleX || 1
  const rotationDeg = (Math.atan2(m.b, m.a) * 180) / Math.PI
  return { rotationDeg, scaleX, scaleY }
}

// ---------------------------------------------------------------------------
// Path data parser -> vector network
// ---------------------------------------------------------------------------

function tokenizePath(d: string): (string | number)[] {
  const tokens: (string | number)[] = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(d))) {
    if (match[1]) tokens.push(match[1])
    else tokens.push(parseFloat(match[2]))
  }
  return tokens
}

/** Convert an SVG elliptical arc to cubic bezier segments. */
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, phiDeg: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): { c0: Vec2; c1: Vec2; p: Vec2 }[] {
  if (rx === 0 || ry === 0) return [{ c0: { x: x1, y: y1 }, c1: { x: x2, y: y2 }, p: { x: x2, y: y2 } }]
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const phi = (phiDeg * Math.PI) / 180
  const cosP = Math.cos(phi)
  const sinP = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  const sign = largeArc !== sweep ? 1 : -1
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coef = sign * Math.sqrt(Math.max(0, num / den))
  const cxp = (coef * (rx * y1p)) / ry
  const cyp = (coef * (-ry * x1p)) / rx
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let ang = Math.acos(Math.max(-1, Math.min(1, dot / len)))
    if (ux * vy - uy * vx < 0) ang = -ang
    return ang
  }
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI

  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)))
  const out: { c0: Vec2; c1: Vec2; p: Vec2 }[] = []
  const delta = dTheta / segments
  const k = ((4 / 3) * Math.tan(delta / 4))
  let t = theta1
  for (let i = 0; i < segments; i++) {
    const cos1 = Math.cos(t)
    const sin1 = Math.sin(t)
    const cos2 = Math.cos(t + delta)
    const sin2 = Math.sin(t + delta)
    const toWorld = (px: number, py: number): Vec2 => ({
      x: cosP * px * rx - sinP * py * ry + cx,
      y: sinP * px * rx + cosP * py * ry + cy,
    })
    const p1 = toWorld(cos1, sin1)
    const p2 = toWorld(cos2, sin2)
    const d1 = { x: -sin1 * k, y: cos1 * k }
    const d2 = { x: sin2 * k, y: -cos2 * k }
    const c0 = toWorld(cos1 + d1.x, sin1 + d1.y)
    const c1 = toWorld(cos2 + d2.x, sin2 + d2.y)
    void p1
    out.push({ c0, c1, p: p2 })
    t += delta
  }
  return out
}

/** Parse SVG path data into a vector network with coordinates mapped by `m`. */
export function parsePathData(d: string, m: Mat): VectorNetwork {
  const net: VectorNetwork = { vertices: [], edges: [] }
  const tokens = tokenizePath(d)
  let i = 0
  let vid = 0
  let eid = 0
  let cur: Vec2 = { x: 0, y: 0 }
  let subStartVid = -1
  let curVid = -1
  let lastCmd = ''
  let lastCubicCp: Vec2 | null = null
  let lastQuadCp: Vec2 | null = null

  const num = () => {
    const t = tokens[i++]
    return typeof t === 'number' ? t : 0
  }
  const peekNum = () => typeof tokens[i] === 'number'

  const addVertex = (p: Vec2): number => {
    const world = applyMat(m, p)
    net.vertices.push({ id: vid, x: world.x, y: world.y })
    return vid++
  }
  const addEdge = (v0: number, v1: number, cp0: Vec2 | null, cp1: Vec2 | null) => {
    net.edges.push({
      id: eid++,
      v0,
      v1,
      cp0: cp0 ? applyMat(m, cp0) : null,
      cp1: cp1 ? applyMat(m, cp1) : null,
    })
  }
  const lineTo = (p: Vec2) => {
    if (curVid < 0) return
    const nv = addVertex(p)
    addEdge(curVid, nv, null, null)
    curVid = nv
    cur = p
  }
  const cubicTo = (c0: Vec2, c1: Vec2, p: Vec2) => {
    if (curVid < 0) return
    const nv = addVertex(p)
    addEdge(curVid, nv, c0, c1)
    curVid = nv
    cur = p
    lastCubicCp = c1
  }

  while (i < tokens.length) {
    let cmd = tokens[i]
    if (typeof cmd === 'number') {
      // Implicit command repetition.
      cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd
    } else {
      i++
    }
    const rel = typeof cmd === 'string' && cmd === cmd.toLowerCase() && cmd !== 'z'
    const abs = (p: Vec2): Vec2 => (rel ? { x: cur.x + p.x, y: cur.y + p.y } : p)
    const C = String(cmd).toUpperCase()

    switch (C) {
      case 'M': {
        const p = abs({ x: num(), y: num() })
        curVid = addVertex(p)
        subStartVid = curVid
        cur = p
        lastCmd = rel ? 'm' : 'M'
        while (peekNum()) {
          lineTo(abs({ x: num(), y: num() }))
          lastCmd = rel ? 'l' : 'L'
        }
        break
      }
      case 'L':
        do lineTo(abs({ x: num(), y: num() }))
        while (peekNum())
        break
      case 'H':
        do lineTo({ x: rel ? cur.x + num() : num(), y: cur.y })
        while (peekNum())
        break
      case 'V':
        do lineTo({ x: cur.x, y: rel ? cur.y + num() : num() })
        while (peekNum())
        break
      case 'C':
        do {
          const c0 = abs({ x: num(), y: num() })
          const c1 = abs({ x: num(), y: num() })
          const p = abs({ x: num(), y: num() })
          cubicTo(c0, c1, p)
        } while (peekNum())
        break
      case 'S':
        do {
          // Cast defeats TS narrowing (lastCubicCp is assigned inside cubicTo).
          const prevC = lastCubicCp as Vec2 | null
          const c0: Vec2 = prevC && 'CS'.includes(lastCmd.toUpperCase())
            ? { x: 2 * cur.x - prevC.x, y: 2 * cur.y - prevC.y }
            : { ...cur }
          const c1 = abs({ x: num(), y: num() })
          const p = abs({ x: num(), y: num() })
          cubicTo(c0, c1, p)
          lastCmd = rel ? 's' : 'S'
        } while (peekNum())
        break
      case 'Q':
        do {
          const q = abs({ x: num(), y: num() })
          const p = abs({ x: num(), y: num() })
          const c0 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) }
          const c1 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }
          cubicTo(c0, c1, p)
          lastQuadCp = q
        } while (peekNum())
        break
      case 'T':
        do {
          const prevQ = lastQuadCp as Vec2 | null
          const q: Vec2 = prevQ && 'QT'.includes(lastCmd.toUpperCase())
            ? { x: 2 * cur.x - prevQ.x, y: 2 * cur.y - prevQ.y }
            : { ...cur }
          const p = abs({ x: num(), y: num() })
          const c0 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) }
          const c1 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }
          cubicTo(c0, c1, p)
          lastQuadCp = q
          lastCmd = rel ? 't' : 'T'
        } while (peekNum())
        break
      case 'A':
        do {
          const rx = num()
          const ry = num()
          const rot = num()
          const large = num() !== 0
          const sweep = num() !== 0
          const p = abs({ x: num(), y: num() })
          for (const seg of arcToCubics(cur.x, cur.y, rx, ry, rot, large, sweep, p.x, p.y)) {
            cubicTo(seg.c0, seg.c1, seg.p)
          }
        } while (peekNum())
        break
      case 'Z': {
        if (curVid >= 0 && subStartVid >= 0 && curVid !== subStartVid) {
          addEdge(curVid, subStartVid, null, null)
        }
        curVid = subStartVid
        const sv = net.vertices.find((v) => v.id === subStartVid)
        if (sv) {
          const inv = cur // keep local coordinate bookkeeping simple: cur stays
          void inv
        }
        break
      }
      default:
        // Unknown command: bail out of this token.
        break
    }
    if (typeof cmd === 'string' && C !== 'S' && C !== 'T' && C !== 'M') lastCmd = cmd
    if (C !== 'C' && C !== 'S') lastCubicCp = null
    if (C !== 'Q' && C !== 'T') lastQuadCp = null
  }
  return net
}

// ---------------------------------------------------------------------------
// Element walkers
// ---------------------------------------------------------------------------

interface ImportCtx {
  bundle: NodeBundle
  warnings: string[]
}

function makeVectorNode(net: VectorNetwork, style: StyleCtx, name: string): SceneNode | null {
  if (net.vertices.length === 0) return null
  const xs: number[] = net.vertices.map((v) => v.x)
  const ys: number[] = net.vertices.map((v) => v.y)
  for (const e of net.edges) {
    if (e.cp0) {
      xs.push(e.cp0.x)
      ys.push(e.cp0.y)
    }
    if (e.cp1) {
      xs.push(e.cp1.x)
      ys.push(e.cp1.y)
    }
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const node = createNode('VECTOR', name)
  if (node.type !== 'VECTOR') return null
  for (const v of net.vertices) {
    v.x -= minX
    v.y -= minY
  }
  for (const e of net.edges) {
    if (e.cp0) e.cp0 = { x: e.cp0.x - minX, y: e.cp0.y - minY }
    if (e.cp1) e.cp1 = { x: e.cp1.x - minX, y: e.cp1.y - minY }
  }
  node.network = net
  node.windingRule = style.fillRule
  node.x = minX
  node.y = minY
  node.width = Math.max(1, Math.max(...xs) - minX)
  node.height = Math.max(1, Math.max(...ys) - minY)
  applyStyle(node, style)
  return node
}

function importElement(ctx: ImportCtx, el: Element, parentMat: Mat, parentStyle: StyleCtx): SceneNode[] {
  const tag = el.tagName.toLowerCase()
  if (['defs', 'symbol', 'clippath', 'mask', 'metadata', 'title', 'desc', 'style'].includes(tag)) return []
  const style = styleFromElement(el, parentStyle, ctx.warnings)
  const m = matMultiply(parentMat, parseTransform(el.getAttribute('transform'), ctx.warnings))
  const attr = (name: string, def = 0) => {
    const v = el.getAttribute(name)
    return v === null ? def : parseFloat(v) || def
  }

  switch (tag) {
    case 'svg':
    case 'g':
    case 'a': {
      const children: SceneNode[] = []
      for (const child of Array.from(el.children)) {
        children.push(...importElement(ctx, child, m, style))
      }
      if (tag === 'g' && children.length > 1) {
        const group = createNode('GROUP', el.getAttribute('id') || 'Group')
        if (group.type === 'GROUP') {
          group.x = 0
          group.y = 0
          group.children = children.map((c) => c.id)
          for (const c of children) ctx.bundle.nodes[c.id] = c
          return [group]
        }
      }
      return children
    }
    case 'rect': {
      const { rotationDeg, scaleX, scaleY } = decompose(m)
      const w = attr('width') * Math.abs(scaleX)
      const h = attr('height') * Math.abs(scaleY)
      if (w <= 0 || h <= 0) return []
      const node = createNode('RECTANGLE', el.getAttribute('id') || 'Rectangle')
      if (node.type !== 'RECTANGLE') return []
      const rx = attr('rx', attr('ry')) * Math.abs(scaleX)
      node.cornerRadius = { tl: rx, tr: rx, br: rx, bl: rx }
      const center = applyMat(m, { x: attr('x') + attr('width') / 2, y: attr('y') + attr('height') / 2 })
      node.width = w
      node.height = h
      node.rotation = rotationDeg
      node.x = center.x - w / 2
      node.y = center.y - h / 2
      applyStyle(node, style)
      return [node]
    }
    case 'circle':
    case 'ellipse': {
      const { rotationDeg, scaleX, scaleY } = decompose(m)
      const rx = (tag === 'circle' ? attr('r') : attr('rx')) * Math.abs(scaleX)
      const ry = (tag === 'circle' ? attr('r') : attr('ry')) * Math.abs(scaleY)
      if (rx <= 0 || ry <= 0) return []
      const node = createNode('ELLIPSE', el.getAttribute('id') || 'Ellipse')
      if (node.type !== 'ELLIPSE') return []
      const center = applyMat(m, { x: attr('cx'), y: attr('cy') })
      node.width = rx * 2
      node.height = ry * 2
      node.rotation = rotationDeg
      node.x = center.x - rx
      node.y = center.y - ry
      applyStyle(node, style)
      return [node]
    }
    case 'line': {
      const p1 = applyMat(m, { x: attr('x1'), y: attr('y1') })
      const p2 = applyMat(m, { x: attr('x2'), y: attr('y2') })
      const node = createNode('LINE', el.getAttribute('id') || 'Line')
      if (node.type !== 'LINE') return []
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      const angle = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI
      node.width = Math.max(0.01, len)
      node.rotation = angle
      const cx = (p1.x + p2.x) / 2
      const cy = (p1.y + p2.y) / 2
      node.x = cx - node.width / 2
      node.y = cy
      applyStyle(node, style)
      if (node.strokes.length === 0 && style.fill && style.fill !== 'unsupported') {
        node.strokes = [solid(style.fill)]
      }
      node.fills = []
      return [node]
    }
    case 'polygon':
    case 'polyline': {
      const raw = (el.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(parseFloat)
      const net: VectorNetwork = { vertices: [], edges: [] }
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const p = applyMat(m, { x: raw[i], y: raw[i + 1] })
        net.vertices.push({ id: i / 2, x: p.x, y: p.y })
      }
      const n = net.vertices.length
      for (let i = 0; i < n - 1; i++) net.edges.push({ id: i, v0: i, v1: i + 1, cp0: null, cp1: null })
      if (tag === 'polygon' && n > 2) net.edges.push({ id: n - 1, v0: n - 1, v1: 0, cp0: null, cp1: null })
      const node = makeVectorNode(net, style, el.getAttribute('id') || (tag === 'polygon' ? 'Polygon' : 'Polyline'))
      return node ? [node] : []
    }
    case 'path': {
      const d = el.getAttribute('d')
      if (!d) return []
      const net = parsePathData(d, m)
      const node = makeVectorNode(net, style, el.getAttribute('id') || 'Path')
      return node ? [node] : []
    }
    case 'text': {
      const node = createNode('TEXT', el.getAttribute('id') || 'Text')
      if (node.type !== 'TEXT') return []
      const { scaleX } = decompose(m)
      const fontSize = (parseFloat(el.getAttribute('font-size') ?? '') || 16) * Math.abs(scaleX)
      const p = applyMat(m, { x: attr('x'), y: attr('y') })
      node.characters = (el.textContent ?? '').trim()
      if (!node.characters) return []
      node.fontSize = fontSize
      node.fontFamily = el.getAttribute('font-family')?.split(',')[0]?.replace(/["']/g, '').trim() || 'Segoe UI'
      node.x = p.x
      node.y = p.y - fontSize * 0.8 // baseline -> top approximation
      const fill = style.fill
      node.fills = fill && fill !== 'unsupported' ? [solid(fill)] : node.fills
      return [node]
    }
    default:
      if (el.children.length > 0) {
        const out: SceneNode[] = []
        for (const child of Array.from(el.children)) out.push(...importElement(ctx, child, m, style))
        return out
      }
      ctx.warnings.push(`Skipped <${tag}>`)
      return []
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function importSvgDocument(text: string, fileName: string): SvgImportResult | null {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = parsed.querySelector('svg')
  if (!svg || parsed.querySelector('parsererror')) return null

  const warnings: string[] = []
  const bundle: NodeBundle = { nodes: {}, rootIds: [] }
  const ctx: ImportCtx = { bundle, warnings }

  const baseStyle: StyleCtx = {
    fill: { r: 0, g: 0, b: 0, a: 1 },
    stroke: null,
    strokeWidth: 1,
    opacity: 1,
    fillRule: 'NONZERO',
  }
  const roots = importElement(ctx, svg, IDENTITY, baseStyle)
  if (roots.length === 0) return null

  let rootNodes: SceneNode[]
  if (roots.length === 1) {
    rootNodes = roots
  } else {
    const group = createNode('GROUP', fileName.replace(/\.svg$/i, ''))
    if (group.type === 'GROUP') {
      group.children = roots.map((r) => r.id)
      for (const r of roots) bundle.nodes[r.id] = r
      rootNodes = [group]
    } else {
      rootNodes = roots
    }
  }
  for (const r of rootNodes) bundle.nodes[r.id] = r
  bundle.rootIds = rootNodes.map((r) => r.id)
  // Register any nested children that were only added to their parents.
  const registerTree = (id: string) => {
    const node = bundle.nodes[id]
    if (node && isContainer(node)) {
      for (const cid of node.children) {
        if (bundle.nodes[cid]) registerTree(cid)
      }
    }
  }
  for (const rid of bundle.rootIds) registerTree(rid)

  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(parseFloat)
  const viewBox =
    vb.length === 4
      ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }
      : { x: 0, y: 0, w: parseFloat(svg.getAttribute('width') ?? '') || 100, h: parseFloat(svg.getAttribute('height') ?? '') || 100 }

  return { bundle, warnings, viewBox }
}
