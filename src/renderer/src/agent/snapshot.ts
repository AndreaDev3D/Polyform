// Pixel snapshots for agents (v0.6 item 7.2).
//
// Structure tells an agent what is there; only pixels tell it what the work
// LOOKS like. Two views: the region the user is actually looking at, and one
// layer on its own.
//
// Budget: an image costs a client roughly (w x h) / 750 tokens, and Claude
// Code caps a tool result near 25k. So the long edge is clamped hard and the
// applied scale is REPORTED — an agent measuring pixels off a silently
// downscaled image would draw wrong conclusions.

import { documentStore } from '../state/document'
import { editor } from '../state/editor'
import { assetCache } from '../engine/assets'
import { renderNodesToCanvas } from '../engine/render/canvas2d'
import { hasPendingSnapshots, settleSnapshots } from '../render3d/snapshots'
import type { AABB } from '../engine/geometry'

/** Long-edge ceiling. 1568px is where Claude stops gaining detail. */
export const MAX_EDGE = 1568
const DEFAULT_EDGE = 1024
/** Canvas background for snapshots, matching the app's canvas. */
const CANVAS_BG = '#1e1e1e'

export interface Snapshot {
  base64: string
  width: number
  height: number
  /** Scale applied relative to document pixels, so sizes stay interpretable. */
  scale: number
  note?: string
}

function fit(w: number, h: number, maxEdge: number): number {
  const longest = Math.max(w, h)
  return longest <= 0 ? 1 : Math.min(1, maxEdge / longest)
}

async function encode(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!blob) throw new Error('failed to encode PNG')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Render a world-space region (or a node's own bounds) to a PNG. 3D nodes
 * resolve asynchronously (ADR-020), so settle them and repaint before
 * encoding — otherwise the agent gets grey placeholder boxes.
 */
async function render(
  ids: string[],
  region: AABB | undefined,
  scale: number,
): Promise<HTMLCanvasElement> {
  const scene = documentStore.scene
  const index = documentStore.index
  let canvas = renderNodesToCanvas(scene, index, ids, scale, assetCache, CANVAS_BG, region)
  if (!canvas) throw new Error('nothing to render')
  if (hasPendingSnapshots()) {
    await settleSnapshots()
    canvas = renderNodesToCanvas(scene, index, ids, scale, assetCache, CANVAS_BG, region) ?? canvas
  }
  return canvas
}

/** What the user is looking at right now, at their current zoom. */
export async function viewportSnapshot(maxEdge = DEFAULT_EDGE): Promise<Snapshot> {
  const { camera, viewportSize } = editor.get()
  const region: AABB = {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + viewportSize.w / camera.zoom,
    maxY: camera.y + viewportSize.h / camera.zoom,
  }
  // Only what intersects the view, in scene order.
  const visible = documentStore.index
    .search(region)
    .filter((id) => documentStore.scene.getNode(id)?.visible)
  const edge = Math.min(maxEdge, MAX_EDGE)
  // Start from the user's own zoom so the image matches what they see, then
  // clamp if that would exceed the budget.
  const scale = Math.min(camera.zoom, camera.zoom * fit(viewportSize.w, viewportSize.h, edge))
  const canvas = await render(visible, region, scale)
  return {
    base64: await encode(canvas),
    width: canvas.width,
    height: canvas.height,
    scale,
    note:
      visible.length === 0
        ? 'The visible area is empty — the user may be scrolled away from the content.'
        : undefined,
  }
}

/** One layer and its subtree, cropped to its own bounds. */
export async function nodeSnapshot(id: string, maxEdge = DEFAULT_EDGE): Promise<Snapshot> {
  const node = documentStore.scene.getNode(id)
  if (!node) throw new Error(`no node with id ${JSON.stringify(id)} — ids come from get_document`)
  const box = documentStore.scene.worldAABB(id)
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  if (w <= 0 || h <= 0) throw new Error(`"${node.name}" has no area to render`)
  const scale = fit(w, h, Math.min(maxEdge, MAX_EDGE))
  const canvas = await render([id], undefined, scale)
  return {
    base64: await encode(canvas),
    width: canvas.width,
    height: canvas.height,
    scale,
    note: node.visible ? undefined : `"${node.name}" is hidden in the document; rendered anyway.`,
  }
}
