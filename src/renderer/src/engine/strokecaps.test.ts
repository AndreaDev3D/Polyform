// The ends of an open stroke.
//
// Caps are geometry rather than a rasterizer setting, so the geometry is the
// behaviour: get it wrong and the arrowhead points the wrong way on the canvas,
// in the GPU mesh and in the exported SVG at once. Every case below is stated
// as where the shape ends up, because that is the only thing three back ends
// can agree or disagree about.

import { describe, expect, it } from 'vitest'
import { createNode, type LineNode, type VectorNode } from './types'
import { nodeOutline, type SubPath } from './shapes'
import { STROKE_CAPS, capShape, openEnds, strokeCapShapes, strokeCapsApply } from './strokecaps'
import { SceneGraph } from './scene'
import { rgba } from './types'

/** A horizontal line 100 long, weight 10. */
function line(): LineNode {
  const node = createNode('LINE', 'l') as LineNode
  node.width = 100
  node.height = 0
  node.strokeWeight = 10
  return node
}

function bounds(paths: SubPath[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const sp of paths) {
    for (const a of sp.anchors) {
      minX = Math.min(minX, a.p.x)
      minY = Math.min(minY, a.p.y)
      maxX = Math.max(maxX, a.p.x)
      maxY = Math.max(maxY, a.p.y)
    }
  }
  return { minX, minY, maxX, maxY }
}

describe('stroke caps', () => {
  it('offers caps only where there are ends to cap', () => {
    expect(strokeCapsApply(line())).toBe(true)
    // A closed outline has no ends. Offering the control there would be a
    // setting that reads back and does nothing.
    const rect = createNode('RECTANGLE', 'r')
    rect.strokeWeight = 4
    expect(strokeCapsApply(rect)).toBe(false)
    // And a stroke of no width has nothing to finish.
    const thin = line()
    thin.strokeWeight = 0
    expect(strokeCapsApply(thin)).toBe(false)
  })

  it('points each end AWAY from the path', () => {
    const [run] = openEnds(nodeOutline(line()))
    expect(run.start.at).toEqual({ x: 0, y: 0 })
    expect(run.end.at).toEqual({ x: 100, y: 0 })
    // Outward: the start looks back down the negative x axis, the end forward.
    expect(run.start.dir.x).toBeCloseTo(-1, 9)
    expect(run.end.dir.x).toBeCloseTo(1, 9)
  })

  it('takes its direction from the CURVE, not the chord', () => {
    // A path that leaves its first anchor heading straight up but whose next
    // anchor is off to the right. An arrowhead aimed along the chord would
    // point somewhere the path never goes.
    const node = createNode('VECTOR', 'v') as VectorNode
    node.width = 100
    node.height = 100
    node.strokeWeight = 4
    node.windingRule = 'NONZERO'
    node.network = {
      vertices: [
        { id: 1, x: 0, y: 100 },
        { id: 2, x: 100, y: 100 },
      ],
      edges: [{ id: 1, v0: 1, v1: 2, cp0: { x: 0, y: 0 }, cp1: { x: 100, y: 0 } }],
    }
    const [run] = openEnds(nodeOutline(node))
    expect(run.start.dir.x).toBeCloseTo(0, 6)
    expect(run.start.dir.y).toBeCloseTo(1, 6)
  })

  it('puts the arrowhead AHEAD of the line, with its notch on the end', () => {
    const node = line()
    node.strokeCapEnd = 'ARROW'
    const caps = strokeCapShapes(node, nodeOutline(node))
    expect(caps).toHaveLength(1)
    const pts = caps[0].anchors.map((a) => a.p)
    const b = bounds(caps)
    // The point is out in FRONT. Built the other way first — tip on the end,
    // head growing backwards — which buries the point inside the stroke it
    // terminates and reads as a lump on a bar rather than as an arrow.
    expect(b.maxX).toBeCloseTo(100 + 1.8 * 10, 6)
    // …and the concave back sits exactly on the end, which is what a butt end
    // plugs flush. A gap here is a visible notch between line and head.
    const notch = pts.find((p) => Math.abs(p.y) < 1e-9 && p.x < b.maxX - 1e-9)
    expect(notch?.x).toBeCloseTo(100, 6)
    // The barbs reach back over the line rather than floating off the end.
    expect(b.minX).toBeCloseTo(100 - 0.8 * 10, 6)
    // Wider than the stroke, or it would not read as a head at all.
    expect(b.maxY - b.minY).toBeGreaterThan(node.strokeWeight)
  })

  it('turns the arrowhead round at the other end', () => {
    const node = line()
    node.strokeCapStart = 'ARROW'
    const b = bounds(strokeCapShapes(node, nodeOutline(node)))
    expect(b.minX).toBeCloseTo(-1.8 * 10, 6)
    expect(b.maxX).toBeCloseTo(0.8 * 10, 6)
  })

  it('leaves room in the node bounds for every cap it can draw', () => {
    // The bounds are not decoration: the same number is the EXPORT box, so a
    // cap outside them is a cap cropped off the PNG and the SVG — which is how
    // a line with arrowheads exported as a plain bar (F-42). Checked for every
    // kind, because the stroke's half-width is smaller than all of them.
    for (const kind of STROKE_CAPS) {
      if (kind === 'NONE') continue
      const scene = new SceneGraph()
      const node = line()
      node.x = 60
      node.y = 100
      node.strokes = [{ type: 'SOLID', visible: true, opacity: 1, color: rgba(0, 0, 0, 1) }]
      node.strokeCapStart = kind
      node.strokeCapEnd = kind
      scene.addNode(node, null, 0)
      const box = scene.worldAABB(node.id)
      for (const sp of strokeCapShapes(node, nodeOutline(node))) {
        for (const a of sp.anchors) {
          const p = { x: a.p.x + node.x, y: a.p.y + node.y }
          expect(
            p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY,
            `${kind} cap point ${p.x},${p.y} is outside the node's bounds`,
          ).toBe(true)
        }
      }
    }
  })

  it('caps the two ends independently', () => {
    const node = line()
    node.strokeCapStart = 'CIRCLE'
    node.strokeCapEnd = 'ARROW'
    // The reason caps are geometry at all: `lineCap` is one value for both ends
    // of every subpath, so it could never have expressed this.
    expect(strokeCapShapes(node, nodeOutline(node))).toHaveLength(2)
  })

  it('draws nothing when both ends are plain', () => {
    expect(strokeCapShapes(line(), nodeOutline(line()))).toEqual([])
    const node = line()
    node.strokeCapStart = 'NONE'
    node.strokeCapEnd = 'NONE'
    expect(strokeCapShapes(node, nodeOutline(node))).toEqual([])
  })

  it('ignores caps on a closed shape', () => {
    const rect = createNode('RECTANGLE', 'r')
    rect.strokeWeight = 6
    rect.strokeCapStart = 'ARROW'
    rect.strokeCapEnd = 'ARROW'
    expect(strokeCapShapes(rect, nodeOutline(rect))).toEqual([])
  })

  it('scales every cap with the stroke weight', () => {
    // A head that kept its size while its line thickened would end up narrower
    // than the line it terminates.
    const end = { at: { x: 0, y: 0 }, dir: { x: 1, y: 0 } }
    const thin = bounds(capShape('ARROW', end, 4))
    const fat = bounds(capShape('ARROW', end, 8))
    expect(fat.maxY - fat.minY).toBeCloseTo((thin.maxY - thin.minY) * 2, 6)
  })

  it('gives round and circle different sizes, since they mean different things', () => {
    const end = { at: { x: 0, y: 0 }, dir: { x: 1, y: 0 } }
    // ROUND finishes the stroke — exactly what a round lineCap would draw.
    // CIRCLE marks the endpoint, so it has to be visible against the stroke.
    const round = bounds(capShape('ROUND', end, 10))
    const circle = bounds(capShape('CIRCLE', end, 10))
    expect(round.maxY - round.minY).toBeCloseTo(10, 6)
    expect(circle.maxY - circle.minY).toBeCloseTo(20, 6)
  })
})
