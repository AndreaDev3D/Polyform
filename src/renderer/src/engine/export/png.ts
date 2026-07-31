// PNG export at 1x-4x via an offscreen canvas render of the selected nodes.

import type { NodeId } from '../types'
import type { SceneGraph } from '../scene'
import type { SpatialIndex } from '../spatial-index'
import type { AssetCache } from '../assets'
import { renderNodesToCanvas } from '../render/canvas2d'

export async function exportPng(
  scene: SceneGraph,
  index: SpatialIndex,
  ids: NodeId[],
  scale: number,
  assets: AssetCache,
  background: string | null = null,
): Promise<Uint8Array | null> {
  const canvas = renderNodesToCanvas(scene, index, ids, scale, assets, background)
  if (!canvas) return null
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return null
  return new Uint8Array(await blob.arrayBuffer())
}

/** Small thumbnail of the whole document for the .poly bundle. */
export async function renderThumbnail(
  scene: SceneGraph,
  index: SpatialIndex,
  assets: AssetCache,
  maxSize = 512,
): Promise<Uint8Array | null> {
  const ids = scene.doc.rootIds.filter((id) => scene.getNode(id)?.visible)
  if (ids.length === 0) return null
  const box = scene.documentAABB()
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  if (w <= 0 || h <= 0) return null
  const scale = Math.min(1, maxSize / Math.max(w, h))
  return exportPng(scene, index, ids, scale, assets, '#1e1e1e')
}
