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
  /**
   * Figma's `sessionID:localID` → the node we made from it. Exists so a test can
   * hold a mapped node against the matrix it came from: the pivot bug (F-28) was
   * invisible to every check that looked at our output alone.
   */
  idByGuid: Map<string, NodeId>
  /**
   * One entry per Figma page that had content, in file order — the caller makes one
   * Polyform page from each. Coordinates are exactly the file's: pages used to be
   * shoved sideways to stop them overlapping, which is only a problem while they
   * share one page.
   */
  pages: { name: string; rootIds: NodeId[] }[]
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
  idByGuid: Map<string, NodeId>
  /** One entry per Figma CANVAS, in file order: its name and its root ids. */
  pageBreaks: { name: string; ids: NodeId[] }[]
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
 * Figma keeps a 2×3 affine and the size separately, so the matrix is a rotation
 * (sometimes with a mirror) plus a translation.
 *
 * **The translation is not our x/y.** Figma's matrix maps the node's own local
 * space, whose origin is the box's top-left corner, so `(m02, m12)` is where that
 * CORNER lands — the rotation turns the box about it. Our model stores the
 * unrotated box and turns it about its CENTRE (`nodeLocalMatrix`: T(x+c)·R·S·T(−c)).
 * Copying the translation into x/y therefore offsets every rotated node by the
 * difference between those two pivots, which is what scrambled the first imports:
 * a 90°-rotated 183×338 bar landed ~260 units away from where Figma drew it.
 *
 * Equating the two matrices gives the conversion exactly. With M the linear part
 * and c the half-size, Figma sends p ↦ M·p + t while we produce
 * p ↦ M·(p − c) + (x,y) + c, so
 *
 *     (x, y) = t + M·c − c
 *
 * A mirror is not dropped either: any reflection is a rotation composed with one
 * fixed flip, so `det < 0` becomes `flipV` — which our matrix applies inside the
 * centred frame, exactly where Figma's belongs. What is left over after taking the
 * rotation and the mirror out (a true skew, a non-unit scale) cannot be expressed
 * by x/y/rotation/flip and is reported rather than silently flattened.
 */
function transformFrom(
  raw: KiwiObject,
  width: number,
  height: number,
  report: FigImportReport,
): { x: number; y: number; rotation: number; flipV: boolean } {
  const t = raw.transform as { m00?: number; m01?: number; m02?: number; m10?: number; m11?: number; m12?: number } | undefined
  if (!t) return { x: 0, y: 0, rotation: 0, flipV: false }
  const m00 = t.m00 ?? 1
  const m01 = t.m01 ?? 0
  const m10 = t.m10 ?? 0
  const m11 = t.m11 ?? 1
  const flipV = m00 * m11 - m01 * m10 < 0
  const rotation = (Math.atan2(m10, m00) * 180) / Math.PI
  const rad = (rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // Compare against rotation-and-mirror WITH the scale each axis actually carries,
  // otherwise a uniform 2× reads as a skew. R·diag(1,−1) negates the second column,
  // which is the flip's whole effect on the expected m01/m11.
  const scaleX = Math.hypot(m00, m10)
  const scaleY = Math.hypot(m01, m11)
  const wantM01 = (flipV ? sin : -sin) * scaleY
  const wantM11 = (flipV ? -cos : cos) * scaleY
  if (Math.abs(m01 - wantM01) > 1e-3 * Math.max(1, scaleY) || Math.abs(m11 - wantM11) > 1e-3 * Math.max(1, scaleY)) {
    note(report.approximations, 'skew reduced to rotation')
  } else if (Math.abs(scaleX - 1) > 1e-3 || Math.abs(scaleY - 1) > 1e-3) {
    // Size travels separately in this format, so a scaled matrix would resize the
    // node without resizing its geometry. Say so instead of drawing it wrong.
    const worst = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY
    note(report.approximations, `transform scale ${worst.toFixed(3)}× not applied to geometry`)
  }
  // Rotate the half-size by the same linear part, then step back from centre to
  // corner: the pivot conversion above.
  const cx = width / 2
  const cy = height / 2
  return {
    x: (t.m02 ?? 0) + (m00 * cx + m01 * cy) - cx,
    y: (t.m12 ?? 0) + (m10 * cx + m11 * cy) - cy,
    rotation: Math.abs(rotation) < 1e-6 ? 0 : rotation,
    flipV,
  }
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Parse one of the two geometry lists, keeping only paths that actually draw. */
function readPaths(paths: unknown, ctx: Ctx): ParsedGeometry[] {
  if (!Array.isArray(paths) || paths.length === 0) return []
  const out: ParsedGeometry[] = []
  for (const p of paths as KiwiObject[]) {
    const idx = typeof p.commandsBlob === 'number' ? p.commandsBlob : -1
    const blob = ctx.blobs[idx]
    // An entry pointing at a ZERO-BYTE blob is the format saying "no fill here",
    // not a path. Taking it at face value built empty vector nodes — see below.
    if (!blob || blob.length === 0) continue
    try {
      const parsed = parsePathCommands(blob)
      if (parsed.commands.length === 0) continue
      if (parsed.usedInferredOp) note(ctx.report.approximations, 'quadratic curve (op 0x03, never seen in a real file) promoted to cubic')
      out.push(parsed)
    } catch (err) {
      note(ctx.report.skipped, `unreadable path geometry (${err instanceof Error ? err.message : 'error'})`)
    }
  }
  return out
}

/**
 * Fill geometry when there is any, the stroke outline when there is not: an open
 * path — a signature, an arrow, a drawn line — has no fill geometry at all, and
 * reading only `fillGeometry` silently dropped nine such nodes per file.
 *
 * The choice must be made on whether geometry PARSED, not on whether the list had
 * entries. Figma writes a `fillGeometry` entry pointing at an **empty blob** for a
 * shape with no fill, so a length check said "fill geometry present", produced zero
 * commands, and built a vector node with no vertices at all — invisible, while a
 * perfectly good 1537-byte stroke outline sat in the next field. That cost 4 nodes
 * in Dipped.fig and **37** in OmniTecta.fig, every one of them a hole in the design.
 */
function geometryOf(
  raw: KiwiObject,
  ctx: Ctx,
): { geometry: ParsedGeometry[]; paths: KiwiObject[] | undefined; strokeOnly: boolean } {
  const fill = readPaths(raw.fillGeometry, ctx)
  if (fill.length > 0) return { geometry: fill, paths: raw.fillGeometry as KiwiObject[] | undefined, strokeOnly: false }
  const stroke = readPaths(raw.strokeGeometry, ctx)
  return { geometry: stroke, paths: raw.strokeGeometry as KiwiObject[] | undefined, strokeOnly: stroke.length > 0 }
}

/**
 * SYMBOL and INSTANCE are in here because they are *containers* — a component and
 * a copy of one. They were not, so each mapped to a bare path made from its own
 * background fill and then, being a non-container with children, had its entire
 * contents deleted as if it were a boolean's operands: 24 components in one file
 * arrived as empty rectangles (F-32).
 */
const CONTAINER_TYPES = new Set([
  'FRAME',
  'GROUP',
  'CANVAS',
  'DOCUMENT',
  'SECTION',
  'COMPONENT_SET',
  'SYMBOL',
  'INSTANCE',
])

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
  const { x, y, rotation, flipV } = transformFrom(raw, width, height, ctx.report)

  const finish = (node: SceneNode): SceneNode => {
    node.name = name
    node.x = x
    node.y = y
    node.rotation = rotation
    if (flipV) node.flipV = true
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
    // A mask clips the siblings above it, which is what our renderer already does
    // with `isMask` — it was simply never read, so 13 masks in one file arrived as
    // 13 opaque shapes drawn over the artwork they were meant to cut out (F-32).
    if (raw.mask === true) {
      node.isMask = true
      const maskType = String(raw.maskType ?? 'ALPHA').toUpperCase()
      if (maskType !== 'OUTLINE' && maskType !== 'VECTOR') {
        // Ours is a clip: identical for a solid shape, hard-edged where theirs
        // would fade (a gradient, a soft image, partial opacity).
        note(ctx.report.approximations, `${maskType.toLowerCase()} mask imported as a clipping path`)
      }
    }
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
    // A component and its instances come in as ordinary frames: their contents,
    // names and geometry are exact, but the LINK between them is not carried, so
    // editing the original will not update the copies.
    if (figType === 'SYMBOL') note(ctx.report.approximations, 'component imported as a plain frame (no link to its instances)')
    if (figType === 'INSTANCE') note(ctx.report.approximations, 'instance imported as a plain frame (detached from its component)')
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
  const { geometry, paths: usedPaths, strokeOnly } = geometryOf(raw, ctx)
  if (geometry.length > 0) {
    const node = createNode('VECTOR', name)
    if (node.type !== 'VECTOR') return null
    node.network = networkFromPaths(geometry)
    node.windingRule = windingRuleFrom(usedPaths?.[0]?.windingRule)
    if (strokeOnly) note(ctx.report.approximations, 'open path imported from its stroke outline')
    node.width = width
    node.height = height
    if (figType === 'BOOLEAN_OPERATION') {
      note(ctx.report.approximations, 'boolean operation flattened to a path (operands not preserved)')
    } else if (figType !== 'VECTOR') {
      note(ctx.report.approximations, `${figType} imported as an editable path`)
    }
    const done = finish(node)
    if (strokeOnly) {
      // `strokeGeometry` is the OUTLINE of the stroke — the region the stroke
      // covers, as a fillable shape. So it must be FILLED with the stroke paint:
      // stroking it instead draws a line around the edge of a line, and carrying
      // the node's own fill paint over would flood a signature solid black.
      done.fills = paintsFrom(raw.strokePaints, ctx)
      done.strokes = []
      done.strokeWeight = 0
      done.strokeDash = []
    }
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
  //
  // `pageBreaks` records where one CANVAS's roots end and the next begins, so the
  // caller can separate them. Every Figma page starts near its own origin, so
  // laying them on top of each other put three pages of frames in one heap — the
  // second thing that made the imports look scrambled.
  if (figType === 'DOCUMENT' || figType === 'CANVAS') {
    if (figType === 'CANVAS') {
      // `internalOnly` is Figma's own holding canvas — component definitions it has
      // moved out of the way, deleted nodes, brush assets. Figma does not list it in
      // Pages, and importing it turned 477 pieces of debris into the largest "page"
      // in the document. The flag is theirs, read from the file's own schema: no
      // name matching (F-32).
      if (fig.raw.internalOnly === true) {
        note(ctx.report.skipped, "Figma's internal-only canvas (component definitions and deleted nodes)")
        return []
      }
      // A divider is a label in the pages list, not a page.
      if (fig.raw.isPageDivider === true) {
        note(ctx.report.skipped, 'page divider')
        return []
      }
      ctx.report.pages += 1
    }
    const out: NodeId[] = []
    for (const child of fig.children) out.push(...walk(child, ctx))
    if (figType === 'CANVAS') ctx.pageBreaks.push({ name: String(fig.raw.name ?? ''), ids: out })
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
  ctx.idByGuid.set(fig.guid, node.id)
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
      // A BOOLEAN OPERATION's children are its OPERANDS. We already imported the
      // flattened result, which *is* those operands combined — so hoisting them
      // next to it drew the union AND both circles it was made from, one on top of
      // the other. That is what turned the OmniTecta logo into a black scribble:
      // twenty booleans, every operand drawn again over the answer. Figma does not
      // draw them either.
      //
      // Keyed on the FIGMA type, not on ours. Asking "is our node a container?"
      // called every non-container-with-children a boolean, so a component's
      // entire contents were deleted under a comment about operands (F-32).
      note(
        ctx.report.approximations,
        figType === 'BOOLEAN_OPERATION'
          ? 'operands of a flattened boolean dropped (the result contains them)'
          : `children of a ${figType} dropped (it did not import as a container)`,
      )
      // Whole subtrees: an operand can be a group, and leaving its descendants in
      // the bundle would leave nodes nothing references.
      const drop = (id: NodeId): void => {
        const n = ctx.bundle.nodes[id]
        if (!n) return
        if (n.type === 'FRAME' || n.type === 'GROUP') for (const cid of n.children) drop(cid)
        delete ctx.bundle.nodes[id]
        ctx.report.nodesCreated -= 1
      }
      for (const id of childIds) drop(id)
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
    idByGuid: new Map(),
    pageBreaks: [],
    blobs,
    imageMap,
    report: { pages: 0, nodesRead: 0, nodesCreated: 0, skipped: {}, approximations: {}, images: imageMap.size },
  }

  for (const rootFig of buildFigTree(nodeChanges)) ctx.bundle.rootIds.push(...walk(rootFig, ctx))

  // One entry per Figma page that has something on it. Nothing is moved: each page
  // becomes a page, so two pages sharing a coordinate range no longer sit on top of
  // each other, and every node keeps the position its own page gave it.
  const pages = ctx.pageBreaks
    .filter((p) => p.ids.length > 0)
    .map((p) => ({ name: p.name, rootIds: p.ids }))

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

  return { bundle: ctx.bundle, bounds, report: ctx.report, idByGuid: ctx.idByGuid, pages }
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
