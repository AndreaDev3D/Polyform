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
import { capShape, openEnds, strokeCapShapes, strokeCapsApply } from './strokecaps'

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

  it('puts an arrowhead TIP on the end of the line', () => {
    const node = line()
    node.strokeCapEnd = 'ARROW'
    const caps = strokeCapShapes(node, nodeOutline(node))
    expect(caps).toHaveLength(1)
    const b = bounds(caps)
    // The tip is at the line's end and the head grows BACKWARDS along it, so
    // adding an arrow does not make the line longer than it was.
    expect(b.maxX).toBeCloseTo(100, 6)
    expect(b.minX).toBeCloseTo(100 - 2.6 * 10, 6)
    // Wider than the stroke, or it would not read as a head at all.
    expect(b.maxY - b.minY).toBeGreaterThan(node.strokeWeight)
  })

  it('turns the arrowhead round at the other end', () => {
    const node = line()
    node.strokeCapStart = 'ARROW'
    const b = bounds(strokeCapShapes(node, nodeOutline(node)))
    expect(b.minX).toBeCloseTo(0, 6)
    expect(b.maxX).toBeCloseTo(2.6 * 10, 6)
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
