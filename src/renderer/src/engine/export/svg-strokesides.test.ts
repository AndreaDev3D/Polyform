// Per-side stroke weights, exported.
//
// SVG has `stroke-width`, singular. There is no attribute that could carry four,
// so writing one would export a border the document does not have — a wrong
// picture that looks deliberate, which is the failure mode this whole feature is
// most exposed to. The region goes out as a filled path instead.

import { describe, expect, it } from 'vitest'
import { exportSvg } from './svg'
import { SceneGraph } from '../scene'
import { createNode, rgba, type RectangleNode } from '../types'

const noBytes = async () => null

function scene(perSide: boolean): { scene: SceneGraph; id: string } {
  const s = new SceneGraph()
  const r = createNode('RECTANGLE', 'card') as RectangleNode
  r.width = 100
  r.height = 60
  r.fills = [{ type: 'SOLID', visible: true, opacity: 1, color: rgba(1, 0, 0, 1) }]
  r.strokes = [{ type: 'SOLID', visible: true, opacity: 1, color: rgba(0, 0, 1, 1) }]
  r.strokeWeight = perSide ? 0 : 4
  r.strokeAlign = 'INSIDE'
  if (perSide) r.strokeSides = { top: 0, right: 0, bottom: 12, left: 4 }
  s.addNode(r, null, 0)
  return { scene: s, id: r.id }
}

describe('SVG export: per-side strokes', () => {
  it('writes the region as a filled path, not as a stroke', async () => {
    const { scene: s, id } = scene(true)
    const svg = await exportSvg(s, [id], noBytes)
    // No stroke attributes at all: a single stroke-width here would be a border
    // that is 12px on the bottom claiming to be 12px everywhere.
    expect(svg).not.toContain('stroke-width')
    expect(svg).not.toContain('stroke=')
    // Two contours (outer and inner) filled even-odd — that pair is the ring.
    const paths = svg.match(/<path [^>]*\/>/g) ?? []
    const ring = paths.find((p) => p.includes('fill-rule="evenodd"'))
    expect(ring).toBeTruthy()
    expect((ring!.match(/M /g) ?? []).length).toBe(2)
    expect(ring).toContain('fill="rgba(0, 0, 255')
  })

  it('leaves a uniform stroke as a stroke', async () => {
    const { scene: s, id } = scene(false)
    const svg = await exportSvg(s, [id], noBytes)
    expect(svg).toContain('stroke-width="4"')
    expect(svg).not.toContain('fill-rule="evenodd"')
  })
})
