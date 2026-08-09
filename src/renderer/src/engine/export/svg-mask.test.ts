// SVG export used to ignore masks completely.
//
// `isMask` appeared nowhere in the exporter, so a mask was written out as an
// ordinary filled shape sitting ON TOP of the artwork it was supposed to cut out
// — and because that produces a plausible-looking solid shape rather than an
// error, an export could be wrong without looking broken (F-33).

import { describe, expect, it } from 'vitest'
import { exportSvg } from './svg'
import { SceneGraph } from '../scene'
import { createNode, rgba } from '../types'
import type { FrameNode, GroupNode, SceneNode } from '../types'

const noBytes = async () => null

function painted(node: SceneNode, color: [number, number, number]): SceneNode {
  node.fills = [{ type: 'SOLID', visible: true, opacity: 1, color: rgba(...color, 1) }]
  return node
}

/** A frame holding a two-square group used as a mask, over one big rectangle. */
function scene(asMask: boolean): { scene: SceneGraph; frameId: string } {
  const s = new SceneGraph()
  const frame = createNode('FRAME', 'card') as FrameNode
  frame.width = 100
  frame.height = 100
  frame.fills = []
  s.addNode(frame, null, 0)

  const group = createNode('GROUP', 'letters') as GroupNode
  group.isMask = asMask
  s.addNode(group, frame.id, 0)
  for (const x of [0, 60]) {
    const sq = painted(createNode('RECTANGLE', 'glyph'), [0, 0, 1])
    sq.width = 20
    sq.height = 20
    sq.x = x
    s.addNode(sq, group.id, group.children.length)
  }

  const art = painted(createNode('RECTANGLE', 'art'), [1, 0, 0])
  art.width = 100
  art.height = 100
  s.addNode(art, frame.id, 1)
  return { scene: s, frameId: frame.id }
}

describe('SVG export: masks', () => {
  it('turns a mask into a clip path over the siblings that follow it', async () => {
    const { scene: s, frameId } = scene(true)
    const svg = await exportSvg(s, [frameId], noBytes)

    // Ids are allocated as the document is written (the frame's own clip takes
    // one first), so the test follows the reference rather than guessing a number.
    const id = svg.match(/clip-path="url\(#(mask\d+)\)"/)?.[1]
    expect(id).toBeTruthy()
    // Both squares travel into the clip path as one shape…
    const clip = svg.match(new RegExp(`<clipPath id="${id}">(.*?)</clipPath>`))?.[1] ?? ''
    expect(clip).toMatch(/^<path[^>]*\/>$/)
    expect((clip.match(/M /g) ?? []).length).toBe(2)
    expect(clip).toContain('clip-rule="nonzero"')
    // …and are NOT painted. Exactly one filled path leaves this document: the
    // artwork. Two would mean the mask was drawn over it, which is the bug.
    expect((svg.match(/fill="rgba/g) ?? []).length).toBe(1)
    expect(svg).toMatch(/fill="rgba\(255, 0, 0/)
    expect(svg).not.toMatch(/fill="rgba\(0, 0, 255/)
  })

  it('leaves an ordinary group alone', async () => {
    const { scene: s, frameId } = scene(false)
    const svg = await exportSvg(s, [frameId], noBytes)
    expect(svg).not.toContain('clipPath id="mask')
    // Three shapes, all painted: two squares and the artwork.
    expect((svg.match(/fill="rgba/g) ?? []).length).toBe(3)
  })

  it('carries the mask node\'s own transform into the clip path', async () => {
    const s = new SceneGraph()
    const frame = createNode('FRAME', 'card') as FrameNode
    frame.width = 100
    frame.height = 100
    frame.fills = []
    s.addNode(frame, null, 0)
    const shape = painted(createNode('RECTANGLE', 'window'), [0, 0, 1])
    shape.width = 10
    shape.height = 10
    shape.x = 25
    shape.y = 35
    shape.isMask = true
    s.addNode(shape, frame.id, 0)
    const art = painted(createNode('RECTANGLE', 'art'), [1, 0, 0])
    art.width = 100
    art.height = 100
    s.addNode(art, frame.id, 1)

    const svg = await exportSvg(s, [frame.id], noBytes)
    const id = svg.match(/clip-path="url\(#(mask\d+)\)"/)?.[1]
    const clip = svg.match(new RegExp(`<clipPath id="${id}">(.*?)</clipPath>`))?.[1] ?? ''
    // The coverage is in the mask's own space while the group being clipped is in
    // the parent's, so without this the window would clip at the origin.
    expect(clip).toContain('transform="translate(25 35)"')
  })
})
