// The pointer is authored as an SVG so it can be drawn in Polyform itself, and
// resources/cursor-arrow.svg says as much at the top of the file. That promise
// only holds if what Polyform EXPORTS can be read back by the generator — and
// an export looks nothing like the hand-written file. It has a 1024 viewBox, a
// `<g transform="translate(…)">` around every node, the frame's own white fill
// as the first path in the document, and the guide layers as unfilled ones.
//
// Read naively, the first path would be the background, so the hotspot would be
// the frame's top-left corner and the arrow would become a second subpath. The
// cursor would still render — as a white square with an arrow-shaped hole in it,
// aiming at nothing. That is the failure this test exists to prevent, so it runs
// the REAL exporter rather than a hand-written guess at its output (F-22: a
// fixture written from memory checks the memory).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { exportSvg } from './svg'
import { SceneGraph } from '../scene'
import { createNode, rgba } from '../types'
import type { FrameNode, RectangleNode, VectorNode } from '../types'
import { CURSOR_ARROW, CURSOR_TIP } from '../render/cursor-paths'
import { CURSOR_BOX, readCursorSvg } from '../../../../../scripts/cursor-svg.mjs'

const noBytes = async () => null

/** The authored outline, in the units it is drawn in. */
const AUTHORED = [
  [3.6, 3.6],
  [21.4, 14.1],
  [13, 15.9],
  [10.3, 24.1],
]

const FRAME = 1024
const S = FRAME / CURSOR_BOX

function numbersIn(d: string): number[] {
  return (d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
}

/**
 * The `cursor-arrow` frame as it exists in the document: a big white frame, the
 * arrow inside it as a vector, and the two locked guides that say where the
 * badge disc sits and how far the shape must stay from the edge.
 */
function cursorFrame(opts: { guides: boolean } = { guides: true }): {
  scene: SceneGraph
  frameId: string
  arrowId: string
} {
  const s = new SceneGraph()
  const frame = createNode('FRAME', 'cursor-arrow') as FrameNode
  // Off the origin on both axes, because an export re-anchors to the union box
  // and a frame at 0,0 would hide a mistake in that arithmetic.
  frame.x = 2438.49
  frame.y = 3058.22
  frame.width = FRAME
  frame.height = FRAME
  frame.fills = [{ type: 'SOLID', visible: true, opacity: 1, color: rgba(1, 1, 1, 1) }]
  s.addNode(frame, null, 0)

  // The importer normalises a shape to its own bounding box and carries the
  // offset on the node, so the path data is NOT in frame coordinates. That is
  // exactly the shift the reader has to undo.
  const pts = AUTHORED.map(([x, y]) => ({ x: x * S, y: y * S }))
  const ox = Math.min(...pts.map((p) => p.x))
  const oy = Math.min(...pts.map((p) => p.y))
  const arrow = createNode('VECTOR', 'arrow') as VectorNode
  arrow.x = ox
  arrow.y = oy
  arrow.width = Math.max(...pts.map((p) => p.x)) - ox
  arrow.height = Math.max(...pts.map((p) => p.y)) - oy
  arrow.network = {
    vertices: pts.map((p, i) => ({ id: i, x: p.x - ox, y: p.y - oy })),
    edges: pts.map((_, i) => ({ id: i, v0: i, v1: (i + 1) % pts.length, cp0: null, cp1: null })),
  }
  arrow.fills = [{ type: 'SOLID', visible: true, opacity: 1, color: rgba(0.15, 0.16, 0.18, 1) }]
  s.addNode(arrow, frame.id, 0)

  if (opts.guides) {
    for (const [name, inset] of [
      ['guide · keep 3.5 clear', 3.5],
      ['guide · badge disc', 11],
    ] as const) {
      const g = createNode('RECTANGLE', name) as RectangleNode
      g.x = inset * S
      g.y = inset * S
      g.width = FRAME - inset * 2 * S
      g.height = FRAME - inset * 2 * S
      g.fills = []
      g.strokes = [{ type: 'SOLID', visible: true, opacity: 1, color: rgba(0.7, 0.75, 0.8, 1) }]
      g.strokeWeight = 3
      g.strokeDash = [14, 14]
      s.addNode(g, frame.id, frame.children.length)
    }
  }
  return { scene: s, frameId: frame.id, arrowId: arrow.id }
}

describe('cursor SVG: the Polyform round trip', () => {
  it('reads the hand-authored source, and it is the shape the renderer compiles', () => {
    const svg = readFileSync(new URL('../../../../../resources/cursor-arrow.svg', import.meta.url))
    const { paths, tip, notes } = readCursorSvg(svg.toString())
    expect(paths.length).toBe(1)
    expect(notes).toEqual([])
    expect(tip.x).toBeCloseTo(AUTHORED[0][0], 3)
    expect(tip.y).toBeCloseTo(AUTHORED[0][1], 3)
    // The generated file is the drawing, point for point. `AUTHORED` is written
    // out here rather than derived, so redrawing the arrow without re-running
    // the generator fails HERE — where the reason is obvious — instead of
    // shipping a pointer that no longer matches its own source.
    expect(numbersIn(paths[0])).toEqual(AUTHORED.flat())
    expect(paths[0]).toBe(CURSOR_ARROW)
    expect(tip).toEqual(CURSOR_TIP)
  })

  it('recovers the same outline from what the exporter writes', async () => {
    const { scene, frameId } = cursorFrame()
    const svg = await exportSvg(scene, [frameId], noBytes)

    // The export really does contain the things that would break a naive read —
    // if it stops containing them, this test has stopped testing anything.
    expect(svg).toContain('transform="translate(')
    expect((svg.match(/<path/g) ?? []).length).toBeGreaterThan(3)
    expect(svg).toContain('viewBox="0 0 1024 1024"')

    const { paths, tip, notes } = readCursorSvg(svg)
    expect(paths.length).toBe(1)
    expect(notes).toContain('a full-box path (the frame background)')
    // Three unfilled paths, and none of them is the cursor: the two guides, and
    // the arrow node's own hairline stroke — which the renderer replaces with
    // its rim, so carrying it through would draw the outline twice.
    expect(notes.filter((n) => n.startsWith('an unfilled path')).length).toBe(3)

    const got = numbersIn(paths[0])
    expect(got.length).toBe(AUTHORED.length * 2)
    for (const [i, [x, y]] of AUTHORED.entries()) {
      expect(got[i * 2]).toBeCloseTo(x, 2)
      expect(got[i * 2 + 1]).toBeCloseTo(y, 2)
    }
    expect(tip.x).toBeCloseTo(AUTHORED[0][0], 2)
    expect(tip.y).toBeCloseTo(AUTHORED[0][1], 2)
  })

  it('keeps curves as curves', async () => {
    const { scene, frameId, arrowId } = cursorFrame({ guides: false })
    const arrow = scene.getNode(arrowId) as VectorNode
    // Bow the long edge out. A cursor drawn with rounded corners in Polyform
    // arrives as cubics, and a reader that only understood lines would flatten
    // the shape without saying so.
    arrow.network.edges[0].cp0 = { x: 200, y: 0 }
    arrow.network.edges[0].cp1 = { x: 400, y: 120 }
    const { paths } = readCursorSvg(await exportSvg(scene, [frameId], noBytes))
    expect(paths[0]).toContain('C ')
    // The control points land where they were drawn, in cursor units: node
    // origin (3.6, 3.6) plus the offset, divided by the scale.
    const c = numbersIn(paths[0].slice(paths[0].indexOf('C ')))
    expect(c[0]).toBeCloseTo(3.6 + 200 / S, 2)
    expect(c[3]).toBeCloseTo(3.6 + 120 / S, 2)
  })

  it('refuses an export of the arrow layer alone, where the box is the wrong box', async () => {
    // Exporting the shape instead of the frame around it crops the box to the
    // arrow's own bounds: the outline survives, but the hotspot moves to the
    // corner and the badge has nowhere to sit. Silently accepting it would ship
    // a pointer that aims somewhere other than where it points.
    const { scene, arrowId } = cursorFrame({ guides: false })
    const svg = await exportSvg(scene, [arrowId], noBytes)
    expect(() => readCursorSvg(svg)).toThrow(/export the whole cursor-arrow frame/)
  })

  it('refuses a square box that the shape fills to the edges', () => {
    // The same mistake, in the one shape that gets past the squareness check: a
    // box cropped to artwork that happens to be square. Nothing about the file
    // is malformed — only the tip is, and only against the box. The guard has to
    // be able to fire on its own or it is decoration (F-36).
    const d = AUTHORED.map(([x, y]) => `${(x - 3.6) * 1.4} ${(y - 3.6) * 1.4}`).join(' L ')
    const svg = `<svg viewBox="0 0 28.7 28.7"><path d="M ${d} Z"/></svg>`
    expect(() => readCursorSvg(svg)).toThrow(/hard against the edge of the box/)
  })

  it('refuses a source with nothing filled in it', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30">' +
      '<path d="M3.6 3.6 21.4 14.1 10.3 24.1Z" fill="none" stroke="#000"/></svg>'
    expect(() => readCursorSvg(svg)).toThrow(/needs a fill/)
  })

  it('rescales a source drawn at any size', () => {
    const at = (box: number) => {
      const k = box / CURSOR_BOX
      const d = AUTHORED.map(([x, y]) => `${x * k} ${y * k}`).join(' L ')
      const svg = `<svg viewBox="0 0 ${box} ${box}"><path d="M ${d} Z"/></svg>`
      return numbersIn(readCursorSvg(svg).paths[0])
    }
    // Three boxes, one shape: the renderer's badge and rim are numbers in the
    // 30-unit space, so whatever the file was drawn in has to end up there.
    for (const box of [30, 300, 1024]) {
      const got = at(box)
      for (const [i, [x, y]] of AUTHORED.entries()) {
        expect(got[i * 2]).toBeCloseTo(x, 2)
        expect(got[i * 2 + 1]).toBeCloseTo(y, 2)
      }
    }
  })
})
