// Derived-state passes run after every scene mutation, before rendering:
//   1. text auto-resize        2. auto-layout frames        3. group/boolean
// bounds normalization. These are deterministic recomputations — they mutate
// the scene directly and never enter the undo journal.

import type { FrameLikeNode, NodeId, SceneNode } from './types'
import { isContainer, isFrameLike } from './types'
import type { SceneGraph } from './scene'
import { aabbOfPoints, applyMat, nodeLocalMatrix } from './geometry'
import { layoutText } from './text'
import { booleanRings } from './booleans'
import { collectGarbage, syncInstances } from './components'

const EPS = 0.01

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}

function autoResizeText(scene: SceneGraph): boolean {
  let changed = false
  for (const node of Object.values(scene.doc.nodes)) {
    if (node.type !== 'TEXT') continue
    const layout = layoutText(node)
    if (node.autoResize === 'WIDTH_AND_HEIGHT') {
      if (!near(node.width, layout.totalWidth) || !near(node.height, layout.totalHeight)) {
        node.width = layout.totalWidth
        node.height = layout.totalHeight
        changed = true
      }
    } else if (node.autoResize === 'HEIGHT') {
      if (!near(node.height, layout.totalHeight)) {
        node.height = layout.totalHeight
        changed = true
      }
    }
  }
  return changed
}

function layoutFrame(scene: SceneGraph, frame: FrameLikeNode): boolean {
  const l = frame.layout
  if (l.mode === 'NONE') return false
  let changed = false
  const horizontal = l.mode === 'HORIZONTAL'
  const children = frame.children
    .map((id) => scene.getNode(id))
    .filter((n): n is SceneNode => !!n && n.visible)

  let primary = horizontal ? l.paddingLeft : l.paddingTop
  let maxCounter = 0
  for (const child of children) {
    const primarySize = horizontal ? child.width : child.height
    const counterSize = horizontal ? child.height : child.width
    maxCounter = Math.max(maxCounter, counterSize)
    primary += primarySize + l.gap
  }
  if (children.length > 0) primary -= l.gap
  primary += horizontal ? l.paddingRight : l.paddingBottom

  const counterPadStart = horizontal ? l.paddingTop : l.paddingLeft
  const counterPadEnd = horizontal ? l.paddingBottom : l.paddingRight

  // Hug sizing.
  if (l.primarySizing === 'HUG') {
    const target = Math.max(primary, horizontal ? l.paddingLeft + l.paddingRight : l.paddingTop + l.paddingBottom)
    if (horizontal ? !near(frame.width, target) : !near(frame.height, target)) {
      if (horizontal) frame.width = target
      else frame.height = target
      changed = true
    }
  }
  if (l.counterSizing === 'HUG') {
    const target = maxCounter + counterPadStart + counterPadEnd
    if (horizontal ? !near(frame.height, target) : !near(frame.width, target)) {
      if (horizontal) frame.height = target
      else frame.width = target
      changed = true
    }
  }

  // Position children.
  const counterSpace = (horizontal ? frame.height : frame.width) - counterPadStart - counterPadEnd
  let cursor = horizontal ? l.paddingLeft : l.paddingTop
  for (const child of children) {
    const counterSize = horizontal ? child.height : child.width
    let counterPos = counterPadStart
    if (l.counterAlign === 'CENTER') counterPos = counterPadStart + (counterSpace - counterSize) / 2
    else if (l.counterAlign === 'MAX') counterPos = counterPadStart + counterSpace - counterSize
    const nx = horizontal ? cursor : counterPos
    const ny = horizontal ? counterPos : cursor
    if (!near(child.x, nx) || !near(child.y, ny)) {
      child.x = nx
      child.y = ny
      changed = true
    }
    cursor += (horizontal ? child.width : child.height) + l.gap
  }
  return changed
}

/**
 * Keep GROUP/BOOLEAN x/y/w/h tight around their children. Only safe for
 * unrotated containers (rotated ones keep their frame until rotation resets).
 */
function normalizeContainers(scene: SceneGraph, id: NodeId): boolean {
  const node = scene.getNode(id)
  if (!node) return false
  let changed = false
  if (isContainer(node)) {
    for (const cid of [...node.children]) changed = normalizeContainers(scene, cid) || changed
  }
  if ((node.type === 'GROUP' || node.type === 'BOOLEAN') && node.rotation === 0) {
    if (node.type === 'BOOLEAN') {
      const rings = booleanRings(scene, node)
      if (rings.length > 0) {
        const box = aabbOfPoints(rings.flat())
        const w = Math.max(1, box.maxX - box.minX)
        const h = Math.max(1, box.maxY - box.minY)
        if (!near(box.minX, 0) || !near(box.minY, 0) || !near(node.width, w) || !near(node.height, h)) {
          for (const cid of node.children) {
            const c = scene.getNode(cid)
            if (!c) continue
            c.x -= box.minX
            c.y -= box.minY
          }
          node.x += box.minX
          node.y += box.minY
          node.width = w
          node.height = h
          changed = true
        }
      }
    } else if (node.children.length > 0) {
      const pts = node.children.flatMap((cid) => {
        const c = scene.getNode(cid)
        if (!c || !c.visible) return []
        const m = nodeLocalMatrix(c.x, c.y, c.width, c.height, c.rotation)
        return [
          applyMat(m, { x: 0, y: 0 }),
          applyMat(m, { x: c.width, y: 0 }),
          applyMat(m, { x: c.width, y: c.height }),
          applyMat(m, { x: 0, y: c.height }),
        ]
      })
      if (pts.length > 0) {
        const box = aabbOfPoints(pts)
        const w = Math.max(1, box.maxX - box.minX)
        const h = Math.max(1, box.maxY - box.minY)
        if (!near(box.minX, 0) || !near(box.minY, 0) || !near(node.width, w) || !near(node.height, h)) {
          for (const cid of node.children) {
            const c = scene.getNode(cid)
            if (!c) continue
            c.x -= box.minX
            c.y -= box.minY
          }
          node.x += box.minX
          node.y += box.minY
          node.width = w
          node.height = h
          changed = true
        }
      }
    }
  }
  return changed
}

function layoutFrames(scene: SceneGraph, id: NodeId): boolean {
  const node = scene.getNode(id)
  if (!node) return false
  let changed = false
  if (isContainer(node)) {
    for (const cid of node.children) changed = layoutFrames(scene, cid) || changed
  }
  if (isFrameLike(node)) changed = layoutFrame(scene, node) || changed
  return changed
}

/**
 * Run all derived passes until stable (bounded). Returns true when anything
 * changed; the caller bumps the scene version once.
 */
export function runDerivedPasses(scene: SceneGraph): boolean {
  let changedAny = false
  for (let i = 0; i < 5; i++) {
    let changed = false
    changed = syncInstances(scene) || changed
    changed = autoResizeText(scene) || changed
    for (const rid of scene.rootIds()) changed = layoutFrames(scene, rid) || changed
    for (const rid of scene.rootIds()) changed = normalizeContainers(scene, rid) || changed
    if (changed) {
      scene.bump()
      changedAny = true
    } else {
      break
    }
  }
  if (collectGarbage(scene)) {
    scene.bump()
    changedAny = true
  }
  return changedAny
}
