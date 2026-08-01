// Constraint resolution: how children reposition/resize when their parent
// frame changes size (Technical spec "Auto-Layout & Constraints").
// Applied only to frames WITHOUT auto-layout (the layout pass owns those).

import type { FrameNode, NodeId, SceneNode } from './types'
import type { SceneGraph } from './scene'

export interface ChildRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Apply one child's constraints given its rect at the OLD frame size and the
 * old/new frame dimensions. Mutates the live child.
 */
export function constrainChild(
  child: SceneNode,
  snap: ChildRect,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): void {
  const h = child.constraintsH ?? 'MIN'
  const v = child.constraintsV ?? 'MIN'
  const dw = newW - oldW
  const dh = newH - oldH

  if (h === 'MAX') {
    child.x = snap.x + dw
    child.width = snap.width
  } else if (h === 'CENTER') {
    child.x = snap.x + dw / 2
    child.width = snap.width
  } else if (h === 'STRETCH') {
    child.x = snap.x
    child.width = Math.max(0.5, snap.width + dw)
  } else if (h === 'SCALE' && oldW > 0.01) {
    const s = newW / oldW
    child.x = snap.x * s
    child.width = Math.max(0.5, snap.width * s)
  } else {
    child.x = snap.x
    child.width = snap.width
  }

  const isLine = child.type === 'LINE'
  if (v === 'MAX') {
    child.y = snap.y + dh
    if (!isLine) child.height = snap.height
  } else if (v === 'CENTER') {
    child.y = snap.y + dh / 2
    if (!isLine) child.height = snap.height
  } else if (v === 'STRETCH') {
    child.y = snap.y
    if (!isLine) child.height = Math.max(0.5, snap.height + dh)
  } else if (v === 'SCALE' && oldH > 0.01) {
    const s = newH / oldH
    child.y = snap.y * s
    if (!isLine) child.height = Math.max(0.5, snap.height * s)
  } else {
    child.y = snap.y
    if (!isLine) child.height = snap.height
  }
}

/**
 * Recursively constrain a frame's children against `snap` (rects captured
 * BEFORE the resize started). Nested plain frames whose size changed cascade
 * to their own children. The frame itself must already have its new size.
 */
export function constrainFrameChildren(
  scene: SceneGraph,
  frame: FrameNode,
  snap: (id: NodeId) => ChildRect | null,
  oldW: number,
  oldH: number,
): void {
  if (frame.layout.mode !== 'NONE') return
  for (const cid of frame.children) {
    const child = scene.getNode(cid)
    if (!child) continue
    const s = snap(cid)
    if (!s) continue
    constrainChild(child, s, oldW, oldH, frame.width, frame.height)
    if (child.type === 'FRAME' && (child.width !== s.width || child.height !== s.height)) {
      constrainFrameChildren(scene, child, snap, s.width, s.height)
    }
  }
}
