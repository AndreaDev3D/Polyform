// What a mask actually covers.
//
// A mask node is never painted; it clips the siblings drawn after it. The SHAPE
// it clips to is the only question this file answers, and "the node's own
// outline" — which is what all three renderers used to ask for — is the wrong
// answer for two of the three kinds of mask a design contains:
//
//   - A GROUP used as a mask clips to THE UNION OF WHAT IS INSIDE IT. Its own
//     outline is the box around its contents, so a group of seven letterform
//     shapes clipped to a rectangle: the DIGBORN logo imported from a `.fig`
//     arrived as a solid brown bar instead of brown letters (F-33).
//   - A TEXT mask clips to ITS GLYPHS. Its own outline is the text box, which
//     again clips nothing.
//   - A FRAME mask clips to the frame, which IS its own outline — a frame has a
//     shape of its own and already clips its children. Unchanged here, and the
//     reason telling a Figma group from a Figma frame on import matters twice.
//
// One function, three back ends: Canvas2D clips with it, the WebGPU backend
// tessellates it into a stencil mesh, and SVG export writes it into a
// `<clipPath>`. A mask whose shape is computed three times is a mask that comes
// out different on the GPU, and the parity harness would be right to fail.

import { isContainer, isFrameLike, type SceneNode } from './types'
import type { SceneGraph } from './scene'
import { IDENTITY, matMultiply, type Mat } from './geometry'
import { nodeOutline, ringsToSubPaths, transformSubPath, type SubPath } from './shapes'
import { booleanRings } from './booleans'
import { textSubPaths } from './glyphs'
import { effectiveStrokeWeight } from './strokesides'

export interface MaskShape {
  /** Coverage in the mask node's own local space. */
  subpaths: SubPath[]
  /** The rule this coverage has to be filled with. */
  evenOdd: boolean
}

/** Does this node put any ink on the canvas of its own? */
function paintsItself(node: SceneNode): boolean {
  if (node.type === 'GROUP') return false
  return (
    node.fills.some((f) => f.visible) ||
    (effectiveStrokeWeight(node) > 0 && node.strokes.some((s) => s.visible))
  )
}

/**
 * Everything a subtree covers, gathered into one list of subpaths in `space`.
 *
 * The result is filled NONZERO, which makes it a union: two overlapping shapes
 * wound the same way cover the overlap once, and a hole wound against its outer
 * contour — the convention in every font and in Figma's own flattened geometry —
 * stays a hole. The one shape this reads wrong is a descendant that needs the
 * EVEN-ODD rule and whose contours are wound the same way, whose holes fill in;
 * combining those exactly would mean re-winding every ring by nesting depth, and
 * a mask made of even-odd shapes is rare enough to be worth saying out loud here
 * rather than paying for on every frame.
 */
function collectCoverage(scene: SceneGraph, node: SceneNode, space: Mat, out: SubPath[]): void {
  if (node.type === 'BOOLEAN') {
    for (const sp of ringsToSubPaths(booleanRings(scene, node))) out.push(transformSubPath(sp, space))
    return
  }
  if (node.type === 'TEXT') {
    for (const sp of textSubPaths(node)) out.push(transformSubPath(sp, space))
    return
  }
  // A frame that paints covers its own rectangle, and it clips its children to
  // that rectangle anyway, so the rectangle is the whole answer. A frame that
  // paints nothing is just a box holding shapes, and taking its rectangle would
  // grow the mask to the box that the group case exists to avoid.
  if (isContainer(node) && !(isFrameLike(node) && paintsItself(node))) {
    for (const cid of node.children) {
      const child = scene.getNode(cid)
      if (!child || !child.visible) continue
      // A mask INSIDE the subtree clips its own siblings; that nesting is the
      // renderers' business, not this one's. Its coverage still counts.
      collectCoverage(scene, child, matMultiply(space, scene.localMatrix(child)), out)
    }
    return
  }
  if (!paintsItself(node)) return
  for (const sp of nodeOutline(node)) out.push(transformSubPath(sp, space))
}

/**
 * The shape a mask node clips to, in its own local space.
 *
 * Every mask is a hard-edged clip here. Figma's ALPHA and LUMINANCE masks fade
 * where the mask is semi-transparent; ours does not, which is identical for the
 * solid shapes that make up nearly every mask and hard-edged where theirs would
 * be soft. The `.fig` importer says so per file rather than leaving it to be
 * discovered.
 */
export function maskShape(scene: SceneGraph, node: SceneNode): MaskShape {
  if (node.type === 'BOOLEAN') {
    return { subpaths: ringsToSubPaths(booleanRings(scene, node)), evenOdd: true }
  }
  if (node.type === 'TEXT') {
    const glyphs = textSubPaths(node)
    // No shaping engine for this node: there are no outlines to clip to, so the
    // box is the only shape available. Same fallback the painted text uses.
    return { subpaths: glyphs.length > 0 ? glyphs : nodeOutline(node), evenOdd: false }
  }
  if (node.type === 'GROUP') {
    const out: SubPath[] = []
    collectCoverage(scene, node, IDENTITY, out)
    // An empty group masks nothing at all; its box would mask everything.
    return { subpaths: out, evenOdd: false }
  }
  return {
    subpaths: nodeOutline(node),
    // A vector's own rule, which is how a subtracted shape keeps its holes when
    // it is the mask. Canvas2D used to clip every non-boolean mask NONZERO while
    // the GPU backend tessellated the same node EVEN-ODD, so the two renderers
    // disagreed about any imported boolean used as a mask.
    evenOdd: node.type === 'VECTOR' && node.windingRule === 'EVENODD',
  }
}
