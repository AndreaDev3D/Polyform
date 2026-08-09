// What a mask covers.
//
// Every case here was a wrong picture on screen first. A group of letterform
// shapes used as a mask clipped to the group's bounding box, so the artwork
// underneath was not cut out at all and a logo arrived as a solid bar (F-33).
// Text masked to its box for the same reason. And Canvas2D clipped every
// non-boolean mask NONZERO while the GPU backend tessellated the same node
// EVEN-ODD, so an imported subtracted shape used as a mask came out differently
// depending on which renderer was drawing.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { createNode, rgba } from './types'
import type { GroupNode, FrameNode, VectorNode, TextNode, SceneNode } from './types'
import { maskShape } from './mask'
import { flattenSubPath, type SubPath } from './shapes'

function solid(node: SceneNode): SceneNode {
  node.fills = [{ type: 'SOLID', visible: true, opacity: 1, color: rgba(0, 0, 0, 1) }]
  return node
}

function box(subpaths: SubPath[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const sp of subpaths) {
    for (const p of flattenSubPath(sp, 0.1)) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  return { minX, minY, maxX, maxY }
}

/** A group holding two small squares in opposite corners of a big box. */
function cornersScene(): { scene: SceneGraph; group: GroupNode } {
  const scene = new SceneGraph()
  const group = createNode('GROUP', 'Text') as GroupNode
  group.width = 100
  group.height = 100
  scene.addNode(group, null, 0)
  for (const [x, y] of [
    [0, 0],
    [90, 90],
  ]) {
    const rect = solid(createNode('RECTANGLE', 'glyph'))
    rect.width = 10
    rect.height = 10
    rect.x = x
    rect.y = y
    scene.addNode(rect, group.id, scene.getNode(group.id)!.type === 'GROUP' ? group.children.length : 0)
  }
  return { scene, group }
}

describe('mask coverage', () => {
  it('a group masks with what is inside it, not with its own box', () => {
    const { scene, group } = cornersScene()
    const shape = maskShape(scene, group)
    // Two squares, not one 100x100 rectangle. The count is the whole point: the
    // old answer was a single four-anchor box.
    expect(shape.subpaths).toHaveLength(2)
    expect(shape.evenOdd).toBe(false)
    const b = box(shape.subpaths)
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 })
    // ...and the middle of the group is NOT covered, which is what makes it a
    // mask rather than a rectangle: each subpath stays in its own corner.
    const each = shape.subpaths.map((sp) => box([sp]))
    expect(each).toEqual([
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { minX: 90, minY: 90, maxX: 100, maxY: 100 },
    ])
  })

  it('reaches through nested groups, carrying the transforms', () => {
    const scene = new SceneGraph()
    const outer = createNode('GROUP', 'outer') as GroupNode
    scene.addNode(outer, null, 0)
    const inner = createNode('GROUP', 'inner') as GroupNode
    inner.x = 30
    inner.y = 40
    scene.addNode(inner, outer.id, 0)
    const rect = solid(createNode('RECTANGLE', 'r'))
    rect.width = 10
    rect.height = 10
    rect.x = 5
    rect.y = 5
    scene.addNode(rect, inner.id, 0)
    expect(box(maskShape(scene, outer).subpaths)).toEqual({ minX: 35, minY: 45, maxX: 45, maxY: 55 })
  })

  it('ignores hidden children and children that paint nothing', () => {
    const { scene, group } = cornersScene()
    const [first, second] = group.children
    scene.getNode(first)!.visible = false
    scene.getNode(second)!.fills = []
    // Nothing visible is left, so the mask covers nothing — and a mask that
    // covers nothing hides everything, which is not the same as being ignored.
    expect(maskShape(scene, group).subpaths).toHaveLength(0)
  })

  it('an empty group covers nothing rather than everything', () => {
    const scene = new SceneGraph()
    const group = createNode('GROUP', 'empty') as GroupNode
    group.width = 200
    group.height = 200
    scene.addNode(group, null, 0)
    expect(maskShape(scene, group).subpaths).toHaveLength(0)
  })

  it('a frame masks with its own rectangle, children and all', () => {
    const scene = new SceneGraph()
    const frame = solid(createNode('FRAME', 'card')) as FrameNode
    frame.width = 100
    frame.height = 50
    scene.addNode(frame, null, 0)
    const rect = solid(createNode('RECTANGLE', 'inside'))
    rect.width = 4
    rect.height = 4
    scene.addNode(rect, frame.id, 0)
    const shape = maskShape(scene, frame)
    // A frame has a shape of its own and already clips its children to it, so
    // the frame IS the mask. Only groups take their shape from their contents.
    expect(shape.subpaths).toHaveLength(1)
    expect(box(shape.subpaths)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 })
  })

  it("keeps a vector's own winding rule, so a subtracted mask keeps its holes", () => {
    const scene = new SceneGraph()
    const vec = solid(createNode('VECTOR', 'donut')) as VectorNode
    vec.network = {
      vertices: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 100, y: 0 },
        { id: 3, x: 100, y: 100 },
        { id: 4, x: 0, y: 100 },
      ],
      edges: [
        { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
        { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
        { id: 3, v0: 3, v1: 4, cp0: null, cp1: null },
        { id: 4, v0: 4, v1: 1, cp0: null, cp1: null },
      ],
    }
    vec.windingRule = 'EVENODD'
    scene.addNode(vec, null, 0)
    expect(maskShape(scene, vec).evenOdd).toBe(true)
    vec.windingRule = 'NONZERO'
    expect(maskShape(scene, vec).evenOdd).toBe(false)
  })

  it('a text mask falls back to its box only when there are no glyph outlines', () => {
    const scene = new SceneGraph()
    const text = solid(createNode('TEXT', 'DIGBORN')) as TextNode
    text.characters = 'DIGBORN'
    text.width = 200
    text.height = 40
    scene.addNode(text, null, 0)
    const shape = maskShape(scene, text)
    // No font bytes are loaded in this environment, so `layoutText` cannot shape
    // and there are no outlines to clip to — the box is the only shape there is,
    // and it is also what the painted text will look like. With a font loaded the
    // same call returns one subpath per glyph contour; the app harness checks that
    // against the real thing, because this environment cannot.
    expect(shape.subpaths).toHaveLength(1)
    expect(box(shape.subpaths)).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 40 })
  })
})
