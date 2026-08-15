// Every colour used inside a selection, grouped by colour.
//
// Selecting a frame and seeing its palette is the fastest way there is to
// re-colour a drawing: one swatch stands for every place that colour is used,
// and changing it changes all of them. Without it, recolouring a logo means
// finding each shape that happens to be that brown and editing it — which is
// both slow and unreliable, because the ones you miss are the ones you cannot
// see.
//
// Grouped by the COLOUR, not by the layer. Two shapes painted the same brown
// are one entry here even if nothing else about them matches, because "the
// brown in this drawing" is the thing being edited.

import { isContainer } from './types'
import type { NodeId, RGBA, SceneNode } from './types'
import type { SceneGraph } from './scene'

/** Where one colour is used: which node, which list, which slot. */
export interface ColorUse {
  nodeId: NodeId
  kind: 'fill' | 'stroke'
  /** Index into that node's `fills`/`strokes`. */
  index: number
  /** Index into a gradient's stops, or null for a solid paint. */
  stop: number | null
}

export interface ColorGroup {
  /** `rrggbbaa`, and the identity of the group. */
  key: string
  color: RGBA
  uses: ColorUse[]
}

function keyOf(c: RGBA): string {
  const b = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `${b(c.r)}${b(c.g)}${b(c.b)}${b(c.a)}`
}

/**
 * Colours used by the selection and everything inside it, most-used first.
 *
 * Hidden paints are skipped but hidden LAYERS are not: a layer you have turned
 * off still carries its colour, and dropping it would make the palette change
 * as you toggle visibility — which reads as the tool losing track.
 *
 * Gradient stops count individually. A two-stop gradient is two colours, and
 * they are the colours somebody wants to change.
 */
export function selectionColors(scene: SceneGraph, ids: readonly NodeId[]): ColorGroup[] {
  const groups = new Map<string, ColorGroup>()
  const seen = new Set<NodeId>()

  const add = (c: RGBA, use: ColorUse): void => {
    const key = keyOf(c)
    const g = groups.get(key)
    if (g) g.uses.push(use)
    else groups.set(key, { key, color: { ...c }, uses: [use] })
  }

  const visit = (id: NodeId): void => {
    if (seen.has(id)) return
    seen.add(id)
    const node = scene.getNode(id)
    if (!node) return
    collect(node, add)
    if (isContainer(node)) for (const child of node.children) visit(child)
  }
  for (const id of ids) visit(id)

  return [...groups.values()].sort((a, b) => b.uses.length - a.uses.length || a.key.localeCompare(b.key))
}

function collect(node: SceneNode, add: (c: RGBA, use: ColorUse) => void): void {
  const lists: { kind: 'fill' | 'stroke'; paints: SceneNode['fills'] }[] = [
    { kind: 'fill', paints: node.fills },
    { kind: 'stroke', paints: node.strokes },
  ]
  for (const { kind, paints } of lists) {
    paints.forEach((paint, index) => {
      if (!paint.visible) return
      if (paint.type === 'SOLID') {
        add(paint.color, { nodeId: node.id, kind, index, stop: null })
      } else if (paint.type !== 'IMAGE') {
        paint.stops.forEach((s, stop) => add(s.color, { nodeId: node.id, kind, index, stop }))
      }
    })
  }
}

/**
 * Put `next` everywhere `uses` points, in place.
 *
 * Takes the uses rather than re-deriving them from a colour, because by the
 * time this runs the caller may already have changed one of them — and a
 * second pass looking for "the old colour" would then find fewer places than
 * the user was shown, and silently recolour less than the swatch promised.
 */
export function applyColorToUses(scene: SceneGraph, uses: readonly ColorUse[], next: RGBA): NodeId[] {
  const touched = new Set<NodeId>()
  for (const use of uses) {
    const node = scene.getNode(use.nodeId)
    if (!node) continue
    const list = use.kind === 'fill' ? node.fills : node.strokes
    const paint = list[use.index]
    if (!paint) continue
    if (paint.type === 'SOLID' && use.stop === null) {
      paint.color = { ...next }
      touched.add(use.nodeId)
    } else if ((paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') && use.stop !== null) {
      const stop = paint.stops[use.stop]
      if (!stop) continue
      stop.color = { ...next }
      touched.add(use.nodeId)
    }
  }
  return [...touched]
}
