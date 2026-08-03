// On-canvas ellipse arc handles: where they sit, and the pointer->value
// mapping the drag depends on. The convention has to agree with arcPath()
// (turns clockwise from 12 o'clock, radius normalized by rx/ry) or the
// handles would drift away from the geometry they claim to edit.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from '../scene'
import { createNode } from '../types'
import type { EllipseNode } from '../types'
import {
  arcEditTarget,
  arcHandles,
  arcRadiusFromLocal,
  arcTurnsFromLocal,
  hitArcHandle,
} from './overlays'

const CAMERA = { x: 0, y: 0, zoom: 1 }

function build(props: Partial<EllipseNode> = {}): { scene: SceneGraph; node: EllipseNode } {
  const scene = new SceneGraph()
  const node = createNode('ELLIPSE', 'e')
  if (node.type !== 'ELLIPSE') throw new Error('unreachable')
  node.x = 0
  node.y = 0
  node.width = 200
  node.height = 200
  Object.assign(node, props)
  scene.addNode(node, null, 0)
  return { scene, node }
}

describe('arcEditTarget', () => {
  it('accepts exactly one unlocked ellipse', () => {
    const { scene, node } = build()
    expect(arcEditTarget(scene, [node.id])?.id).toBe(node.id)
    expect(arcEditTarget(scene, [])).toBeNull()

    const other = createNode('ELLIPSE', 'e2')
    scene.addNode(other, null, 1)
    expect(arcEditTarget(scene, [node.id, other.id])).toBeNull()

    const rect = createNode('RECTANGLE', 'r')
    scene.addNode(rect, null, 2)
    expect(arcEditTarget(scene, [rect.id])).toBeNull()
  })

  it('refuses a locked ellipse and instance internals', () => {
    const { scene, node } = build()
    node.locked = true
    expect(arcEditTarget(scene, [node.id])).toBeNull()
    node.locked = false

    const instance = createNode('INSTANCE', 'i')
    scene.addNode(instance, null, 1)
    const inner = createNode('ELLIPSE', 'inner')
    scene.addNode(inner, instance.id, 0)
    expect(arcEditTarget(scene, [inner.id])).toBeNull()
  })
})

describe('arcTurnsFromLocal / arcRadiusFromLocal', () => {
  it('measures turns clockwise from 12 o’clock', () => {
    const { node } = build()
    // Local space: centre (100,100), y down. The result is raw (roughly
    // -0.25..0.75, unwrapped) — the drag only ever consumes differences.
    expect(arcTurnsFromLocal(node, { x: 100, y: 0 })).toBeCloseTo(0, 12) // top
    expect(arcTurnsFromLocal(node, { x: 200, y: 100 })).toBeCloseTo(0.25, 12) // right
    expect(arcTurnsFromLocal(node, { x: 100, y: 200 })).toBeCloseTo(0.5, 12) // bottom
    expect(arcTurnsFromLocal(node, { x: 0, y: 100 })).toBeCloseTo(0.75, 12) // left
  })

  it('normalizes by the radii, so a squashed ellipse still tracks the pointer', () => {
    const { node } = build({ width: 400, height: 100 })
    // Halfway along both axes from the centre, down-right: 0.375 turns in
    // parametric space, which is NOT 45° in screen space on a 4:1 ellipse.
    expect(arcTurnsFromLocal(node, { x: 200 + 200 * Math.SQRT1_2, y: 50 + 50 * Math.SQRT1_2 })).toBeCloseTo(
      0.375,
      12,
    )
    expect(arcRadiusFromLocal(node, { x: 400, y: 50 })).toBeCloseTo(1, 12)
    expect(arcRadiusFromLocal(node, { x: 200, y: 75 })).toBeCloseTo(0.5, 12)
    expect(arcRadiusFromLocal(node, { x: 200, y: 50 })).toBeCloseTo(0, 12)
  })
})

describe('arcHandles', () => {
  it('puts the ends on the outline (inset) and the ratio handle on the hole', () => {
    const { scene, node } = build({ arcStart: 0, arcSweep: 0.5, arcRatio: 0.5 })
    const handles = arcHandles(scene, node, CAMERA)
    expect(handles.map((h) => h.kind)).toEqual(['arc-start', 'arc-sweep', 'arc-ratio'])
    const [start, sweep, ratio] = handles
    // Start at 12 o'clock, pulled 10px toward the centre.
    expect(start.x).toBeCloseTo(100, 6)
    expect(start.y).toBeCloseTo(10, 6)
    // Half a turn later: 6 o'clock, same inset.
    expect(sweep.x).toBeCloseTo(100, 6)
    expect(sweep.y).toBeCloseTo(190, 6)
    // Mid-sweep is 3 o'clock; ratio 0.5 is halfway out. No inset here — the
    // handle marks the hole itself.
    expect(ratio.x).toBeCloseTo(150, 6)
    expect(ratio.y).toBeCloseTo(100, 6)
  })

  it('collapses to one ring handle on a whole turn', () => {
    const { scene, node } = build()
    expect(arcHandles(scene, node, CAMERA).map((h) => h.kind)).toEqual(['arc-sweep', 'arc-ratio'])
  })

  it('parks the ratio handle at the centre when there is no hole', () => {
    const { scene, node } = build({ arcSweep: 0.25 })
    const ratio = arcHandles(scene, node, CAMERA).find((h) => h.kind === 'arc-ratio')!
    expect(ratio.x).toBeCloseTo(100, 6)
    expect(ratio.y).toBeCloseTo(100, 6)
  })

  it('follows the node through rotation and camera', () => {
    const { scene, node } = build({ arcStart: 0, arcSweep: 0.5, rotation: 90 })
    const handles = arcHandles(scene, node, { x: -50, y: 0, zoom: 2 })
    // Rotated a quarter turn about the centre, the start end lands where
    // 3 o'clock was: world (200,100) -> screen (500,200), then 10px back
    // toward the centre. The inset is screen-space, so zoom does not scale it.
    const start = handles.find((h) => h.kind === 'arc-start')!
    expect(start.x).toBeCloseTo(490, 6)
    expect(start.y).toBeCloseTo(200, 6)
  })

  it('never reaches a box edge handle, at any zoom', () => {
    // A start of 0 sits at the top edge midpoint, exactly where the 'n'
    // resize handle lives; the inset is what keeps both clickable.
    for (const zoom of [0.25, 1, 8]) {
      const { scene, node } = build({ arcStart: 0, arcSweep: 0.5 })
      const start = arcHandles(scene, node, { x: 0, y: 0, zoom })!.find((h) => h.kind === 'arc-start')!
      const edgeHandleY = 0
      expect(start.y - edgeHandleY).toBeGreaterThan(7)
    }
  })

  it('keeps the inset inside a tiny shape rather than crossing the centre', () => {
    const { scene, node } = build({ width: 10, height: 10, arcStart: 0, arcSweep: 0.5 })
    const start = arcHandles(scene, node, CAMERA).find((h) => h.kind === 'arc-start')!
    expect(start.y).toBeGreaterThan(0)
    expect(start.y).toBeLessThan(5)
  })
})

describe('hitArcHandle', () => {
  it('picks the handle within 7px, and nothing beyond', () => {
    const handles = [
      { kind: 'arc-start' as const, x: 100, y: 100 },
      { kind: 'arc-ratio' as const, x: 200, y: 100 },
    ]
    expect(hitArcHandle(handles, { x: 104, y: 103 })?.kind).toBe('arc-start')
    expect(hitArcHandle(handles, { x: 198, y: 96 })?.kind).toBe('arc-ratio')
    expect(hitArcHandle(handles, { x: 150, y: 100 })).toBeNull()
  })
})
