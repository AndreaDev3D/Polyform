// From a decoded `.fig` to Polyform nodes.
//
// Two ideas carry this file.
//
// 1. THE TREE IS NOT IN THE FILE. `nodeChanges` is the flat change stream Figma's
//    collaborative engine syncs, so the hierarchy has to be rebuilt: index every
//    node by its GUID, attach each to `parentGuid`, and order siblings by
//    `parentIndex.position` — a *fractional index* (an ordering string), which is
//    how a CRDT inserts between two peers without renumbering. Sorting those
//    strings lexicographically reproduces the layer order you saw in Figma; using
//    array order instead reproduces the order edits happened to be made in.
//
// 2. SHAPE COMES FROM THEIR FLATTENED GEOMETRY, not from guessing at their
//    editable vector network. Every shape node carries `fillGeometry` in
//    node-local coordinates, which is the space our VectorNetwork uses too. So a
//    boolean operation, a star, a rounded rectangle with independent corners, an
//    arc, a glyph outline — anything — arrives looking right, as an editable path.
//    Where a *native* type is an exact fit (rectangle, ellipse, line, text,
//    frame) we use it instead, because a rectangle you can still set a corner
//    radius on is worth more than a four-point path.
//
// Everything it cannot carry is COUNTED and REPORTED rather than dropped
// silently: an importer that quietly loses half a file is worse than one that
// says what it left behind.

import { createNode, rgba, type BlendMode, type Effect, type NodeId, type Paint, type SceneNode } from '../../types'
import type { NodeBundle } from '../../commands'
import type { KiwiObject } from '../../../../../shared/fig/kiwi'
import { networkFromPaths, parsePathCommands, windingRuleFrom, type ParsedGeometry } from './geometry'

export interface FigImportResult {
  bundle: NodeBundle
  /** Bounding box of everything imported, in the coordinates the file used. */
  bounds: { x: number; y: number; w: number; h: number }
  /** Human-readable, deduplicated, counted — shown after the import. */
  report: FigImportReport
}

export interface FigImportReport {
  pages: number
  nodesRead: number
  nodesCreated: number
  /** `type → count` for nodes that produced nothing. */
  skipped: Record<string, number>
  /** Things that came in with less fidelity than the original. */
  approximations: Record<string, number>
  images: number
}

interface Ctx {
  bundle: NodeBundle
  blobs: Uint8Array[]
  report: FigImportReport
  /** Image hash (theirs) → asset hash (ours), filled in by the caller. */
  imageMap: Map<string, string>
}

const note = (bag: Record<string, number>, key: string, n = 1): void => {
  bag[key] = (bag[key] ?? 0) + n
}

let idCounter = 0
/** Import-local ids; the command layer rewrites them if they ever collide. */
function newId(): NodeId {
  idCounter += 1
  return `fig${Date.now().toString(36)}${idCounter.toString(36)}`
}

// ---------------------------------------------------------------------------
// GUIDs and ordering
// ---------------------------------------------------------------------------

interface FigNode {
  raw: KiwiObject
  guid: string
  parent: string | null
  /** Fractional index — an ordering STRING, not a number. */
  position: string
  children: FigNode[]
}

function guidOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const g = value as { sessionID?: number; localID?: number }
  if (typeof g.sessionID !== 'number' || typeof g.localID !== 'number') return null
  return `${g.sessionID}:${g.localID}`
}

/** Rebuild the tree the flat change list describes. */
export function buildFigTree(nodeChanges: KiwiObject[]): FigNode[] {
  const byGuid = new Map<string, FigNode>()
  const all: FigNode[] = []
  for (const raw of nodeChanges) {
    const guid = guidOf(raw.guid)
    if (!guid) continue
    const parentIndex = raw.parentIndex as { guid?: unknown; position?: unknown } | undefined
    const node: FigNode = {
      raw,
      guid,
      parent: parentIndex ? guidOf(parentIndex.guid) : null,
      position: typeof parentIndex?.position === 'string' ? parentIndex.position : '',
      children: [],
    }
    byGuid.set(guid, node)
    all.push(node)
  }
  const roots: FigNode[] = []
  for (const node of all) {
    const parent = node.parent ? byGuid.get(node.parent) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  // Lexicographic on the fractional index: that IS the layer order.
  const sortDeep = (list: FigNode[]): void => {
    list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    for (const n of list) sortDeep(n.children)
  }
  sortDeep(roots)
  return roots
}

// ---------------------------------------------------------------------------
// Paints, effects, transforms
// ---------------------------------------------------------------------------

const BLEND_MODES = new Set<string>([
  'NORMAL',
  'MULTIPLY',
  'SCREEN',
  'OVERLAY',
  'DARKEN',
  'LIGHTEN',
  'COLOR_DODGE',
  'COLOR_BURN',
  'HARD_LIGHT',
  'SOFT_LIGHT',
  'DIFFERENCE',
  'EXCLUSION',
  'HUE',
  'SATURATION',
  'COLOR',
  'LUMINOSITY',
])

function blendModeFrom(value: unknown, report: FigImportReport): BlendMode {
  const name = String(value ?? 'NORMAL')
  if (BLEND_MODES.has(name)) return name as BlendMode
  if (name !== 'PASS_THROUGH') note(report.approximations, `blend mode ${name} → Normal`)
  return 'NORMAL'
}

/**
 * An image fill points at its bitmap by SHA-1, stored as 20 BYTES; the ZIP entry
 * is named with the hex of those bytes. Reading the array as a string would give
 * `92,212,91,…` and match nothing, which is the kind of mismatch that shows up as
 * "the picture did not come through" rather than as an error.
 */
export function figImageHash(value: unknown): string {
  const hex = (bytes: Iterable<number>) =>
    [...bytes].map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('')
  if (value instanceof Uint8Array) return hex(value)
  if (Array.isArray(value)) return hex(value as number[])
  if (typeof value === 'string') {
    // Already hex (40 chars, hex alphabet), or Kiwi bytes that arrived as a string.
    if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase()
    return hex([...value].map((c) => c.charCodeAt(0)))
  }
  return ''
}

function colorFrom(value: unknown): { r: number; g: number; b: number; a: number } {
  const c = (value ?? {}) as { r?: number; g?: number; b?: number; a?: number }
  return rgba(c.r ?? 0, c.g ?? 0, c.b ?? 0, c.a ?? 1)
}

function paintsFrom(list: unknown, ctx: Ctx): Paint[] {
  if (!Array.isArray(list)) return []
  const out: Paint[] = []
  for (const entry of list as KiwiObject[]) {
    const type = String(entry.type ?? 'SOLID')
    const visible = entry.visible !== false
    const opacity = typeof entry.opacity === 'number' ? entry.opacity : 1
    if (type === 'SOLID') {
      out.push({ type: 'SOLID', visible, opacity, color: colorFrom(entry.color) })
      continue
    }
    if (type === 'GRADIENT_LINEAR' || type === 'GRADIENT_RADIAL' || type === 'GRADIENT_ANGULAR' || type === 'GRADIENT_DIAMOND') {
      const stops = Array.isArray(entry.stops)
        ? (entry.stops as KiwiObject[]).map((s) => ({
            position: typeof s.position === 'number' ? s.position : 0,
            color: colorFrom(s.color),
          }))
        : []
      // Angular and diamond have no equivalent here; the nearest honest thing is
      // the gradient we do have, said out loud.
      const kind = type === 'GRADIENT_RADIAL' || type === 'GRADIENT_DIAMOND' ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR'
      if (kind !== type) note(ctx.report.approximations, `${type} → ${kind}`)
      out.push({
        type: kind,
        visible,
        opacity,
        stops: stops.length > 0 ? stops : [
          { position: 0, color: rgba(0, 0, 0, 1) },
          { position: 1, color: rgba(1, 1, 1, 1) },
        ],
        // Figma stores a gradient as a transform; ours stores handles. A vertical
        // sweep is the neutral reading, and the note says the angle was lost.
        start: { x: 0.5, y: 0 },
        end: { x: 0.5, y: 1 },
      })
      if (entry.transform) note(ctx.report.approximations, 'gradient angle/scale reset to vertical')
      continue
    }
    if (type === 'IMAGE') {
      const hash = figImageHash((entry.image as KiwiObject | undefined)?.hash ?? entry.imageHash)
      const asset = ctx.imageMap.get(hash)
      if (asset) {
        out.push({
          type: 'IMAGE',
          visible,
          opacity,
          assetHash: asset,
          scaleMode: String(entry.imageScaleMode ?? 'FILL') === 'FIT' ? 'FIT' : String(entry.imageScaleMode ?? 'FILL') === 'TILE' ? 'TILE' : String(entry.imageScaleMode ?? 'FILL') === 'STRETCH' ? 'STRETCH' : 'FILL',
        })
      } else {
        note(ctx.report.skipped, 'image fill whose bitmap was not in the archive')
      }
      continue
    }
    note(ctx.report.skipped, `${type} paint`)
  }
  return out
}

function effectsFrom(list: unknown, report: FigImportReport): Effect[] {
  if (!Array.isArray(list)) return []
  const out: Effect[] = []
  for (const entry of list as KiwiObject[]) {
    const type = String(entry.type ?? '')
    const visible = entry.visible !== false
    const radius = typeof entry.radius === 'number' ? entry.radius : 0
    const offset = (entry.offset ?? {}) as { x?: number; y?: number }
    switch (type) {
      case 'DROP_SHADOW':
      case 'INNER_SHADOW':
        out.push({
          type: type === 'DROP_SHADOW' ? 'DROP_SHADOW' : 'INNER_SHADOW',
          visible,
          color: colorFrom(entry.color),
          offset: { x: offset.x ?? 0, y: offset.y ?? 0 },
          blur: radius,
        })
        break
      case 'FOREGROUND_BLUR':
      case 'LAYER_BLUR':
        out.push({ type: 'LAYER_BLUR', visible, radius })
        break
      case 'BACKGROUND_BLUR':
        out.push({ type: 'BACKGROUND_BLUR', visible, radius })
        break
      default:
        note(report.skipped, `${type || 'unnamed'} effect`)
    }
  }
  return out
}

/**
 * Figma keeps a 2×3 affine and the size separately, so in practice the matrix is
 * translation + rotation. Anything else (skew, mirrored scale) cannot be
 * expressed by x/y/rotation and is reported rather than silently flattened.
 */
function transformFrom(raw: KiwiObject, report: FigImportReport): { x: number; y: number; rotation: number } {
  const t = raw.transform as { m00?: number; m01?: number; m02?: number; m10?: number; m11?: number; m12?: number } | undefined
  if (!t) return { x: 0, y: 0, rotation: 0 }
  const m00 = t.m00 ?? 1
  const m01 = t.m01 ?? 0
  const m10 = t.m10 ?? 0
  const m11 = t.m11 ?? 1
  const rotation = (Math.atan2(m10, m00) * 180) / Math.PI
  // A pure rotation has m00 = m11 and m01 = -m10, up to float noise.
  const skewed = Math.abs(m00 - m11) > 1e-3 || Math.abs(m01 + m10) > 1e-3
  if (skewed) note(report.approximations, 'skew or non-uniform scale reduced to rotation')
  return { x: t.m02 ?? 0, y: t.m12 ?? 0, rotation: Math.abs(rotation) < 1e-6 ? 0 : rotation }
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function geometryOf(raw: KiwiObject, ctx: Ctx): ParsedGeometry[] {
  // Fill geometry first, stroke geometry as the fallback: an open path — a
  // signature, an arrow, a drawn line — has NO fill geometry at all, and reading
  // only `fillGeometry` silently dropped nine such nodes per file. The stroke
  // outline is the shape in that case.
  const paths = Array.isArray(raw.fillGeometry) && (raw.fillGeometry as unknown[]).length > 0 ? raw.fillGeometry : raw.strokeGeometry
  if (!Array.isArray(paths) || paths.length === 0) return []
  const out: ParsedGeometry[] = []
  for (const p of paths as KiwiObject[]) {
    const idx = typeof p.commandsBlob === 'number' ? p.commandsBlob : -1
    const blob = ctx.blobs[idx]
    if (!blob) continue
    try {
      const parsed = parsePathCommands(blob)
      if (parsed.usedInferredOp) note(ctx.report.approximations, 'quadratic curve (op 0x03, never seen in a real file) promoted to cubic')
      out.push(parsed)
    } catch (err) {
      note(ctx.report.skipped, `unreadable path geometry (${err instanceof Error ? err.message : 'error'})`)
    }
  }
  return out
}

const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'CANVAS', 'DOCUMENT', 'SECTION', 'COMPONENT_SET'])

function cornerRadiiOf(raw: KiwiObject): { tl: number; tr: number; br: number; bl: number } {
  const uniform = typeof raw.cornerRadius === 'number' ? raw.cornerRadius : 0
  const tl = typeof raw.rectangleTopLeftCornerRadius === 'number' ? raw.rectangleTopLeftCornerRadius : uniform
  const tr = typeof raw.rectangleTopRightCornerRadius === 'number' ? raw.rectangleTopRightCornerRadius : uniform
  const br = typeof raw.rectangleBottomRightCornerRadius === 'number' ? raw.rectangleBottomRightCornerRadius : uniform
  const bl = typeof raw.rectangleBottomLeftCornerRadius === 'number' ? raw.rectangleBottomLeftCornerRadius : uniform
  return { tl, tr, br, bl }
}

/** One Figma node → one of ours (or null when there is nothing to make). */
function mapNode(fig: FigNode, ctx: Ctx): SceneNode | null {
  const raw = fig.raw
  const figType = String(raw.type ?? '')
  const name = String(raw.name ?? figType.toLowerCase())
  const size = (raw.size ?? {}) as { x?: number; y?: number }
  const width = Math.max(0, size.x ?? 0)
  const height = Math.max(0, size.y ?? 0)
  const { x, y, rotation } = transformFrom(raw, ctx.report)

  const finish = (node: SceneNode): SceneNode => {
    node.name = name
    node.x = x
    node.y = y
    node.rotation = rotation
    node.visible = raw.visible !== false
    node.locked = raw.locked === true
    node.opacity = typeof raw.opacity === 'number' ? raw.opacity : 1
    node.blendMode = blendModeFrom(raw.blendMode, ctx.report)
    if (node.type !== 'GROUP') {
      const fills = paintsFrom(raw.fillPaints, ctx)
      const strokes = paintsFrom(raw.strokePaints, ctx)
      node.fills = fills
      node.strokes = strokes
      if (typeof raw.strokeWeight === 'number') node.strokeWeight = raw.strokeWeight
      const align = String(raw.strokeAlign ?? 'INSIDE')
      node.strokeAlign = align === 'CENTER' ? 'CENTER' : align === 'OUTSIDE' ? 'OUTSIDE' : 'INSIDE'
      if (Array.isArray(raw.dashPattern) && raw.dashPattern.length > 0) {
        node.strokeDash = (raw.dashPattern as number[]).filter((n) => typeof n === 'number')
      }
    }
    node.effects = effectsFrom(raw.effects, ctx.report)
    if (node.type === 'FRAME' || node.type === 'GROUP') {
      // Auto layout is a frame concern; a group cannot hold one here.
      if (node.type === 'FRAME' && raw.stackMode && String(raw.stackMode) !== 'NONE') {
        note(ctx.report.approximations, 'auto layout imported as fixed positions')
      }
    }
    if (node.width === 100 && node.height === 100 && width === 0 && height === 0) {
      // A container with no size of its own: let it be as big as its content.
      node.width = 0
      node.height = 0
    }
    return node
  }

  // Containers keep the hierarchy, which is most of what a design IS.
  if (CONTAINER_TYPES.has(figType)) {
    const isGroup = figType === 'GROUP'
    const node = createNode(isGroup ? 'GROUP' : 'FRAME', name)
    node.width = width
    node.height = height
    if (node.type === 'FRAME') {
      node.clipsContent = raw.frameMaskDisabled !== true
      node.cornerRadius = cornerRadiiOf(raw)
      // A frame with no fill in Figma is transparent; createNode gives it white.
      node.fills = paintsFrom(raw.fillPaints, ctx)
    }
    return finish(node)
  }

  if (figType === 'TEXT') {
    const node = createNode('TEXT', name)
    if (node.type !== 'TEXT') return null
    const text = (raw.textData ?? {}) as KiwiObject
    node.characters = String(text.characters ?? '')
    node.width = width
    node.height = height
    const fontName = (raw.fontName ?? {}) as { family?: string; style?: string }
    if (fontName.family) node.fontFamily = String(fontName.family)
    if (typeof raw.fontSize === 'number') node.fontSize = raw.fontSize
    const style = String(fontName.style ?? '')
    if (/italic/i.test(style)) node.italic = true
    const weightFromStyle = /thin/i.test(style)
      ? 100
      : /extralight|ultralight/i.test(style)
        ? 200
        : /light/i.test(style)
          ? 300
          : /medium/i.test(style)
            ? 500
            : /semibold|demibold/i.test(style)
              ? 600
              : /extrabold|ultrabold/i.test(style)
                ? 800
                : /black|heavy/i.test(style)
                  ? 900
                  : /bold/i.test(style)
                    ? 700
                    : 400
    node.fontWeight = weightFromStyle
    const align = String(raw.textAlignHorizontal ?? 'LEFT')
    node.textAlignH = align === 'CENTER' ? 'CENTER' : align === 'RIGHT' ? 'RIGHT' : 'LEFT'
    const valign = String(raw.textAlignVertical ?? 'TOP')
    node.textAlignV = valign === 'CENTER' ? 'CENTER' : valign === 'BOTTOM' ? 'BOTTOM' : 'TOP'
    node.autoResize = 'NONE'
    if (Array.isArray(text.characterStyleIDs) && (text.characterStyleIDs as number[]).some((v) => v !== 0)) {
      note(ctx.report.approximations, 'mixed text styles flattened to one style per text node')
    }
    // Their line breaks came from their shaper; ours come from rustybuzz, so the
    // wrapping can differ even when every glyph matches.
    if (node.characters.length > 0) note(ctx.report.approximations, 'text re-shaped by this engine (line breaks may differ)')
    return finish(node)
  }

  // Native primitives where the fit is exact: worth more than a path, because
  // they stay parametric.
  if (figType === 'ROUNDED_RECTANGLE' || figType === 'RECTANGLE') {
    const node = createNode('RECTANGLE', name)
    if (node.type !== 'RECTANGLE') return null
    node.width = width
    node.height = height
    node.cornerRadius = cornerRadiiOf(raw)
    return finish(node)
  }
  if (figType === 'ELLIPSE' && !raw.arcData) {
    const node = createNode('ELLIPSE', name)
    node.width = width
    node.height = height
    return finish(node)
  }
  if (figType === 'LINE') {
    const node = createNode('LINE', name)
    node.width = width
    node.height = 0
    return finish(node)
  }

  // Everything else that has geometry: VECTOR, BOOLEAN_OPERATION, STAR,
  // REGULAR_POLYGON, an ellipse with an arc, a flattened glyph. Their own
  // flattened path is the faithful answer and it stays editable here.
  const geometry = geometryOf(raw, ctx)
  if (geometry.length > 0) {
    const node = createNode('VECTOR', name)
    if (node.type !== 'VECTOR') return null
    node.network = networkFromPaths(geometry)
    const usedPaths = (Array.isArray(raw.fillGeometry) && (raw.fillGeometry as unknown[]).length > 0
      ? raw.fillGeometry
      : raw.strokeGeometry) as KiwiObject[] | undefined
    node.windingRule = windingRuleFrom(usedPaths?.[0]?.windingRule)
    // A shape that only had stroke geometry is an OPEN path: it has no fill in
    // Figma either, so carrying one over would fill a signature solid black.
    const strokeOnly = !(Array.isArray(raw.fillGeometry) && (raw.fillGeometry as unknown[]).length > 0)
    if (strokeOnly) note(ctx.report.approximations, 'open path imported from its stroke outline')
    node.width = width
    node.height = height
    if (figType === 'BOOLEAN_OPERATION') {
      note(ctx.report.approximations, 'boolean operation flattened to a path (operands not preserved)')
    } else if (figType !== 'VECTOR') {
      note(ctx.report.approximations, `${figType} imported as an editable path`)
    }
    const done = finish(node)
    if (strokeOnly) done.fills = []
    return done
  }

  note(ctx.report.skipped, figType || 'node with no type')
  return null
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

function walk(fig: FigNode, ctx: Ctx): NodeId[] {
  ctx.report.nodesRead += 1
  const figType = String(fig.raw.type ?? '')

  // DOCUMENT and CANVAS are Figma's own wrappers, not design content: their
  // children are the pages and the top-level layers. Importing them as frames
  // would wrap everything in boxes nobody drew.
  if (figType === 'DOCUMENT' || figType === 'CANVAS') {
    if (figType === 'CANVAS') ctx.report.pages += 1
    const out: NodeId[] = []
    for (const child of fig.children) out.push(...walk(child, ctx))
    return out
  }

  const node = mapNode(fig, ctx)
  if (!node) {
    // Keep the descendants even when the parent could not be made: losing a
    // container should not lose a subtree.
    const out: NodeId[] = []
    for (const child of fig.children) out.push(...walk(child, ctx))
    return out
  }

  node.id = newId()
  ctx.bundle.nodes[node.id] = node
  ctx.report.nodesCreated += 1

  const childIds: NodeId[] = []
  for (const child of fig.children) childIds.push(...walk(child, ctx))
  if (childIds.length > 0) {
    if (node.type === 'FRAME' || node.type === 'GROUP') {
      node.children = childIds
      // A group's box is its content; a frame that came without one gets the same
      // treatment so nothing is clipped away on arrival.
      if (node.width === 0 || node.height === 0) {
        let maxX = 0
        let maxY = 0
        for (const id of childIds) {
          const c = ctx.bundle.nodes[id]
          maxX = Math.max(maxX, c.x + c.width)
          maxY = Math.max(maxY, c.y + c.height)
        }
        node.width = Math.max(node.width, maxX)
        node.height = Math.max(node.height, maxY)
      }
    } else {
      // A shape with children (a mask group, say): hoist them next to it rather
      // than throw them away, and say so.
      note(ctx.report.approximations, `children of a ${node.type} hoisted to its parent`)
      return [node.id, ...childIds]
    }
  }
  return [node.id]
}

/**
 * Map a decoded `.fig` root into a node bundle.
 *
 * @param imageMap Their image hash → an asset hash already written into the
 *   bundle by the caller. Empty is fine: image fills are then reported as
 *   skipped rather than drawn as black boxes.
 */
export function mapFigDocument(root: KiwiObject, imageMap = new Map<string, string>()): FigImportResult {
  const nodeChanges = (root.nodeChanges ?? []) as KiwiObject[]
  const blobs = ((root.blobs ?? []) as KiwiObject[]).map((b) => {
    const bytes = b.bytes
    if (bytes instanceof Uint8Array) return bytes
    if (Array.isArray(bytes)) return new Uint8Array(bytes as number[])
    if (typeof bytes === 'string') {
      // The schema types blobs as strings; a Kiwi string is UTF-8 bytes, and the
      // decoder has already turned them into a JS string, so undo that exactly.
      const out = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i) & 0xff
      return out
    }
    return new Uint8Array(0)
  })

  const ctx: Ctx = {
    bundle: { nodes: {}, rootIds: [] },
    blobs,
    imageMap,
    report: { pages: 0, nodesRead: 0, nodesCreated: 0, skipped: {}, approximations: {}, images: imageMap.size },
  }

  for (const rootFig of buildFigTree(nodeChanges)) ctx.bundle.rootIds.push(...walk(rootFig, ctx))

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of ctx.bundle.rootIds) {
    const n = ctx.bundle.nodes[id]
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  const bounds = Number.isFinite(minX)
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : { x: 0, y: 0, w: 0, h: 0 }

  return { bundle: ctx.bundle, bounds, report: ctx.report }
}

/** One line per thing worth telling the user, most significant first. */
export function describeFigReport(report: FigImportReport): string[] {
  const lines: string[] = []
  lines.push(`${report.nodesCreated} layers from ${report.nodesRead} nodes${report.pages > 1 ? ` across ${report.pages} pages` : ''}.`)
  if (report.images > 0) lines.push(`${report.images} image${report.images === 1 ? '' : 's'} imported.`)
  const entries = (bag: Record<string, number>) =>
    Object.entries(bag).sort((a, b) => b[1] - a[1]).map(([k, v]) => (v > 1 ? `${k} (×${v})` : k))
  const approx = entries(report.approximations)
  const skipped = entries(report.skipped)
  if (approx.length > 0) lines.push(`Approximated: ${approx.join('; ')}.`)
  if (skipped.length > 0) lines.push(`Not imported: ${skipped.join('; ')}.`)
  return lines
}
