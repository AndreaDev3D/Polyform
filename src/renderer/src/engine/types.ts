// Core scene-graph type system for the Polyform engine.
// Designed to mirror the FlatBuffers schema in docs/schema.fbs and to stay
// portable to the planned Rust/WASM core (plain data, no classes, no DOM).

export type NodeId = string

export interface Vec2 {
  x: number
  y: number
}

/** Channels normalized 0..1 */
export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

// ---------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------

export interface SolidPaint {
  type: 'SOLID'
  visible: boolean
  opacity: number
  color: RGBA
}

export interface GradientStop {
  position: number
  color: RGBA
}

export interface GradientPaint {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'
  visible: boolean
  opacity: number
  stops: GradientStop[]
  /** Normalized node space (0..1 across width/height). */
  start: Vec2
  end: Vec2
}

export type ImageScaleMode = 'FILL' | 'FIT' | 'TILE' | 'STRETCH'

/** Crop rect normalized to the source image (0..1). */
export interface ImageCrop {
  x: number
  y: number
  w: number
  h: number
}

/** Non-destructive adjustments, each -1..1 (0 = neutral). */
export interface ImageAdjust {
  exposure: number
  contrast: number
  saturation: number
}

export interface ImagePaint {
  type: 'IMAGE'
  visible: boolean
  opacity: number
  /** SHA-256 content hash referencing assets/<hash>.<ext> in the bundle. */
  assetHash: string
  scaleMode: ImageScaleMode
  crop?: ImageCrop | null
  adjust?: ImageAdjust | null
  /** Set by Remove Background (v0.4.1): the pre-cutout asset, kept in the
   * bundle so "Restore original" is a hash swap. Additive optional field —
   * serialization passes it through untouched. */
  originalAssetHash?: string
}

export type Paint = SolidPaint | GradientPaint | ImagePaint

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export interface DropShadowEffect {
  type: 'DROP_SHADOW'
  visible: boolean
  color: RGBA
  offset: Vec2
  blur: number
}

export interface InnerShadowEffect {
  type: 'INNER_SHADOW'
  visible: boolean
  color: RGBA
  offset: Vec2
  blur: number
}

export interface LayerBlurEffect {
  type: 'LAYER_BLUR'
  visible: boolean
  radius: number
}

export interface BackgroundBlurEffect {
  type: 'BACKGROUND_BLUR'
  visible: boolean
  radius: number
}

export type Effect = DropShadowEffect | InnerShadowEffect | LayerBlurEffect | BackgroundBlurEffect

// ---------------------------------------------------------------------------
// Vector networks (per Technical-Specification §2.1)
// ---------------------------------------------------------------------------

/**
 * How a vertex ties its two handles together while you drag one of them.
 *
 * The handles themselves live on the EDGES (cp0/cp1), because an edge is what
 * needs control points to be a curve. Pairing them is a property of the vertex
 * between them, which is the only thing that knows they meet.
 */
export type MirrorMode = 'NONE' | 'ANGLE' | 'ANGLE_LENGTH'

export interface VectorVertex {
  id: number
  x: number
  y: number
  /** Absent means NONE — every path drawn before this existed has corners. */
  mirror?: MirrorMode
  /**
   * Fillet radius at this point, in node-local units. Absent or 0 is a sharp
   * corner, which is what every path drawn before this existed has. The radius
   * is a *request*: the outline clamps it to half of the shorter neighbouring
   * segment, and a point whose neighbours are curved stays sharp (see
   * roundSubPathCorners).
   */
  cornerRadius?: number
}

export interface VectorEdge {
  id: number
  v0: number
  v1: number
  /** Cubic bezier control points (absolute, node-local); both null => straight line. */
  cp0: Vec2 | null
  cp1: Vec2 | null
}

export interface VectorNetwork {
  vertices: VectorVertex[]
  edges: VectorEdge[]
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeType =
  | 'FRAME'
  | 'GROUP'
  | 'BOOLEAN'
  | 'RECTANGLE'
  | 'ELLIPSE'
  | 'LINE'
  | 'POLYGON'
  | 'STAR'
  | 'VECTOR'
  | 'TEXT'
  | 'COMPONENT'
  | 'INSTANCE'
  | 'MODEL3D'

export type BlendMode =
  | 'NORMAL'
  | 'MULTIPLY'
  | 'SCREEN'
  | 'OVERLAY'
  | 'DARKEN'
  | 'LIGHTEN'
  | 'COLOR_DODGE'
  | 'COLOR_BURN'
  | 'HARD_LIGHT'
  | 'SOFT_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY'

export type StrokeAlign = 'CENTER' | 'INSIDE' | 'OUTSIDE'

export interface CornerRadius {
  tl: number
  tr: number
  br: number
  bl: number
}

/**
 * Per-side stroke weights — the stroke's answer to `CornerRadius`, and carried by
 * exactly the same four node types, because "the top side" only means something
 * for a box. A side set to 0 has no stroke; absent means every side uses the
 * node's own `strokeWeight`, which is what every node written before this existed
 * does.
 *
 * Weights rather than on/off flags: that is what Figma's individual strokes are,
 * it makes 0 mean "off" for free, and a border that is 1px on three sides and 4px
 * on the fourth is the case people actually reach for this to build.
 */
export interface StrokeSides {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Constraint of a node relative to its parent frame when the frame resizes.
 * MIN pins to left/top, MAX to right/bottom, STRETCH pins both edges,
 * CENTER keeps the center offset, SCALE resizes proportionally.
 */
export type Constraint = 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE'

/** References into the document's shared styles (applied-by-reference). */
export interface StyleRefs {
  fill?: string | null
  text?: string | null
  effect?: string | null
}

export interface BaseNode {
  id: NodeId
  type: NodeType
  name: string
  visible: boolean
  locked: boolean
  opacity: number
  blendMode: BlendMode
  /** Position relative to parent's unrotated top-left. */
  x: number
  y: number
  width: number
  height: number
  /** Degrees, clockwise, about the node center. */
  rotation: number
  /**
   * Mirror about the node's own centre, applied *before* rotation. A transform
   * rather than a geometry edit, which is the only way a flip can mean the same
   * thing for an image fill, shaped text, a vector network and a whole group.
   * Absent is false — every node written before this existed is unflipped.
   */
  flipH?: boolean
  flipV?: boolean
  fills: Paint[]
  strokes: Paint[]
  strokeWeight: number
  strokeAlign: StrokeAlign
  strokeDash: number[]
  effects: Effect[]
  // --- v2 fields (optional so v1 documents and journals stay loadable) ---
  /** Horizontal / vertical constraints relative to the parent frame. */
  constraintsH?: Constraint
  constraintsV?: Constraint
  /** Mask: clips the siblings above it within the same container. */
  isMask?: boolean
  styleRefs?: StyleRefs
  // --- v3 fields ---
  /**
   * Inside a materialized INSTANCE subtree: the id of the component
   * descendant this node mirrors. Overrides are keyed by this id.
   */
  sourceId?: NodeId
}

export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL'
export type AxisSizing = 'FIXED' | 'HUG'
export type CounterAlign = 'MIN' | 'CENTER' | 'MAX'

export interface AutoLayout {
  mode: LayoutMode
  gap: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  counterAlign: CounterAlign
  primarySizing: AxisSizing
  counterSizing: AxisSizing
}

export interface FrameNode extends BaseNode {
  type: 'FRAME'
  children: NodeId[]
  clipsContent: boolean
  cornerRadius: CornerRadius
  /** Per-side stroke weights; absent = `strokeWeight` on every side. */
  strokeSides?: StrokeSides
  layout: AutoLayout
}

/** Provenance of a component imported from a local library file. */
export interface LibraryOrigin {
  libraryPath: string
  componentId: NodeId
  importedAt: string
}

/** A main component: frame semantics plus instance tracking. */
export interface ComponentNode extends BaseNode {
  type: 'COMPONENT'
  children: NodeId[]
  clipsContent: boolean
  cornerRadius: CornerRadius
  /** Per-side stroke weights; absent = `strokeWeight` on every side. */
  strokeSides?: StrokeSides
  layout: AutoLayout
  description?: string
  origin?: LibraryOrigin | null
}

/**
 * An instance of a component. Children are MATERIALIZED copies of the
 * component subtree (each carrying `sourceId`), regenerated by the sync
 * pass; `overrides` maps component-descendant ids to overridden props.
 */
export interface InstanceNode extends BaseNode {
  type: 'INSTANCE'
  children: NodeId[]
  clipsContent: boolean
  cornerRadius: CornerRadius
  /** Per-side stroke weights; absent = `strokeWeight` on every side. */
  strokeSides?: StrokeSides
  layout: AutoLayout
  componentId: NodeId
  overrides: Record<NodeId, Record<string, unknown>>
  /** Hash of the component subtree + overrides at last sync. */
  syncedHash?: string
}

/** Nodes that behave like frames for layout/constraints/clipping. */
export type FrameLikeNode = FrameNode | ComponentNode | InstanceNode

export function isFrameLike(node: SceneNode): node is FrameLikeNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE'
}

export interface GroupNode extends BaseNode {
  type: 'GROUP'
  children: NodeId[]
}

export type BooleanOp = 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE'

export interface BooleanNode extends BaseNode {
  type: 'BOOLEAN'
  children: NodeId[]
  booleanOp: BooleanOp
}

export interface RectangleNode extends BaseNode {
  type: 'RECTANGLE'
  cornerRadius: CornerRadius
  /** Per-side stroke weights; absent = `strokeWeight` on every side. */
  strokeSides?: StrokeSides
}

export interface EllipseNode extends BaseNode {
  type: 'ELLIPSE'
  // --- v5 arc fields (optional so v1..v4 documents stay loadable, and so
  // an untouched ellipse serializes byte-identically to before) ---
  /** Sweep start, in turns clockwise from 12 o'clock. Default 0. */
  arcStart?: number
  /** Sweep length in turns; 1 is a whole ellipse. Default 1. */
  arcSweep?: number
  /** Inner radius as a fraction of the outer, 0..0.999. Default 0. */
  arcRatio?: number
}

/** A line runs from local (0,0) to (width,0); height is always 0. */
export interface LineNode extends BaseNode {
  type: 'LINE'
}

export interface PolygonNode extends BaseNode {
  type: 'POLYGON'
  pointCount: number
}

export interface StarNode extends BaseNode {
  type: 'STAR'
  pointCount: number
  /** Inner radius as a ratio of the outer radius, 0..1. */
  innerRatio: number
}

export interface VectorNode extends BaseNode {
  type: 'VECTOR'
  network: VectorNetwork
  windingRule: 'NONZERO' | 'EVENODD'
}

export type TextAlignH = 'LEFT' | 'CENTER' | 'RIGHT'
export type TextAlignV = 'TOP' | 'CENTER' | 'BOTTOM'
export type TextAutoResize = 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE'

export interface TextNode extends BaseNode {
  type: 'TEXT'
  characters: string
  fontFamily: string
  fontWeight: number
  italic: boolean
  fontSize: number
  /** Multiplier of fontSize. */
  lineHeight: number
  /** Pixels. */
  letterSpacing: number
  textAlignH: TextAlignH
  textAlignV: TextAlignV
  autoResize: TextAutoResize
}

// ---------------------------------------------------------------------------
// 3D models (v4 — ADR-020)
// ---------------------------------------------------------------------------

/** Container formats a MODEL3D asset may hold. */
export type Model3dFormat = 'GLB' | 'PLY' | 'SPZ' | 'SPLAT' | 'KSPLAT' | 'SOG'

/** Procedural lighting environments; splat formats ignore this (their
 *  radiance is baked into the capture). */
export type LightingPreset = 'STUDIO' | 'NEUTRAL' | 'DRAMATIC' | 'NONE'

/**
 * The orbit camera. Framing is automatic — the model's bounding sphere is
 * fitted to the node box — so `distance` is a multiplier of that fit, and
 * a pose stays meaningful when the node is resized or the asset swapped.
 */
export interface ModelPose {
  /** Degrees around the model's up axis. */
  yaw: number
  /** Degrees above/below the equator, clamped to ±89.9 at render time. */
  pitch: number
  /** Multiplier of the auto-framed distance (1 = fitted). */
  distance: number
  /** Vertical field of view in degrees. */
  fov: number
}

/**
 * A 3D model composited as a 2D node: the offscreen island renders the
 * posed model and the result draws like an image. Polyform stays a 2D
 * tool — there is no mesh editing (ADR-020).
 */
export interface Model3dNode extends BaseNode {
  type: 'MODEL3D'
  /** SHA-256 content hash referencing assets/<hash>.<ext> in the bundle. */
  assetHash: string
  format: Model3dFormat
  camera: ModelPose
  lighting: LightingPreset
  /** Splat captures are stored Y-down; false renders them unflipped. */
  upright?: boolean
}

export function defaultPose(): ModelPose {
  return { yaw: 25, pitch: 15, distance: 1, fov: 40 }
}

export type SceneNode =
  | FrameNode
  | GroupNode
  | BooleanNode
  | RectangleNode
  | EllipseNode
  | LineNode
  | PolygonNode
  | StarNode
  | VectorNode
  | TextNode
  | ComponentNode
  | InstanceNode
  | Model3dNode

export type ContainerNode = FrameNode | GroupNode | BooleanNode | ComponentNode | InstanceNode

export function isContainer(node: SceneNode): node is ContainerNode {
  return (
    node.type === 'FRAME' ||
    node.type === 'GROUP' ||
    node.type === 'BOOLEAN' ||
    node.type === 'COMPONENT' ||
    node.type === 'INSTANCE'
  )
}

// ---------------------------------------------------------------------------
// Document, pages, guides, shared styles
// ---------------------------------------------------------------------------

/** v4 adds the MODEL3D node type (ADR-020). */
export const SCHEMA_VERSION = 5

export interface Guide {
  axis: 'x' | 'y'
  pos: number
}

export interface Page {
  id: string
  name: string
  /** Root z-order, bottom to top. */
  rootIds: NodeId[]
  guides: Guide[]
  /** Per-page camera, restored when switching pages. */
  viewport?: { x: number; y: number; zoom: number } | null
}

export interface ColorStyle {
  id: string
  name: string
  paint: Paint
}

/** The text properties a shared text style carries. */
export interface TextStyleProps {
  fontFamily: string
  fontWeight: number
  italic: boolean
  fontSize: number
  lineHeight: number
  letterSpacing: number
}

export interface TextStyle {
  id: string
  name: string
  props: TextStyleProps
}

export interface EffectStyle {
  id: string
  name: string
  effects: Effect[]
}

export interface DocumentStyles {
  colors: ColorStyle[]
  texts: TextStyle[]
  effects: EffectStyle[]
}

export interface AttachedLibrary {
  /** Absolute path of the library's .poly bundle. */
  path: string
  name: string
  attachedAt: string
}

export interface PolyformDocument {
  schemaVersion: number
  nodes: Record<NodeId, SceneNode>
  pages: Page[]
  activePageId: string
  styles: DocumentStyles
  /** Local-file libraries this document pulls components/styles from (v3). */
  libraries?: AttachedLibrary[]
}

export function createPage(name: string): Page {
  return { id: newId(), name, rootIds: [], guides: [], viewport: null }
}

export function emptyStyles(): DocumentStyles {
  return { colors: [], texts: [], effects: [] }
}

// ---------------------------------------------------------------------------
// Helpers / defaults
// ---------------------------------------------------------------------------

let idCounter = 0

/** Collision-safe unique id (time + counter + random). */
export function newId(): NodeId {
  idCounter = (idCounter + 1) % 0xffff
  const rand = Math.floor(Math.random() * 0xffffff)
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${rand.toString(36)}`
}

export function rgba(r: number, g: number, b: number, a = 1): RGBA {
  return { r, g, b, a }
}

export function solid(color: RGBA): SolidPaint {
  return { type: 'SOLID', visible: true, opacity: 1, color }
}

export function uniformRadius(v: number): CornerRadius {
  return { tl: v, tr: v, br: v, bl: v }
}

export function uniformSides(v: number): StrokeSides {
  return { top: v, right: v, bottom: v, left: v }
}

/**
 * Can this node carry per-side stroke weights? The same four types that carry a
 * corner radius: a box has sides, an ellipse and an arbitrary path do not.
 */
export function strokeSidesApply(node: SceneNode): boolean {
  return (
    node.type === 'RECTANGLE' || node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE'
  )
}

export function defaultLayout(): AutoLayout {
  return {
    mode: 'NONE',
    gap: 10,
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
    counterAlign: 'MIN',
    primarySizing: 'FIXED',
    counterSizing: 'FIXED',
  }
}

export function baseDefaults(type: NodeType, name: string): BaseNode {
  return {
    id: newId(),
    type,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'NORMAL',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    fills: [solid(rgba(0.85, 0.85, 0.85, 1))],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeDash: [],
    effects: [],
  }
}

export function createNode(type: NodeType, name: string): SceneNode {
  const base = baseDefaults(type, name)
  switch (type) {
    case 'FRAME':
      return {
        ...base,
        type,
        children: [],
        clipsContent: true,
        cornerRadius: uniformRadius(0),
        layout: defaultLayout(),
        fills: [solid(rgba(1, 1, 1, 1))],
      }
    case 'COMPONENT':
      return {
        ...base,
        type,
        children: [],
        clipsContent: true,
        cornerRadius: uniformRadius(0),
        layout: defaultLayout(),
        fills: [solid(rgba(1, 1, 1, 1))],
        origin: null,
      }
    case 'INSTANCE':
      return {
        ...base,
        type,
        children: [],
        clipsContent: true,
        cornerRadius: uniformRadius(0),
        layout: defaultLayout(),
        componentId: '',
        overrides: {},
        fills: [],
      }
    case 'GROUP':
      return { ...base, type, children: [], fills: [], strokes: [] }
    case 'BOOLEAN':
      return { ...base, type, children: [], booleanOp: 'UNION' }
    case 'RECTANGLE':
      return { ...base, type, cornerRadius: uniformRadius(0) }
    case 'ELLIPSE':
      return { ...base, type }
    case 'LINE':
      return {
        ...base,
        type,
        height: 0,
        fills: [],
        strokes: [solid(rgba(0, 0, 0, 1))],
        strokeWeight: 1,
        strokeAlign: 'CENTER',
      }
    case 'POLYGON':
      return { ...base, type, pointCount: 3 }
    case 'STAR':
      return { ...base, type, pointCount: 5, innerRatio: 0.382 }
    case 'VECTOR':
      return {
        ...base,
        type,
        network: { vertices: [], edges: [] },
        windingRule: 'NONZERO',
        fills: [],
        strokes: [solid(rgba(0, 0, 0, 1))],
        strokeAlign: 'CENTER',
      }
    case 'TEXT':
      return {
        ...base,
        type,
        characters: '',
        fontFamily: 'Inter',
        fontWeight: 400,
        italic: false,
        fontSize: 16,
        lineHeight: 1.2,
        letterSpacing: 0,
        textAlignH: 'LEFT',
        textAlignV: 'TOP',
        autoResize: 'WIDTH_AND_HEIGHT',
        fills: [solid(rgba(0, 0, 0, 1))],
      }
    case 'MODEL3D':
      return {
        ...base,
        type,
        assetHash: '',
        format: 'GLB',
        camera: defaultPose(),
        lighting: 'STUDIO',
        upright: true,
        fills: [],
        strokes: [],
      }
  }
}

export function cloneNode<T extends SceneNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T
}
