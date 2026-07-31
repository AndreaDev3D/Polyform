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

export interface ImagePaint {
  type: 'IMAGE'
  visible: boolean
  opacity: number
  /** SHA-256 content hash referencing assets/<hash>.<ext> in the bundle. */
  assetHash: string
  scaleMode: ImageScaleMode
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

export interface LayerBlurEffect {
  type: 'LAYER_BLUR'
  visible: boolean
  radius: number
}

export type Effect = DropShadowEffect | LayerBlurEffect

// ---------------------------------------------------------------------------
// Vector networks (per Technical-Specification §2.1)
// ---------------------------------------------------------------------------

export interface VectorVertex {
  id: number
  x: number
  y: number
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
  fills: Paint[]
  strokes: Paint[]
  strokeWeight: number
  strokeAlign: StrokeAlign
  strokeDash: number[]
  effects: Effect[]
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
  layout: AutoLayout
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
}

export interface EllipseNode extends BaseNode {
  type: 'ELLIPSE'
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

export type ContainerNode = FrameNode | GroupNode | BooleanNode

export function isContainer(node: SceneNode): node is ContainerNode {
  return node.type === 'FRAME' || node.type === 'GROUP' || node.type === 'BOOLEAN'
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1

export interface PolyformDocument {
  schemaVersion: number
  nodes: Record<NodeId, SceneNode>
  /** Root z-order, bottom to top. */
  rootIds: NodeId[]
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
  }
}

export function cloneNode<T extends SceneNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T
}
