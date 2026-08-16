// GPU/Canvas2D render parity + performance harness (Sprint D gates).
// Booted via POLYFORM_RENDER_TEST=1 (main appends ?renderTest=1); logs
// RENDER_TEST lines to the console, ending with RENDER_TEST_DONE.
//
// Parity metric per fixture: fraction of pixels whose max channel delta
// exceeds 24/255 ("bad pixels") between the Canvas2D and WebGPU renders of
// the SAME scene. Anti-aliasing coverage differs legitimately between the
// two rasterizers along every edge, so thresholds are per-fixture-tuned to
// edge density rather than zero. Effect fixtures additionally tolerate the
// difference between Chromium's box-blur gaussian approximation and the
// GPU's direct gaussian taps (low-frequency, sub-threshold in practice).

import { SceneGraph } from '../engine/scene'
import { SpatialIndex } from '../engine/spatial-index'
import { createNode } from '../engine/types'
import type { BooleanNode, SceneNode } from '../engine/types'
import { drawScene, type RenderOptions } from '../engine/render/canvas2d'
import { WebGPURenderer } from '../engine/render/webgpu/renderer'
import { assetCache } from '../engine/assets'
import { initWasmEngine, setEngineBackend, type BackendKind } from '../engine/backend'
import { preloadFont } from '../ui/fontloader'

const W = 640
const H = 480

function log(msg: string): void {
  console.log(`RENDER_TEST ${msg}`)
}

let nodeCounter = 0
function make<T extends SceneNode['type']>(
  scene: SceneGraph,
  type: T,
  parent: string | null,
  props: Partial<SceneNode>,
): SceneNode {
  const node = createNode(type, `n${++nodeCounter}`)
  Object.assign(node, props)
  scene.addNode(node, parent, scene.childListOf(parent ?? null).length)
  return node
}

type Fixture = {
  name: string
  badLimit: number
  build: (scene: SceneGraph) => void
  /** Force the text backend for this fixture (legacy-path regression). */
  textBackend?: BackendKind
}

const FIXTURES: Fixture[] = [
  {
    name: 'solid-shapes',
    badLimit: 0.02,
    build: (s) => {
      make(s, 'RECTANGLE', null, {
        x: 20, y: 20, width: 160, height: 100,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.9, g: 0.3, b: 0.25, a: 1 } }],
      })
      make(s, 'RECTANGLE', null, {
        x: 210, y: 20, width: 140, height: 100,
        cornerRadius: { tl: 24, tr: 8, br: 40, bl: 0 },
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.2, g: 0.6, b: 0.9, a: 1 } }],
      })
      make(s, 'ELLIPSE', null, {
        x: 380, y: 20, width: 130, height: 100,
        fills: [{ type: 'SOLID', visible: true, opacity: 0.8, color: { r: 0.4, g: 0.9, b: 0.4, a: 1 } }],
      })
      make(s, 'STAR', null, {
        x: 40, y: 160, width: 120, height: 120, pointCount: 5, innerRatio: 0.5,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.8, b: 0.2, a: 1 } }],
      })
      make(s, 'POLYGON', null, {
        x: 200, y: 160, width: 120, height: 120, pointCount: 6,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.7, g: 0.4, b: 0.9, a: 1 } }],
        rotation: 30,
      })
      make(s, 'RECTANGLE', null, {
        x: 360, y: 160, width: 120, height: 120, rotation: 45,
        fills: [{ type: 'SOLID', visible: true, opacity: 0.6, color: { r: 0.9, g: 0.5, b: 0.7, a: 1 } }],
      })
    },
  },
  {
    name: 'strokes-and-dashes',
    badLimit: 0.035,
    build: (s) => {
      const stroke = (r: number, g: number, b: number) => [
        { type: 'SOLID' as const, visible: true, opacity: 1, color: { r, g, b, a: 1 } },
      ]
      make(s, 'RECTANGLE', null, {
        x: 20, y: 20, width: 140, height: 90, fills: [],
        strokes: stroke(0.9, 0.3, 0.3), strokeWeight: 6, strokeAlign: 'CENTER',
      })
      make(s, 'RECTANGLE', null, {
        x: 190, y: 20, width: 140, height: 90, fills: [],
        strokes: stroke(0.3, 0.9, 0.5), strokeWeight: 10, strokeAlign: 'INSIDE',
      })
      make(s, 'RECTANGLE', null, {
        x: 360, y: 20, width: 140, height: 90, fills: [],
        strokes: stroke(0.4, 0.5, 0.95), strokeWeight: 8, strokeAlign: 'OUTSIDE',
      })
      make(s, 'ELLIPSE', null, {
        x: 20, y: 150, width: 150, height: 110, fills: [],
        strokes: stroke(0.95, 0.8, 0.3), strokeWeight: 5, strokeDash: [12, 6],
      })
      make(s, 'LINE', null, {
        x: 210, y: 170, width: 260, height: 0, rotation: 15,
        strokes: stroke(0.9, 0.9, 0.9), strokeWeight: 4, strokeDash: [8, 8],
      })
    },
  },
  {
    name: 'gradients',
    badLimit: 0.02,
    build: (s) => {
      make(s, 'RECTANGLE', null, {
        x: 20, y: 20, width: 260, height: 180,
        fills: [{
          type: 'GRADIENT_LINEAR', visible: true, opacity: 1,
          start: { x: 0, y: 0 }, end: { x: 1, y: 1 },
          stops: [
            { position: 0, color: { r: 1, g: 0.2, b: 0.2, a: 1 } },
            { position: 0.5, color: { r: 0.9, g: 0.9, b: 0.2, a: 1 } },
            { position: 1, color: { r: 0.2, g: 0.4, b: 1, a: 0.6 } },
          ],
        }],
      })
      make(s, 'ELLIPSE', null, {
        x: 320, y: 20, width: 200, height: 180,
        fills: [{
          type: 'GRADIENT_RADIAL', visible: true, opacity: 1,
          start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 },
          stops: [
            { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
            { position: 1, color: { r: 0.1, g: 0.5, b: 0.4, a: 1 } },
          ],
        }],
      })
    },
  },
  {
    name: 'frames-clip-opacity',
    badLimit: 0.02,
    build: (s) => {
      const frame = make(s, 'FRAME', null, {
        x: 30, y: 30, width: 250, height: 180, clipsContent: true, opacity: 0.85,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.15, g: 0.17, b: 0.2, a: 1 } }],
      })
      make(s, 'RECTANGLE', frame.id, {
        x: 180, y: 100, width: 160, height: 160, // overflows the frame
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.9, g: 0.4, b: 0.2, a: 1 } }],
      })
      const rotated = make(s, 'FRAME', null, {
        x: 330, y: 40, width: 200, height: 160, clipsContent: true, rotation: 20,
        cornerRadius: { tl: 30, tr: 30, br: 30, bl: 30 },
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.2, g: 0.25, b: 0.3, a: 1 } }],
      })
      make(s, 'ELLIPSE', rotated.id, {
        x: 120, y: 80, width: 160, height: 160, // overflows the rotated frame
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.4, g: 0.8, b: 0.9, a: 1 } }],
      })
      const group = make(s, 'GROUP', null, { x: 60, y: 260, width: 10, height: 10, opacity: 0.5 })
      make(s, 'RECTANGLE', group.id, {
        x: 0, y: 0, width: 120, height: 90,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.9, g: 0.2, b: 0.7, a: 1 } }],
      })
      make(s, 'RECTANGLE', group.id, {
        x: 60, y: 40, width: 120, height: 90,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.2, g: 0.9, b: 0.7, a: 1 } }],
      })
    },
  },
  {
    name: 'mask-boolean-vector',
    badLimit: 0.03,
    build: (s) => {
      const group = make(s, 'GROUP', null, { x: 20, y: 20, width: 10, height: 10 })
      make(s, 'ELLIPSE', group.id, {
        x: 0, y: 0, width: 180, height: 180, isMask: true, fills: [],
      })
      make(s, 'RECTANGLE', group.id, {
        x: -20, y: -20, width: 220, height: 220,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.6, b: 0.2, a: 1 } }],
      })
      const bool = make(s, 'BOOLEAN', null, { x: 260, y: 30, width: 10, height: 10 }) as BooleanNode
      bool.booleanOp = 'SUBTRACT'
      make(s, 'RECTANGLE', bool.id, {
        x: 0, y: 0, width: 160, height: 160,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.3, g: 0.7, b: 0.95, a: 1 } }],
      })
      make(s, 'ELLIPSE', bool.id, { x: 60, y: 60, width: 140, height: 140 })
      make(s, 'VECTOR', null, {
        x: 40, y: 260, width: 200, height: 160,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.5, g: 0.9, b: 0.5, a: 1 } }],
        strokes: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
        strokeWeight: 3,
        network: {
          vertices: [
            { id: 0, x: 0, y: 120 },
            { id: 1, x: 70, y: 0 },
            { id: 2, x: 150, y: 90 },
            { id: 3, x: 200, y: 20 },
          ],
          edges: [
            { id: 0, v0: 0, v1: 1, cp0: { x: 20, y: 40 }, cp1: null },
            { id: 1, v0: 1, v1: 2, cp0: null, cp1: { x: 100, y: 30 } },
            { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
            { id: 3, v0: 3, v1: 0, cp0: null, cp1: null },
          ],
        },
      })
    },
  },
  {
    // A GROUP used as a mask clips to the UNION OF WHAT IS INSIDE IT. Clipping to
    // its box instead shows the whole rectangle, which is what an imported logo
    // did (F-33). Three fixtures rather than one, so the gate names the mask that
    // broke instead of just the subject.
    name: 'mask-group-coverage',
    badLimit: 0.03,
    build: (s) => {
      const letters = make(s, 'GROUP', null, { x: 40, y: 60, width: 320, height: 320, isMask: true })
      make(s, 'ELLIPSE', letters.id, {
        x: 0, y: 0, width: 120, height: 120,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
      })
      make(s, 'RECTANGLE', letters.id, {
        x: 180, y: 180, width: 140, height: 140, cornerRadius: { tl: 30, tr: 0, br: 30, bl: 0 },
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
      })
      make(s, 'RECTANGLE', null, {
        x: 40, y: 60, width: 320, height: 320,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.55, b: 0.2, a: 1 } }],
      })
    },
  },
  {
    // Two contours wound the SAME way: the inner square is a hole under even-odd
    // and solid under nonzero. A subtracted shape used as a mask is exactly this,
    // and it is what arrives from a `.fig`. Canvas2D clipped every non-boolean
    // mask NONZERO while the GPU tessellated the same node EVEN-ODD — a
    // divergence that sat inside a renderer with a parity gate, because no
    // fixture used a mask that was not a plain shape (F-22).
    name: 'mask-evenodd-vector',
    badLimit: 0.03,
    build: (s) => {
      const holed = make(s, 'GROUP', null, { x: 120, y: 60, width: 360, height: 360 })
      make(s, 'VECTOR', holed.id, {
        x: 0, y: 0, width: 360, height: 360, isMask: true, windingRule: 'EVENODD',
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
        network: {
          vertices: [
            { id: 1, x: 0, y: 0 }, { id: 2, x: 360, y: 0 }, { id: 3, x: 360, y: 360 }, { id: 4, x: 0, y: 360 },
            { id: 5, x: 90, y: 90 }, { id: 6, x: 270, y: 90 }, { id: 7, x: 270, y: 270 }, { id: 8, x: 90, y: 270 },
          ],
          edges: [
            { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
            { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
            { id: 3, v0: 3, v1: 4, cp0: null, cp1: null },
            { id: 4, v0: 4, v1: 1, cp0: null, cp1: null },
            { id: 5, v0: 5, v1: 6, cp0: null, cp1: null },
            { id: 6, v0: 6, v1: 7, cp0: null, cp1: null },
            { id: 7, v0: 7, v1: 8, cp0: null, cp1: null },
            { id: 8, v0: 8, v1: 5, cp0: null, cp1: null },
          ],
        },
      })
      make(s, 'RECTANGLE', holed.id, {
        x: 0, y: 0, width: 360, height: 360,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.3, g: 0.75, b: 0.95, a: 1 } }],
      })
    },
  },
  {
    // TEXT as a mask clips to its GLYPHS, from the same outlines the Canvas2D
    // path fills — the GPU tessellates them where it would normally draw atlas
    // quads, so this is the one place the two text paths meet on the same curves.
    name: 'mask-text-glyphs',
    badLimit: 0.05,
    build: (s) => {
      const titled = make(s, 'GROUP', null, { x: 30, y: 150, width: 580, height: 140 })
      make(s, 'TEXT', titled.id, {
        x: 0, y: 0, width: 580, height: 120, characters: 'MASKED', isMask: true,
        fontSize: 96, fontFamily: 'Arial', fontWeight: 700,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
      })
      make(s, 'RECTANGLE', titled.id, {
        x: 0, y: 0, width: 580, height: 130,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.55, g: 0.9, b: 0.5, a: 1 } }],
      })
    },
  },
  {
    // Per-side stroke weights are not a stroke either rasterizer can draw — there
    // is no single width to hand it — so both back ends fill the same REGION
    // instead (engine/strokesides). Canvas2D fills a Path2D, the GPU tessellates
    // it and skips its stencil clip, and this is what proves the two agree about
    // where a four-weight border sits.
    name: 'stroke-per-side',
    badLimit: 0.03,
    build: (s) => {
      const ink = (c: [number, number, number]) => [
        { type: 'SOLID' as const, visible: true, opacity: 1, color: { r: c[0], g: c[1], b: c[2], a: 1 } },
      ]
      // One side, inside: the band eats into the shape and nothing else moves.
      make(s, 'RECTANGLE', null, {
        x: 30, y: 30, width: 260, height: 110,
        fills: ink([0.22, 0.28, 0.34]),
        strokes: ink([1, 0.75, 0.2]),
        strokeWeight: 0,
        strokeAlign: 'INSIDE',
        strokeSides: { top: 0, right: 0, bottom: 0, left: 20 },
      })
      // Top and bottom, outside: the band grows past the shape, and the corners
      // stay square because the sides beside them have no stroke to mitre with.
      make(s, 'RECTANGLE', null, {
        x: 350, y: 30, width: 250, height: 110,
        fills: ink([0.3, 0.22, 0.18]),
        strokes: ink([0.4, 0.85, 0.95]),
        strokeWeight: 0,
        strokeAlign: 'OUTSIDE',
        strokeSides: { top: 14, right: 0, bottom: 14, left: 0 },
      })
      // Rounded, centred, three different weights: the radii travel with the
      // offsets, so this is where an outer corner that bulged would show.
      make(s, 'RECTANGLE', null, {
        x: 30, y: 200, width: 260, height: 120,
        cornerRadius: { tl: 28, tr: 28, br: 28, bl: 28 },
        fills: ink([0.18, 0.3, 0.26]),
        strokes: ink([0.95, 0.45, 0.55]),
        strokeWeight: 0,
        strokeAlign: 'CENTER',
        strokeSides: { top: 8, right: 22, bottom: 8, left: 0 },
      })
      // A frame with all four different, and content it clips: a per-side border
      // must not disturb the clip, and the widest side must not be cropped away.
      const frame = make(s, 'FRAME', null, {
        x: 350, y: 200, width: 250, height: 120,
        clipsContent: true,
        cornerRadius: { tl: 10, tr: 10, br: 10, bl: 10 },
        fills: ink([0.24, 0.24, 0.3]),
        strokes: ink([0.6, 0.95, 0.5]),
        strokeWeight: 0,
        strokeAlign: 'INSIDE',
        strokeSides: { top: 3, right: 10, bottom: 20, left: 30 },
      })
      make(s, 'ELLIPSE', frame.id, {
        x: 60, y: 20, width: 130, height: 80,
        fills: ink([0.9, 0.6, 0.3]),
      })
      // And the uniform path must still be the uniform path: four equal weights
      // that match strokeWeight fall back to the rasterizer's own band.
      make(s, 'RECTANGLE', null, {
        x: 30, y: 370, width: 570, height: 70,
        cornerRadius: { tl: 12, tr: 12, br: 12, bl: 12 },
        fills: ink([0.2, 0.2, 0.22]),
        strokes: ink([0.85, 0.85, 0.9]),
        strokeWeight: 6,
        strokeAlign: 'INSIDE',
        strokeSides: { top: 6, right: 6, bottom: 6, left: 6 },
      })
    },
  },
  {
    // Per-side weights on shapes that are NOT boxes: their sides are the four
    // WEDGES of the bounding box rather than four offsettable edges. Canvas2D clips
    // an ordinary stroke to each wedge; the GPU pushes the wedge as a stencil and
    // draws a band tessellated at that width. Two completely different mechanisms
    // for one picture, which is the pair most likely to drift.
    //
    // Its own fixture, and the shapes fill the frame ON PURPOSE. Sharing the box
    // fixture, an ellipse and a star left so little ink that disabling the GPU's
    // wedge path entirely still measured 2.18% against a 3% limit — a gate that
    // passes while the thing it guards is switched off is not a gate (F-22).
    name: 'stroke-per-side-path',
    badLimit: 0.03,
    build: (s) => {
      const ink = (c: [number, number, number]) => [
        { type: 'SOLID' as const, visible: true, opacity: 1, color: { r: c[0], g: c[1], b: c[2], a: 1 } },
      ]
      make(s, 'ELLIPSE', null, {
        x: 20, y: 20, width: 290, height: 200,
        fills: ink([0.2, 0.24, 0.3]),
        strokes: ink([0.95, 0.8, 0.3]),
        strokeWeight: 0,
        strokeAlign: 'INSIDE',
        strokeSides: { top: 34, right: 0, bottom: 14, left: 0 },
      })
      make(s, 'STAR', null, {
        x: 340, y: 15, width: 280, height: 210, pointCount: 5, innerRatio: 0.45,
        fills: ink([0.26, 0.2, 0.3]),
        strokes: ink([0.5, 0.9, 0.95]),
        strokeWeight: 0,
        strokeAlign: 'CENTER',
        strokeSides: { top: 22, right: 10, bottom: 0, left: 10 },
      })
      // The case this generalisation exists for: a rectangle with a wavy top that
      // wants a rim along the wave and nothing anywhere else.
      make(s, 'VECTOR', null, {
        x: 20, y: 250, width: 600, height: 210,
        windingRule: 'NONZERO',
        fills: ink([0.56, 0.63, 0.67]),
        strokes: ink([0.3, 0.35, 0.4]),
        strokeWeight: 0,
        strokeAlign: 'INSIDE',
        strokeSides: { top: 40, right: 0, bottom: 0, left: 0 },
        network: {
          vertices: [
            { id: 1, x: 0, y: 40 }, { id: 2, x: 150, y: 6 }, { id: 3, x: 300, y: 56 },
            { id: 4, x: 450, y: 6 }, { id: 5, x: 600, y: 40 },
            { id: 6, x: 600, y: 210 }, { id: 7, x: 0, y: 210 },
          ],
          edges: [
            { id: 1, v0: 1, v1: 2, cp0: { x: 75, y: 40 }, cp1: { x: 75, y: 6 } },
            { id: 2, v0: 2, v1: 3, cp0: { x: 225, y: 6 }, cp1: { x: 225, y: 56 } },
            { id: 3, v0: 3, v1: 4, cp0: { x: 375, y: 56 }, cp1: { x: 375, y: 6 } },
            { id: 4, v0: 4, v1: 5, cp0: { x: 525, y: 6 }, cp1: { x: 525, y: 40 } },
            { id: 5, v0: 5, v1: 6, cp0: null, cp1: null },
            { id: 6, v0: 6, v1: 7, cp0: null, cp1: null },
            { id: 7, v0: 7, v1: 1, cp0: null, cp1: null },
          ],
        },
      })
    },
  },
  {
    // Stroke caps. They are FILLED GEOMETRY, not a rasterizer setting, so both
    // back ends have to build the same shapes and put them in the same place —
    // and an arrowhead is the sort of thing that comes out mirrored or rotated
    // on one of them and looks plausible either way.
    //
    // Thick strokes and frame-filling lines on purpose (F-35): a cap on a 2px
    // line is a handful of pixels and could not breach any limit however wrong.
    name: 'stroke-caps',
    // 2%, not the 3% most fixtures use: healthy measures 0.45% and the GPU cap
    // path switched off measures 3.94%, so a 3% limit would have left a gate
    // with almost no daylight either side of it.
    badLimit: 0.02,
    build: (s) => {
      const ink = (c: [number, number, number]) => [
        { type: 'SOLID' as const, visible: true, opacity: 1, color: { r: c[0], g: c[1], b: c[2], a: 1 } },
      ]
      const kinds = ['ROUND', 'SQUARE', 'ROUND_SQUARE', 'ARROW', 'CIRCLE', 'DIAMOND'] as const
      kinds.forEach((kind, i) => {
        make(s, 'LINE', null, {
          x: 90,
          y: 34 + i * 52,
          width: 460,
          height: 0,
          strokes: ink([0.95, 0.72, 0.3]),
          // Fat on purpose. Caps scale with the weight, and at 16 the whole set
          // covered so little of the canvas that switching the GPU's cap path
          // OFF still measured 1.28% against a 3% limit — a gate that passes
          // while the thing it guards is gone (F-35, again).
          strokeWeight: 30,
          strokeAlign: 'CENTER',
          // Different at each end, which is the case `lineCap` could never have
          // expressed and therefore the one most likely to be got wrong.
          strokeCapStart: kind,
          strokeCapEnd: kinds[(i + 2) % kinds.length],
        })
      })
      // A curved open path too: the cap direction comes from the tangent, and a
      // back end reading the chord instead would aim these visibly wrong.
      make(s, 'VECTOR', null, {
        x: 40,
        y: 330,
        width: 560,
        height: 130,
        windingRule: 'NONZERO',
        fills: [],
        strokes: ink([0.45, 0.85, 0.95]),
        strokeWeight: 30,
        strokeAlign: 'CENTER',
        strokeCapStart: 'ARROW',
        strokeCapEnd: 'ARROW',
        network: {
          vertices: [
            { id: 1, x: 0, y: 150 },
            { id: 2, x: 560, y: 150 },
          ],
          edges: [{ id: 1, v0: 1, v1: 2, cp0: { x: 60, y: -40 }, cp1: { x: 500, y: -40 } }],
        },
      })
    },
  },
  {
    // Per-part fills: one VECTOR node whose detached outlines carry different
    // colours. Both back ends have to agree on which outline is which — the GPU
    // builds a separate mesh per part and Canvas2D fills a separate path, from
    // the same grouping, so a disagreement about part IDENTITY shows up here as
    // whole shapes in the wrong colour rather than as edge noise.
    //
    // Frame-filling on purpose. F-35's lesson: a fixture whose shapes cover a
    // few percent of the canvas cannot breach a 2% limit however wrong it is.
    name: 'vector-part-fills',
    badLimit: 0.02,
    build: (s) => {
      const solid = (c: [number, number, number]) => [
        { type: 'SOLID' as const, visible: true, opacity: 1, color: { r: c[0], g: c[1], b: c[2], a: 1 } },
      ]
      const box = (base: number, x0: number, y0: number, x1: number, y1: number) => ({
        vertices: [
          { id: base + 1, x: x0, y: y0 },
          { id: base + 2, x: x1, y: y0 },
          { id: base + 3, x: x1, y: y1 },
          { id: base + 4, x: x0, y: y1 },
        ],
        edges: [
          { id: base + 1, v0: base + 1, v1: base + 2, cp0: null, cp1: null },
          { id: base + 2, v0: base + 2, v1: base + 3, cp0: null, cp1: null },
          { id: base + 3, v0: base + 3, v1: base + 4, cp0: null, cp1: null },
          { id: base + 4, v0: base + 4, v1: base + 1, cp0: null, cp1: null },
        ],
      })
      // Four bands across the frame: two painted, two left on the node fill, so
      // both the exception path and the leftovers group are exercised.
      const a = box(0, 0, 0, 600, 100)
      const b = box(10, 0, 110, 600, 210)
      const c = box(20, 0, 220, 600, 320)
      const d = box(30, 0, 330, 600, 430)
      make(s, 'VECTOR', null, {
        x: 20,
        y: 20,
        width: 600,
        height: 430,
        windingRule: 'NONZERO',
        fills: solid([0.25, 0.3, 0.42]),
        strokes: solid([0.9, 0.9, 0.95]),
        strokeWeight: 2,
        strokeAlign: 'CENTER',
        network: {
          vertices: [...a.vertices, ...b.vertices, ...c.vertices, ...d.vertices],
          edges: [...a.edges, ...b.edges, ...c.edges, ...d.edges],
        },
        // Keyed by the smallest anchor id in each part: 1, 11, 21, 31.
        partFills: {
          '11': solid([0.95, 0.42, 0.28]),
          '31': solid([0.35, 0.8, 0.45]),
        },
      })
    },
  },
  {
    // Flips ride in the node matrix, and the GPU backend bakes its own copy of
    // every transform — so a mirrored node is exactly the sort of thing that can
    // come out right on one rasterizer and backwards on the other. Every shape
    // here is asymmetric on purpose; a mirrored square proves nothing.
    name: 'flip-transforms',
    badLimit: 0.02,
    build: (s) => {
      const wedge = () => ({
        windingRule: 'NONZERO' as const,
        network: {
          vertices: [
            { id: 1, x: 0, y: 0 },
            { id: 2, x: 130, y: 0 },
            { id: 3, x: 130, y: 40 },
            { id: 4, x: 46, y: 40 },
            { id: 5, x: 46, y: 120 },
            { id: 6, x: 0, y: 120 },
          ],
          edges: [1, 2, 3, 4, 5, 6].map((i, k, all) => ({
            id: i,
            v0: all[k],
            v1: all[(k + 1) % all.length],
            cp0: null,
            cp1: null,
          })),
        },
      })
      const variants: { x: number; y: number; flipH?: boolean; flipV?: boolean; rotation?: number }[] = [
        { x: 30, y: 30 },
        { x: 200, y: 30, flipH: true },
        { x: 370, y: 30, flipV: true },
        { x: 30, y: 200, flipH: true, flipV: true },
        { x: 200, y: 200, rotation: 33, flipH: true },
        { x: 370, y: 200, rotation: -57, flipH: true, flipV: true },
      ]
      for (const v of variants) {
        make(s, 'VECTOR', null, {
          ...wedge(),
          x: v.x,
          y: v.y,
          width: 130,
          height: 120,
          rotation: v.rotation ?? 0,
          flipH: v.flipH,
          flipV: v.flipV,
          fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.45, g: 0.75, b: 0.95, a: 1 } }],
          strokes: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
          strokeWeight: 2,
        })
      }
      // An image fill mirrors with the node; a gradient must mirror with it too,
      // since both are painted in node-local space.
      for (const [i, f] of [{}, { flipH: true }, { flipV: true }].entries()) {
        make(s, 'RECTANGLE', null, {
          x: 30 + i * 170,
          y: 350,
          width: 140,
          height: 90,
          cornerRadius: { tl: 28, tr: 0, br: 0, bl: 0 },
          ...f,
          fills: [
            {
              type: 'GRADIENT_LINEAR',
              visible: true,
              opacity: 1,
              start: { x: 0, y: 0 },
              end: { x: 1, y: 0 },
              stops: [
                { position: 0, color: { r: 0.95, g: 0.6, b: 0.2, a: 1 } },
                { position: 1, color: { r: 0.2, g: 0.25, b: 0.4, a: 1 } },
              ],
            },
          ],
        })
      }
    },
  },
  {
    // Per-point corner radius: the fillet is generated in the outline, so both
    // rasterizers see the same path — and the tessellator has to walk the arcs
    // the same way Canvas2D does.
    name: 'vector-corner-radius',
    // Measured 0.30% on Ampere; the limit leaves room for another rasterizer's
    // anti-aliasing without leaving room for a wrong fillet.
    badLimit: 0.02,
    build: (s) => {
      const arrow = (radius: number): { id: number; x: number; y: number; cornerRadius?: number }[] => [
        { id: 0, x: 0, y: 60, cornerRadius: radius },
        { id: 1, x: 60, y: 0, cornerRadius: radius },
        { id: 2, x: 120, y: 60, cornerRadius: radius },
        { id: 3, x: 90, y: 60, cornerRadius: radius },
        { id: 4, x: 90, y: 140, cornerRadius: radius },
        { id: 5, x: 30, y: 140, cornerRadius: radius },
        { id: 6, x: 30, y: 60, cornerRadius: radius },
      ]
      const ring = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ id: i, v0: i, v1: (i + 1) % n, cp0: null, cp1: null }))
      // Sharp, gently rounded, and asking for far more than the short edges can
      // give (which the clamp turns into the roundest this outline can be).
      for (const [i, r] of [0, 10, 400].entries()) {
        make(s, 'VECTOR', null, {
          x: 30 + i * 200,
          y: 30,
          width: 120,
          height: 140,
          fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.35, g: 0.7, b: 0.95, a: 1 } }],
          strokes: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
          strokeWeight: 2,
          network: { vertices: arrow(r), edges: ring(7) },
        })
      }
      // One rounded point next to a curved segment: it must stay sharp, in both
      // renderers, or they disagree about where the outline goes.
      make(s, 'VECTOR', null, {
        x: 60,
        y: 230,
        width: 200,
        height: 200,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.75, b: 0.3, a: 1 } }],
        network: {
          vertices: [
            { id: 0, x: 0, y: 0, cornerRadius: 40 },
            { id: 1, x: 200, y: 20, cornerRadius: 40 },
            { id: 2, x: 120, y: 200, cornerRadius: 40 },
          ],
          edges: [
            { id: 0, v0: 0, v1: 1, cp0: { x: 60, y: -60 }, cp1: null },
            { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
            { id: 2, v0: 2, v1: 0, cp0: null, cp1: null },
          ],
        },
      })
    },
  },
  {
    name: 'effects-shadows',
    badLimit: 0.04,
    build: (s) => {
      make(s, 'RECTANGLE', null, {
        x: 40, y: 40, width: 140, height: 90,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.9, g: 0.35, b: 0.3, a: 1 } }],
        effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.6 }, offset: { x: 8, y: 8 }, blur: 14 }],
      })
      make(s, 'RECTANGLE', null, {
        x: 250, y: 40, width: 140, height: 90, rotation: 25,
        cornerRadius: { tl: 20, tr: 20, br: 20, bl: 20 },
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.3, g: 0.6, b: 0.95, a: 1 } }],
        effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0.1, g: 0.2, b: 0.6, a: 0.7 }, offset: { x: -6, y: 10 }, blur: 10 }],
      })
      make(s, 'ELLIPSE', null, {
        x: 450, y: 40, width: 130, height: 100,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.85, b: 0.4, a: 1 } }],
        effects: [{ type: 'INNER_SHADOW', visible: true, color: { r: 0.4, g: 0.1, b: 0, a: 0.8 }, offset: { x: 6, y: 6 }, blur: 12 }],
      })
      make(s, 'RECTANGLE', null, {
        x: 60, y: 220, width: 160, height: 110,
        cornerRadius: { tl: 12, tr: 12, br: 12, bl: 12 },
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.25, g: 0.75, b: 0.55, a: 1 } }],
        effects: [
          { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 12 }, blur: 18 },
          { type: 'INNER_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.55 }, offset: { x: 0, y: -6 }, blur: 8 },
        ],
      })
      make(s, 'TEXT', null, {
        x: 280, y: 250, width: 320, height: 60, characters: 'Shadowed text',
        fontSize: 34, fontFamily: 'Arial',
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
        effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.8 }, offset: { x: 4, y: 4 }, blur: 6 }],
      })
    },
  },
  {
    // Effects on a container apply to its composite: one shadow around the
    // union of the children, none in the seam where they touch.
    name: 'group-effects',
    badLimit: 0.045,
    build: (s) => {
      // A speech bubble: rounded body + a tail that overlaps it. Per-child
      // shadows would draw a hard edge along the join.
      const bubble = make(s, 'GROUP', null, {
        effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.65 }, offset: { x: 0, y: 10 }, blur: 16 }],
      })
      make(s, 'RECTANGLE', bubble.id, {
        x: 50, y: 40, width: 220, height: 130,
        cornerRadius: { tl: 28, tr: 28, br: 28, bl: 28 },
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.85, g: 0.85, b: 0.87, a: 1 } }],
      })
      make(s, 'POLYGON', bubble.id, {
        x: 120, y: 150, width: 70, height: 70, pointCount: 3, rotation: 180,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.85, g: 0.85, b: 0.87, a: 1 } }],
      })
      // An unpainted frame casts from its children too — it has no outline of
      // its own to cast from.
      const frame = make(s, 'FRAME', null, {
        x: 330, y: 30, width: 260, height: 190, fills: [], clipsContent: false,
        effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0.15, g: 0.05, b: 0.3, a: 0.75 }, offset: { x: 8, y: 8 }, blur: 8 }],
      })
      make(s, 'ELLIPSE', frame.id, {
        x: 20, y: 30, width: 110, height: 110,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.6, b: 0.3, a: 1 } }],
      })
      make(s, 'RECTANGLE', frame.id, {
        x: 90, y: 70, width: 130, height: 90, rotation: 15,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.35, g: 0.8, b: 0.7, a: 1 } }],
      })
      // Layer blur on a group blurs the assembled picture, not each piece.
      const blurred = make(s, 'GROUP', null, {
        effects: [{ type: 'LAYER_BLUR', visible: true, radius: 6 }],
      })
      make(s, 'RECTANGLE', blurred.id, {
        x: 70, y: 280, width: 150, height: 110,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.9, g: 0.35, b: 0.45, a: 1 } }],
      })
      make(s, 'ELLIPSE', blurred.id, {
        x: 170, y: 300, width: 130, height: 100,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.3, g: 0.55, b: 0.95, a: 1 } }],
      })
    },
  },
  {
    name: 'effects-blurs',
    badLimit: 0.06,
    build: (s) => {
      // Colorful backdrop for the background-blur panel.
      make(s, 'RECTANGLE', null, {
        x: 60, y: 60, width: 200, height: 160,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.9, g: 0.3, b: 0.4, a: 1 } }],
      })
      make(s, 'ELLIPSE', null, {
        x: 160, y: 100, width: 180, height: 140,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.25, g: 0.55, b: 0.95, a: 1 } }],
      })
      make(s, 'RECTANGLE', null, {
        x: 120, y: 90, width: 180, height: 100, rotation: 12,
        fills: [{ type: 'SOLID', visible: true, opacity: 0.5, color: { r: 1, g: 1, b: 1, a: 1 } }],
        cornerRadius: { tl: 16, tr: 16, br: 16, bl: 16 },
        effects: [{ type: 'BACKGROUND_BLUR', visible: true, radius: 10 }],
      })
      // Layer blurs on single shapes (identical semantics in both backends).
      make(s, 'RECTANGLE', null, {
        x: 400, y: 60, width: 140, height: 100,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.4, g: 0.9, b: 0.5, a: 1 } }],
        effects: [{ type: 'LAYER_BLUR', visible: true, radius: 8 }],
      })
      make(s, 'STAR', null, {
        x: 400, y: 240, width: 130, height: 130, pointCount: 5, innerRatio: 0.5,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.7, b: 0.25, a: 1 } }],
        effects: [{ type: 'LAYER_BLUR', visible: true, radius: 5 }],
      })
    },
  },
  {
    name: 'blend-modes',
    badLimit: 0.03,
    build: (s) => {
      make(s, 'RECTANGLE', null, {
        x: 20, y: 20, width: 600, height: 420,
        fills: [{
          type: 'GRADIENT_LINEAR', visible: true, opacity: 1,
          start: { x: 0, y: 0 }, end: { x: 1, y: 1 },
          stops: [
            { position: 0, color: { r: 0.85, g: 0.35, b: 0.25, a: 1 } },
            { position: 0.5, color: { r: 0.25, g: 0.6, b: 0.85, a: 1 } },
            { position: 1, color: { r: 0.35, g: 0.85, b: 0.45, a: 1 } },
          ],
        }],
      })
      const modes = [
        'MULTIPLY', 'SCREEN', 'OVERLAY', 'DARKEN', 'LIGHTEN', 'COLOR_DODGE',
        'COLOR_BURN', 'HARD_LIGHT', 'SOFT_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE',
      ] as const
      modes.forEach((mode, i) => {
        make(s, 'RECTANGLE', null, {
          x: 50 + (i % 4) * 140, y: 50 + Math.floor(i / 4) * 130, width: 110, height: 100,
          blendMode: mode,
          fills: [{ type: 'SOLID', visible: true, opacity: 0.9, color: { r: 0.75, g: 0.55, b: 0.35, a: 1 } }],
        })
      })
    },
  },
  {
    name: 'text',
    badLimit: 0.05,
    build: (s) => {
      make(s, 'TEXT', null, {
        x: 30, y: 40, width: 400, height: 60, characters: 'Polyform GPU rendering',
        fontSize: 32, fontFamily: 'Arial',
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
      })
      make(s, 'TEXT', null, {
        x: 30, y: 130, width: 460, height: 200,
        characters: 'The quick brown fox jumps over the lazy dog 0123456789',
        fontSize: 18, fontFamily: 'Arial', lineHeight: 1.4,
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.7, g: 0.85, b: 1, a: 1 } }],
      })
    },
  },
  {
    // Shaped stack features: kerning pairs, ligatures, alignment, rotation.
    // Both backends consume the SAME rustybuzz layout; the diff measures
    // outline-fill (Canvas2D) vs atlas-quad (GPU) rasterization only.
    name: 'text-shaping',
    badLimit: 0.05,
    build: (s) => {
      make(s, 'TEXT', null, {
        x: 30, y: 30, width: 560, height: 50, characters: 'AVATAR Wavery To LTA offific',
        fontSize: 30, fontFamily: 'Arial',
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 0.95, b: 0.85, a: 1 } }],
      })
      make(s, 'TEXT', null, {
        x: 30, y: 110, width: 280, height: 120, autoResize: 'NONE',
        characters: 'Centered lines\nwith fixed box metrics',
        fontSize: 20, fontFamily: 'Arial', lineHeight: 1.3,
        textAlignH: 'CENTER', textAlignV: 'CENTER',
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.6, g: 0.9, b: 0.7, a: 1 } }],
      })
      make(s, 'TEXT', null, {
        x: 340, y: 110, width: 260, height: 120, autoResize: 'NONE',
        characters: 'Right-aligned\nletter spaced',
        fontSize: 20, fontFamily: 'Arial', letterSpacing: 2, textAlignH: 'RIGHT',
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.95, g: 0.7, b: 0.6, a: 1 } }],
      })
      make(s, 'TEXT', null, {
        x: 80, y: 290, width: 380, height: 60, rotation: -8,
        characters: 'Rotated shaped text 12345',
        fontSize: 28, fontFamily: 'Arial',
        fills: [{ type: 'SOLID', visible: true, opacity: 0.9, color: { r: 0.7, g: 0.8, b: 1, a: 1 } }],
      })
    },
  },
  {
    // Regression guard: the legacy Canvas2D raster path must stay intact
    // (it is the fallback while fonts load, for non-SOLID text fills, and
    // for the 'text' backend flag set to 'ts').
    name: 'text-legacy',
    badLimit: 0.04,
    textBackend: 'ts',
    build: (s) => {
      make(s, 'TEXT', null, {
        x: 30, y: 40, width: 500, height: 60, characters: 'Legacy raster text path',
        fontSize: 32, fontFamily: 'Arial',
        fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
      })
    },
  },
]

function renderCanvas2d(scene: SceneGraph, opts: RenderOptions): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')! as unknown as CanvasRenderingContext2D
  drawScene(ctx, scene, new SpatialIndex(), opts)
  return (ctx as unknown as OffscreenCanvasRenderingContext2D).getImageData(0, 0, W, H).data
}

function compare(a: Uint8ClampedArray, b: Uint8ClampedArray): { bad: number; mean: number } {
  let bad = 0
  let sum = 0
  const n = W * H
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const d = Math.max(
      Math.abs(a[o] - b[o]),
      Math.abs(a[o + 1] - b[o + 1]),
      Math.abs(a[o + 2] - b[o + 2]),
    )
    sum += d
    if (d > 24) bad++
  }
  return { bad: bad / n, mean: sum / n }
}

async function runParity(gpu: WebGPURenderer): Promise<boolean> {
  let allPass = true
  for (const fixture of FIXTURES) {
    if (fixture.textBackend) setEngineBackend('text', fixture.textBackend)
    const scene = new SceneGraph()
    fixture.build(scene)
    const opts: RenderOptions = {
      width: W,
      height: H,
      dpr: 1,
      camera: { x: 0, y: 0, zoom: 1 },
      showGrid: false,
      assets: assetCache,
      background: '#1e1e1e',
    }
    const reference = renderCanvas2d(scene, opts)
    gpu.invalidate()
    gpu.render(scene, opts)
    const result = await gpu.readback()
    const { bad, mean } = compare(reference, result.data)
    const pass = bad <= fixture.badLimit
    allPass = allPass && pass
    log(
      `parity ${fixture.name}: badPixels=${(bad * 100).toFixed(2)}% mean=${mean.toFixed(2)} limit=${(fixture.badLimit * 100).toFixed(1)}% ${pass ? 'PASS' : 'FAIL'}`,
    )
    if (fixture.textBackend) setEngineBackend('text', 'wasm')
  }
  return allPass
}

async function runPerf(gpu: WebGPURenderer): Promise<void> {
  const scene = new SceneGraph()
  const COUNT = 100_000
  const cols = Math.ceil(Math.sqrt(COUNT))
  for (let i = 0; i < COUNT; i++) {
    const node = createNode('RECTANGLE', `r${i}`)
    node.x = (i % cols) * 14
    node.y = Math.floor(i / cols) * 14
    node.width = 10
    node.height = 10
    node.fills = [
      {
        type: 'SOLID',
        visible: true,
        opacity: 1,
        color: { r: (i % 255) / 255, g: ((i * 7) % 255) / 255, b: ((i * 13) % 255) / 255, a: 1 },
      },
    ]
    scene.addNode(node, null, i)
  }
  const opts: RenderOptions = {
    width: W,
    height: H,
    dpr: 1,
    camera: { x: 0, y: 0, zoom: 0.15 },
    showGrid: false,
    assets: assetCache,
  }
  const bakeStart = performance.now()
  gpu.invalidate()
  gpu.render(scene, opts)
  const bakeMs = performance.now() - bakeStart
  // RAF-paced pan over the baked scene: wall fps is display/GPU bound,
  // cpu ms is the per-frame encode cost (the number the exit test owns —
  // wall time on a software adapter measures the rasterizer, not us).
  const FRAMES = 90
  const raf = () => new Promise<number>((r) => requestAnimationFrame(r))
  await raf()
  let cpuMs = 0
  const t0 = performance.now()
  for (let f = 0; f < FRAMES; f++) {
    opts.camera = { x: f * 3, y: f * 2, zoom: 0.15 }
    const c0 = performance.now()
    gpu.render(scene, opts)
    cpuMs += performance.now() - c0
    if (f === 45) {
      const t = gpu.lastTimings
      log(
        `perf phases @f45: texture=${t.texture.toFixed(1)} begin=${t.begin.toFixed(1)} loop=${t.loop.toFixed(1)} endPass=${t.end.toFixed(1)} submit=${t.submit.toFixed(1)} segments=${t.segments} indices=${t.indices}`,
      )
    }
    await raf()
  }
  const wallMs = (performance.now() - t0) / FRAMES
  const cpuPerFrame = cpuMs / FRAMES
  log(
    `perf 100k rects: bake=${bakeMs.toFixed(0)}ms cpu=${cpuPerFrame.toFixed(2)}ms/frame wall=${wallMs.toFixed(1)}ms/frame (${(1000 / wallMs).toFixed(0)}fps) bakes=${gpu.bakeCount} ${cpuPerFrame < 8 ? 'CPU-PASS' : 'CPU-FAIL'}`,
  )
}

export async function runRenderTest(): Promise<void> {
  try {
    log('starting')
    await initWasmEngine()
    // Shaped-text fixtures need Arial's bytes in the engine before baking.
    await preloadFont('Arial')
    if (!WebGPURenderer.isSupported()) {
      log('FATAL WebGPU unsupported in this environment')
      log('RENDER_TEST_DONE result=FAIL')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    canvas.style.position = 'fixed'
    canvas.style.left = '-10000px'
    document.body.appendChild(canvas)
    const gpu = await WebGPURenderer.create(canvas)
    if (!gpu) {
      log('FATAL WebGPU adapter/device unavailable')
      log('RENDER_TEST_DONE result=FAIL')
      return
    }
    log(`adapter: ${gpu.adapterInfo || 'unknown'}`)
    const parityOk = await runParity(gpu)
    await runPerf(gpu)
    log(`RENDER_TEST_DONE result=${parityOk ? 'PASS' : 'FAIL'}`)
  } catch (err) {
    log(`FATAL ${String(err)} ${(err as Error).stack?.split('\n')[1] ?? ''}`)
    log('RENDER_TEST_DONE result=FAIL')
  }
}
