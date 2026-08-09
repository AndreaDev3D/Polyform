// On-canvas ellipse arc handles: where they sit, and the pointer->value
// mapping the drag depends on. The convention has to agree with arcPath()
// (turns clockwise from 12 o'clock, radius normalized by rx/ry) or the
// handles would drift away from the geometry they claim to edit.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from '../scene'
import { createNode } from '../types'
import type { EllipseNode } from '../types'
import {
  HANDLE_SIZE,
  LABEL_FONT_PX,
  ROTATE_CURSOR,
  ROTATE_STEM,
  arcEditTarget,
  arcHandles,
  arcRadiusFromLocal,
  arcTurnsFromLocal,
  boxHandles,
  canRotate,
  cornerEditTarget,
  cornerHandles,
  cornerRadiusFromLocal,
  frameLabels,
  hitArcHandle,
  hitCornerHandle,
  hitHandle,
  labelFontSize,
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

// --- box handles + the rotate knob -----------------------------------------

describe('boxHandles', () => {
  // An upright 200x100 box at the origin, in screen space.
  const upright = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ]

  it('puts one visible rotate knob on a stem above the top edge', () => {
    const knobs = boxHandles(upright).filter((h) => h.kind === 'rotate')
    expect(knobs).toHaveLength(1)
    expect(knobs[0].x).toBeCloseTo(100, 6) // top edge midpoint
    expect(knobs[0].y).toBeCloseTo(-ROTATE_STEM, 6) // out, not on the edge
    expect(knobs[0].cursor).toBe(ROTATE_CURSOR)
  })

  it('carries the knob around with the box’s own up direction', () => {
    // The same box turned a quarter turn clockwise about its centre: its top
    // edge now faces right, so "above the shape" is to the right of it.
    const turned = [
      { x: 150, y: -50 },
      { x: 150, y: 150 },
      { x: 50, y: 150 },
      { x: 50, y: -50 },
    ]
    const knob = boxHandles(turned).find((h) => h.kind === 'rotate')!
    expect(knob.x).toBeCloseTo(150 + ROTATE_STEM, 6)
    expect(knob.y).toBeCloseTo(50, 6)
  })

  it('points the knob up when the box has collapsed to a point', () => {
    const point = [
      { x: 40, y: 40 },
      { x: 40, y: 40 },
      { x: 40, y: 40 },
      { x: 40, y: 40 },
    ]
    const knob = boxHandles(point).find((h) => h.kind === 'rotate')!
    expect(knob.x).toBeCloseTo(40, 6)
    expect(knob.y).toBeCloseTo(40 - ROTATE_STEM, 6)
  })

  it('drops every rotate affordance when rotation would do nothing', () => {
    const hs = boxHandles(upright, false)
    expect(hs.some((h) => h.kind.startsWith('rotate'))).toBe(false)
    // ...but the resize handles are all still there.
    expect(hs.map((h) => h.kind).sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'])
  })

  it('keeps the knob clear of the n resize handle at every rotation', () => {
    // If the two ever overlapped, one of them would be unclickable.
    const pad = HANDLE_SIZE / 2 + 3
    for (let deg = 0; deg < 360; deg += 15) {
      const a = (deg * Math.PI) / 180
      const rot = (p: { x: number; y: number }) => ({
        x: 100 + (p.x - 100) * Math.cos(a) - (p.y - 50) * Math.sin(a),
        y: 50 + (p.x - 100) * Math.sin(a) + (p.y - 50) * Math.cos(a),
      })
      const hs = boxHandles(upright.map(rot))
      const knob = hs.find((h) => h.kind === 'rotate')!
      const n = hs.find((h) => h.kind === 'n')!
      expect(Math.hypot(knob.x - n.x, knob.y - n.y)).toBeGreaterThan(pad + 2)
    }
  })
})

describe('canRotate', () => {
  it('accepts ordinary nodes and refuses instance internals', () => {
    const scene = new SceneGraph()
    const rect = createNode('RECTANGLE', 'r')
    scene.addNode(rect, null, 0)
    const instance = createNode('INSTANCE', 'i')
    scene.addNode(instance, null, 1)
    const inner = createNode('RECTANGLE', 'inner')
    scene.addNode(inner, instance.id, 0)

    expect(canRotate(scene, [rect.id])).toBe(true)
    // The instance itself turns; its internals commit nowhere.
    expect(canRotate(scene, [instance.id])).toBe(true)
    expect(canRotate(scene, [inner.id])).toBe(false)
    expect(canRotate(scene, [])).toBe(false)
    expect(canRotate(scene, ['missing'])).toBe(false)
    // A mixed selection still turns the part that can — which is what the
    // gesture itself does.
    expect(canRotate(scene, [inner.id, rect.id])).toBe(true)
  })

  it('turns a locked node, so it keeps the handle', () => {
    const scene = new SceneGraph()
    const rect = createNode('RECTANGLE', 'r')
    rect.locked = true
    scene.addNode(rect, null, 0)
    expect(canRotate(scene, [rect.id])).toBe(true)
  })
})

describe('hitHandle', () => {
  const upright = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ]
  const hs = boxHandles(upright)

  it('hits the knob, and rotates from it', () => {
    expect(hitHandle(hs, { x: 100, y: -ROTATE_STEM })?.kind).toBe('rotate')
    expect(hitHandle(hs, { x: 104, y: -ROTATE_STEM + 4 })?.kind).toBe('rotate')
  })

  it('gives the top edge to resize, not to the knob', () => {
    expect(hitHandle(hs, { x: 100, y: 0 })?.kind).toBe('n')
    expect(hitHandle(hs, { x: 0, y: 0 })?.kind).toBe('nw')
  })

  it('leaves the gap between the edge and the knob to neither', () => {
    // The knob's hit area is the knob, not the whole strip above the shape —
    // between the two, a drag is still a marquee.
    expect(hitHandle(hs, { x: 100, y: -8 })).toBeNull()
    // ...and the two are adjacent enough that the gap is only a couple of px.
    expect(hitHandle(hs, { x: 100, y: -7 })?.kind).toBe('n')
    expect(hitHandle(hs, { x: 100, y: -9 })?.kind).toBe('rotate')
  })

  it('still rotates from the invisible corner zones', () => {
    expect(hitHandle(hs, { x: -14, y: -14 })?.kind).toBe('rotate-nw')
    expect(hitHandle(hs, { x: 214, y: 114 })?.kind).toBe('rotate-se')
  })

  it('prefers the visible knob where a corner zone reaches it', () => {
    // On a box narrow enough that the nw/ne zones cover the top middle, the
    // handle you can see is the one you get.
    const narrow = [
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 100 },
      { x: 0, y: 100 },
    ]
    expect(hitHandle(boxHandles(narrow), { x: 6, y: -ROTATE_STEM })?.kind).toBe('rotate')
  })
})

// --- corner radius handles -------------------------------------------------

describe('cornerEditTarget / cornerHandles', () => {
  const rect = (props: Record<string, unknown> = {}) => {
    const scene = new SceneGraph()
    const node = createNode('RECTANGLE', 'r')
    node.x = 0
    node.y = 0
    node.width = 400
    node.height = 300
    Object.assign(node, props)
    scene.addNode(node, null, 0)
    return { scene, node }
  }

  it('accepts one unlocked rounded-capable node, refuses others', () => {
    const { scene, node } = rect()
    expect(cornerEditTarget(scene, [node.id])?.id).toBe(node.id)
    node.locked = true
    expect(cornerEditTarget(scene, [node.id])).toBeNull()
    node.locked = false

    const line = createNode('LINE', 'l')
    scene.addNode(line, null, 1)
    expect(cornerEditTarget(scene, [line.id])).toBeNull() // no cornerRadius
    expect(cornerEditTarget(scene, [node.id, line.id])).toBeNull() // not single
  })

  it('parks each handle a minimum inset in when the radius is 0', () => {
    const { scene, node } = rect()
    const hs = cornerHandles(scene, node, CAMERA)
    expect(hs.map((h) => h.kind)).toEqual(['radius-tl', 'radius-tr', 'radius-br', 'radius-bl'])
    // 13px inset at zoom 1, so it never hides under the resize handle.
    expect(hs[0].x).toBeCloseTo(13, 6)
    expect(hs[0].y).toBeCloseTo(13, 6)
    expect(hs[2].x).toBeCloseTo(400 - 13, 6)
    expect(hs[2].y).toBeCloseTo(300 - 13, 6)
  })

  it('follows each corner’s own radius', () => {
    const { scene, node } = rect({ cornerRadius: { tl: 60, tr: 0, br: 120, bl: 20 } })
    const hs = cornerHandles(scene, node, CAMERA)
    expect(hs[0].x).toBeCloseTo(60, 6) // tl at its own radius
    expect(hs[1].x).toBeCloseTo(400 - 13, 6) // tr at 0 -> minimum inset
    expect(hs[2].x).toBeCloseTo(400 - 120, 6)
    expect(hs[3].y).toBeCloseTo(300 - 20, 6)
  })

  it('clamps the handle to half the short side', () => {
    const { scene, node } = rect({ cornerRadius: { tl: 9999, tr: 0, br: 0, bl: 0 } })
    const hs = cornerHandles(scene, node, CAMERA)
    expect(hs[0].x).toBeCloseTo(150, 6) // min(400,300)/2
  })

  it('keeps the inset constant in screen pixels across zoom', () => {
    const { scene, node } = rect()
    for (const zoom of [0.5, 1, 4]) {
      const h = cornerHandles(scene, node, { x: 0, y: 0, zoom })[0]
      expect(h.x).toBeCloseTo(13, 6)
    }
  })

  it('hides the handles on a shape too small to aim at', () => {
    const { scene, node } = rect({ width: 30, height: 30 })
    expect(cornerHandles(scene, node, CAMERA)).toHaveLength(0)
    // ...but zooming in brings them back.
    expect(cornerHandles(scene, node, { x: 0, y: 0, zoom: 4 })).toHaveLength(4)
  })
})

describe('cornerRadiusFromLocal', () => {
  const node = (() => {
    const n = createNode('RECTANGLE', 'r')
    n.width = 400
    n.height = 300
    return n
  })()

  it('projects the pointer onto the corner diagonal', () => {
    expect(cornerRadiusFromLocal(node, 'radius-tl', { x: 40, y: 40 })).toBeCloseTo(40, 6)
    // Off-diagonal drags still read linearly: the mean of the two distances.
    expect(cornerRadiusFromLocal(node, 'radius-tl', { x: 60, y: 20 })).toBeCloseTo(40, 6)
    expect(cornerRadiusFromLocal(node, 'radius-br', { x: 400 - 30, y: 300 - 50 })).toBeCloseTo(40, 6)
  })

  it('never goes negative or past half the short side', () => {
    expect(cornerRadiusFromLocal(node, 'radius-tl', { x: -80, y: -80 })).toBe(0)
    expect(cornerRadiusFromLocal(node, 'radius-tl', { x: 900, y: 900 })).toBeCloseTo(150, 6)
  })
})

describe('hitCornerHandle', () => {
  it('picks within 7px', () => {
    const hs = [{ kind: 'radius-tl' as const, x: 20, y: 20 }]
    expect(hitCornerHandle(hs, { x: 24, y: 23 })?.kind).toBe('radius-tl')
    expect(hitCornerHandle(hs, { x: 40, y: 20 })).toBeNull()
  })
})

// Frame names, zoomed out: a label pinned at 11px over a frame the size of a
// thumbnail writes over its neighbours. What the tests hold is the pile-up
// itself, not just the arithmetic that causes it.
describe('frame labels', () => {
  /** `count` frames of `w`×80, laid out in a row `gap` apart, each with a long name. */
  function row(count: number, w = 200, gap = 40): SceneGraph {
    const scene = new SceneGraph()
    for (let i = 0; i < count; i++) {
      const f = createNode('FRAME', `Asset_Sheet_Name_${i}`)
      f.x = i * (w + gap)
      f.y = 500
      f.width = w
      f.height = 80
      scene.addNode(f, null, i)
    }
    return scene
  }

  /** A ctx stand-in that measures like a 0.55em monospace font would. */
  const measurer = (size: number): CanvasRenderingContext2D =>
    ({
      font: '',
      measureText: (t: string) => ({ width: t.length * size * 0.55 }),
    }) as unknown as CanvasRenderingContext2D

  it('shrinks the label as you zoom out, down to a floor', () => {
    expect(labelFontSize(1)).toBe(LABEL_FONT_PX)
    // Zooming IN never inflates the name — it stays the size of the UI around it.
    expect(labelFontSize(4)).toBe(LABEL_FONT_PX)
    // sqrt(0.64) = 0.8, so 8.8px: smaller, and still a word.
    expect(labelFontSize(0.64)).toBeCloseTo(8.8, 6)
    expect(labelFontSize(0.81)).toBeCloseTo(9.9, 6)
    // Past the floor it stops shrinking — a 0.5px name is not a name.
    expect(labelFontSize(0.25)).toBe(8)
    expect(labelFontSize(0.001)).toBe(8)
    expect(labelFontSize(0)).toBe(8)
  })

  it('keeps every label when the frames are far enough apart', () => {
    const scene = row(4)
    const labels = frameLabels(scene, { x: 0, y: 0, zoom: 1 }, measurer(LABEL_FONT_PX))
    expect(labels).toHaveLength(4)
    // 19 chars at 0.55em, 11px: ~115px, and the frames are 240 apart.
    expect(labels[0].width).toBeCloseTo('Asset_Sheet_Name_0'.length * LABEL_FONT_PX * 0.55, 6)
    expect(labels.every((l) => l.fontSize === LABEL_FONT_PX)).toBe(true)
  })

  it('drops the labels that would be drawn over each other', () => {
    // The screenshot's situation: 12 frames, zoomed way out. At the old fixed
    // 11px every one of these was drawn, all inside ~290px of screen.
    const scene = row(12)
    const zoom = 0.1
    const all = frameLabels(scene, { x: 0, y: 0, zoom }, measurer(labelFontSize(zoom)))
    expect(all.length).toBeGreaterThan(0)
    expect(all.length).toBeLessThan(12)
    // Whatever survived does not touch anything else that survived.
    for (let i = 0; i < all.length; i++) {
      for (let k = i + 1; k < all.length; k++) {
        const a = all[i]
        const b = all[k]
        const overlaps =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y - a.height < b.y && b.y - b.height < a.y
        expect(overlaps, `${a.text} overlaps ${b.text}`).toBe(false)
      }
    }
  })

  it('says nothing about a frame too small on screen to name', () => {
    const scene = row(1, 100)
    // 100 world px at 10% is 10 screen px: a thumbnail, not a labelled frame.
    expect(frameLabels(scene, { x: 0, y: 0, zoom: 0.1 }, measurer(6))).toHaveLength(0)
    expect(frameLabels(scene, { x: 0, y: 0, zoom: 0.2 }, measurer(6))).toHaveLength(1)
  })

  it('picks the same survivors however the camera is placed', () => {
    // Pan and zoom are affine, so the winners are decided in world space and do
    // not change underfoot — labels flickering as you drag would be worse than
    // labels overlapping.
    const scene = row(10)
    const at = (c: { x: number; y: number; zoom: number }) =>
      frameLabels(scene, c, measurer(labelFontSize(c.zoom)))
        .map((l) => l.text)
        .join()
    const base = at({ x: 0, y: 0, zoom: 0.25 })
    expect(at({ x: 137, y: -400, zoom: 0.25 })).toBe(base)
    expect(at({ x: -1000, y: 900, zoom: 0.25 })).toBe(base)
    // Zooming does change it — that is the feature, not a wobble.
    expect(at({ x: 0, y: 0, zoom: 1 })).not.toBe(base)
  })

  it('does not consider a name that is off screen', () => {
    // Both the drawing and the pointer path pass a viewport, and must agree: an
    // off-screen label allowed to win the collision pass would silently suppress
    // a visible one, and the cull would cost the whole document per frame.
    const scene = row(40, 200, 40)
    const camera = { x: 0, y: 0, zoom: 1 }
    const viewport = { w: 1200, h: 800 }
    const onscreen = frameLabels(scene, camera, measurer(LABEL_FONT_PX), viewport)
    expect(onscreen.length).toBeLessThan(40)
    expect(onscreen.every((l) => l.x <= viewport.w && l.x + l.width >= 0)).toBe(true)
    // The visible ones are the same either way — the viewport only removes what
    // could not have been drawn.
    const all = frameLabels(scene, camera, measurer(LABEL_FONT_PX))
    expect(onscreen.map((l) => l.text)).toEqual(
      all.filter((l) => l.x <= viewport.w && l.x + l.width >= 0).map((l) => l.text),
    )
  })

  it('estimates the width the same way with no ctx to measure with', () => {
    // The pointer path calls this without a canvas: if the estimate ignored the
    // font size, the click target would sit beside the name it belongs to.
    const scene = row(1)
    const zoom = 0.3
    const [drawn] = frameLabels(scene, { x: 0, y: 0, zoom }, measurer(labelFontSize(zoom)))
    const [clicked] = frameLabels(scene, { x: 0, y: 0, zoom })
    expect(clicked.width).toBeCloseTo(drawn.width, 6)
    expect(clicked.y).toBeCloseTo(drawn.y, 6)
  })
})
