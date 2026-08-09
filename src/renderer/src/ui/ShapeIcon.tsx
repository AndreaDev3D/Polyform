// The layer icon for a shape IS the shape.
//
// A list of forty rows reading "Vector, Vector, Vector, Vector" tells you
// nothing; the same list drawn as its own silhouettes tells you which one is the
// D and which is the wave, which is how Figma's layer panel is readable at all.
// Type icons stay for everything whose shape is not the point: a frame, a group,
// a component, text, a 3D model.
//
// The path comes from the same `nodeOutline`/`booleanRings` the renderers draw,
// so an icon cannot drift from its layer, and is cached per scene version because
// a panel re-render must not re-tessellate the document.

import type { SceneNode } from '../engine/types'
import type { SceneGraph } from '../engine/scene'
import { nodeOutline, ringsToSubPaths, subPathsToSvg, type SubPath } from '../engine/shapes'
import { booleanRings } from '../engine/booleans'

/** Types drawn as their own outline; the rest keep a type icon. */
const SHAPED = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'BOOLEAN'])

/**
 * Above this many anchors the silhouette is past what 12 pixels can show, and
 * the path string starts to cost more than the icon is worth.
 */
const MAX_ANCHORS = 600

interface ShapeGlyph {
  d: string
  viewBox: string
  evenOdd: boolean
  /** An open path has no inside to fill, so it is drawn as a line. */
  strokeWidth: number
}

const cache = new Map<string, ShapeGlyph | null>()
const CACHE_MAX = 4096

function build(scene: SceneGraph, node: SceneNode): ShapeGlyph | null {
  let subpaths: SubPath[]
  let evenOdd: boolean
  if (node.type === 'BOOLEAN') {
    subpaths = ringsToSubPaths(booleanRings(scene, node))
    evenOdd = true
  } else {
    subpaths = nodeOutline(node)
    evenOdd = node.type === 'VECTOR' && node.windingRule === 'EVENODD'
  }
  let anchors = 0
  for (const sp of subpaths) anchors += sp.anchors.length
  if (anchors === 0 || anchors > MAX_ANCHORS) return null

  // Anchors and control points: a conservative box, which can only make the
  // silhouette a shade smaller than the 12px cell, never crop it.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const sp of subpaths) {
    for (const a of sp.anchors) {
      for (const p of [a.p, a.cpIn, a.cpOut]) {
        if (!p) continue
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
      }
    }
  }
  if (!Number.isFinite(minX)) return null
  // A zero-width or zero-height shape (a horizontal path, a flat vector) still
  // has a silhouette; give it something to be scaled into.
  const w = Math.max(maxX - minX, 1e-3)
  const h = Math.max(maxY - minY, 1e-3)
  const d = subPathsToSvg(subpaths, 2)
  if (!d) return null
  const open = !subpaths.some((sp) => sp.closed)
  return {
    d,
    viewBox: [minX, minY, w, h].map((v) => Math.round(v * 100) / 100).join(' '),
    evenOdd,
    // ~1.2 of the icon's 12 px, in the shape's own units.
    strokeWidth: open ? Math.max(w, h) / 10 : 0,
  }
}

function glyphFor(scene: SceneGraph, node: SceneNode): ShapeGlyph | null {
  const key = `${node.id}|${scene.version}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let made: ShapeGlyph | null = null
  try {
    made = build(scene, node)
  } catch {
    // Degenerate geometry must cost a row its icon, never the panel.
    made = null
  }
  // Every edit bumps the version, so old entries are dead weight the moment they
  // are replaced; the panel only ever asks for the rows it is showing.
  if (cache.size > CACHE_MAX) cache.clear()
  cache.set(key, made)
  return made
}

/** True when this node's own outline is worth more than its type icon. */
export function hasShapeIcon(scene: SceneGraph, node: SceneNode): boolean {
  if (!SHAPED.has(node.type)) return false
  // An image is better said with the image icon than with the rectangle holding it.
  if (node.type === 'RECTANGLE' && node.fills.some((f) => f.type === 'IMAGE')) return false
  return glyphFor(scene, node) !== null
}

// Deliberately not memo()'d: the geometry is cached by scene version above, so a
// re-render costs one <path> element — while a memo keyed on the node object
// would keep drawing the old silhouette for as long as an edit mutates a node in
// place instead of replacing it.
export function ShapeIcon({
  scene,
  node,
  size = 12,
}: {
  scene: SceneGraph
  node: SceneNode
  size?: number
}) {
  const glyph = glyphFor(scene, node)
  if (!glyph) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox={glyph.viewBox}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className="shrink-0"
      // Overflow matters: a stroked open path draws half its width outside the
      // box the viewBox was measured from.
      style={{ overflow: 'visible' }}
    >
      <path
        d={glyph.d}
        fill={glyph.strokeWidth > 0 ? 'none' : 'currentColor'}
        fillRule={glyph.evenOdd ? 'evenodd' : 'nonzero'}
        stroke={glyph.strokeWidth > 0 ? 'currentColor' : 'none'}
        strokeWidth={glyph.strokeWidth || undefined}
        strokeLinecap="round"
      />
    </svg>
  )
}
