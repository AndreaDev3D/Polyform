// The palette of a selection.
//
// The grouping IS the feature: one swatch has to stand for every place that
// colour is used, or changing it recolours less than it appeared to. So these
// pin what lands in which group, and that applying a change reaches all of it.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { createNode, type FrameNode, type GradientPaint, type Paint, type RGBA } from './types'
import { applyColorToUses, selectionColors } from './selection-colors'

const rgb = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a })
const solid = (c: RGBA): Paint => ({ type: 'SOLID', visible: true, opacity: 1, color: c })
const BROWN = rgb(0.43, 0.27, 0.02)
const ORANGE = rgb(0.96, 0.69, 0.26)

/** A frame with three shapes: two brown, one orange, one brown stroke. */
function fixture() {
  const scene = new SceneGraph()
  const frame = createNode('FRAME', 'Leaf') as FrameNode
  // A frame is created with a white fill of its own. Cleared here so the cases
  // below are about the three shapes; that the container's OWN colour counts is
  // asserted separately, because it does and it should.
  frame.fills = []
  scene.addNode(frame, null, 0)
  const a = createNode('RECTANGLE', 'a')
  a.fills = [solid(BROWN)]
  const b = createNode('RECTANGLE', 'b')
  b.fills = [solid(ORANGE)]
  b.strokes = [solid(BROWN)]
  const c = createNode('ELLIPSE', 'c')
  c.fills = [solid(BROWN)]
  scene.addNode(a, frame.id, 0)
  scene.addNode(b, frame.id, 1)
  scene.addNode(c, frame.id, 2)
  return { scene, frame, a, b, c }
}

describe('selection colours', () => {
  it('gathers the colours inside a frame, most-used first', () => {
    const { scene, frame } = fixture()
    const groups = selectionColors(scene, [frame.id])
    expect(groups).toHaveLength(2)
    // Brown three times (two fills and a stroke), orange once. Ordering by use
    // count puts the colour worth changing at the top.
    expect(groups[0].uses).toHaveLength(3)
    expect(groups[1].uses).toHaveLength(1)
    expect(groups[0].color).toEqual(BROWN)
  })

  it("counts the container's own colour too", () => {
    const { scene, frame } = fixture()
    scene.getNode(frame.id)!.fills = [solid(rgb(1, 1, 1))]
    const groups = selectionColors(scene, [frame.id])
    // A frame's background is as much part of the palette as its contents —
    // recolouring a drawing usually means recolouring that first.
    expect(groups).toHaveLength(3)
    expect(groups.some((g) => g.color.r === 1 && g.color.g === 1 && g.color.b === 1)).toBe(true)
  })

  it('groups by the COLOUR, not by the layer or the list it is in', () => {
    const { scene, frame } = fixture()
    const [brown] = selectionColors(scene, [frame.id])
    // A fill and a stroke of the same brown are one swatch: "the brown in this
    // drawing" is the thing being edited, not "the brown on that rectangle".
    expect(new Set(brown.uses.map((u) => u.kind))).toEqual(new Set(['fill', 'stroke']))
  })

  it('counts gradient stops as colours in their own right', () => {
    const { scene, frame, a } = fixture()
    const grad: GradientPaint = {
      type: 'GRADIENT_LINEAR',
      visible: true,
      opacity: 1,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      stops: [
        { position: 0, color: BROWN },
        { position: 1, color: rgb(0, 0, 1) },
      ],
    }
    scene.getNode(a.id)!.fills = [grad]
    const groups = selectionColors(scene, [frame.id])
    // The brown stop joins the brown group; the blue one is new. A two-stop
    // gradient is two colours, and they are the ones somebody wants to change.
    expect(groups.find((g) => g.color.b === 1)).toBeTruthy()
    const brown = groups.find((g) => Math.abs(g.color.r - BROWN.r) < 1e-9)!
    expect(brown.uses.some((u) => u.stop === 0)).toBe(true)
  })

  it('skips a hidden PAINT but keeps a hidden LAYER', () => {
    const { scene, frame, a, c } = fixture()
    scene.getNode(a.id)!.fills[0].visible = false
    scene.getNode(c.id)!.visible = false
    const groups = selectionColors(scene, [frame.id])
    const brown = groups.find((g) => Math.abs(g.color.r - BROWN.r) < 1e-9)!
    // a's fill is switched off, so it is gone. c is a hidden LAYER and still
    // carries its colour — dropping it would make the palette change as you
    // toggle visibility, which reads as the tool losing track of the document.
    expect(brown.uses).toHaveLength(2)
  })

  it('reaches through nesting and never counts a node twice', () => {
    const { scene, frame, a } = fixture()
    // Selecting the frame AND something inside it must not double-count.
    const groups = selectionColors(scene, [frame.id, a.id])
    expect(groups[0].uses).toHaveLength(3)
  })

  it('changes every place the colour is used, in one pass', () => {
    const { scene, frame } = fixture()
    const [brown] = selectionColors(scene, [frame.id])
    const touched = applyColorToUses(scene, brown.uses, rgb(0, 0, 0))
    expect(touched).toHaveLength(3)
    // And the palette agrees afterwards: black three times, orange once.
    const after = selectionColors(scene, [frame.id])
    expect(after.map((g) => g.uses.length)).toEqual([3, 1])
    expect(after[0].color).toEqual(rgb(0, 0, 0))
  })

  it('leaves a use whose node or paint has gone', () => {
    const { scene, frame, a } = fixture()
    const [brown] = selectionColors(scene, [frame.id])
    scene.removeNode(a.id)
    // The panel could be a frame behind the document. Recolouring what is left
    // beats throwing, and beats recolouring nothing.
    expect(applyColorToUses(scene, brown.uses, rgb(0, 0, 0))).toHaveLength(2)
  })

  it('says nothing about an empty selection', () => {
    const { scene } = fixture()
    expect(selectionColors(scene, [])).toEqual([])
  })
})
