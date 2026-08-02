// Snapshot cache for MODEL3D nodes (ADR-020).
//
// Renderers are synchronous: they ask `getSnapshot` for a bitmap and draw a
// placeholder if it isn't ready. Misses queue an offscreen render on the
// island and notify subscribers when it lands, exactly like the async
// image-decode path. Cache keys cover everything the render depends on, so
// a cached snapshot is always current for the node's pose and size.

import type { LightingPreset, Model3dFormat, Model3dNode, ModelPose } from '../engine/types'
import { MAX_SNAPSHOT_PX, renderModel, dropModel } from './island'

/** Size buckets keep zooming from thrashing the cache (powers of √2). */
function bucketSize(px: number): number {
  const clamped = Math.max(32, Math.min(MAX_SNAPSHOT_PX, px))
  const step = Math.ceil(Math.log2(clamped / 32) * 2)
  return Math.min(MAX_SNAPSHOT_PX, Math.round(32 * Math.SQRT2 ** step))
}

export interface SnapshotSpec {
  assetHash: string
  format: Model3dFormat
  pose: ModelPose
  lighting: LightingPreset
  upright: boolean
  /** Bucketed pixel size of the rendered image. */
  width: number
  height: number
}

export function snapshotSpec(node: Model3dNode, cssWidth: number, cssHeight: number, dpr: number): SnapshotSpec {
  const w = bucketSize(cssWidth * dpr)
  // Keep the model's aspect ratio matched to the node box.
  const aspect = cssHeight > 0 ? cssHeight / Math.max(1e-6, cssWidth) : 1
  return {
    assetHash: node.assetHash,
    format: node.format,
    pose: node.camera,
    lighting: node.lighting,
    upright: node.upright ?? true,
    width: w,
    height: Math.max(1, Math.min(MAX_SNAPSHOT_PX, Math.round(w * aspect))),
  }
}

function specKey(s: SnapshotSpec): string {
  const p = s.pose
  const round = (v: number) => Math.round(v * 100) / 100
  return [
    s.assetHash,
    s.format,
    round(p.yaw),
    round(p.pitch),
    round(p.distance),
    round(p.fov),
    s.lighting,
    s.upright ? 'up' : 'raw',
    s.width,
    s.height,
  ].join('|')
}

const CACHE_LIMIT = 24

const cache = new Map<string, ImageBitmap>()
const pending = new Map<string, Promise<void>>()
const failed = new Map<string, string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

export function onSnapshotChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Ready-now bitmap for this exact view, or undefined. */
export function getSnapshot(spec: SnapshotSpec): ImageBitmap | undefined {
  const key = specKey(spec)
  const hit = cache.get(key)
  if (hit) {
    // Refresh LRU position.
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

/** The most recent snapshot of the same model at any pose/size — drawn
 *  stretched as a placeholder while the exact view renders. */
export function getStaleSnapshot(spec: SnapshotSpec): ImageBitmap | undefined {
  const prefix = `${spec.assetHash}|`
  let latest: ImageBitmap | undefined
  for (const [key, bmp] of cache) if (key.startsWith(prefix)) latest = bmp
  return latest
}

export function snapshotError(spec: SnapshotSpec): string | undefined {
  return failed.get(spec.assetHash)
}

/** Default byte source: the bundle's content-addressed assets. */
async function readAssetBytes(hash: string): Promise<Uint8Array | null> {
  const asset = await window.polyform.assetsRead(hash)
  return asset ? asset.bytes : null
}

/**
 * Ensure a snapshot for this view exists, rendering it if needed.
 * `loadBytes` is called only on a model-load miss.
 */
export function requestSnapshot(
  spec: SnapshotSpec,
  loadBytes: () => Promise<Uint8Array | null> = () => readAssetBytes(spec.assetHash),
): void {
  const key = specKey(spec)
  if (cache.has(key) || pending.has(key) || failed.has(spec.assetHash)) return
  const job = (async () => {
    try {
      const bytes = await loadBytes()
      if (!bytes) throw new Error('model asset missing from bundle')
      const bitmap = await renderModel(spec.assetHash, {
        bytes,
        format: spec.format,
        pose: spec.pose,
        lighting: spec.lighting,
        upright: spec.upright,
        width: spec.width,
        height: spec.height,
      })
      while (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value as string | undefined
        if (oldest === undefined) break
        cache.get(oldest)?.close()
        cache.delete(oldest)
      }
      cache.set(key, bitmap)
    } catch (err) {
      failed.set(spec.assetHash, err instanceof Error ? err.message : String(err))
    } finally {
      pending.delete(key)
      notify()
    }
  })()
  pending.set(key, job)
}

export function hasPendingSnapshots(): boolean {
  return pending.size > 0
}

/**
 * Render (or reuse) this view and encode it as PNG bytes — the export
 * paths need finished pixels, not a placeholder.
 */
export async function snapshotPng(spec: SnapshotSpec): Promise<Uint8Array | null> {
  requestSnapshot(spec)
  await settleSnapshots()
  const bmp = getSnapshot(spec)
  if (!bmp) return null
  const off = new OffscreenCanvas(bmp.width, bmp.height)
  off.getContext('2d')!.drawImage(bmp, 0, 0)
  const blob = await off.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/** Await every in-flight render — export paths need finished pixels. */
export async function settleSnapshots(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending.values()])
}

/** Drop everything for one asset (replaced bytes) or the whole cache. */
export function invalidateSnapshots(assetHash?: string): void {
  for (const [key, bmp] of [...cache]) {
    if (assetHash === undefined || key.startsWith(`${assetHash}|`)) {
      bmp.close()
      cache.delete(key)
    }
  }
  if (assetHash === undefined) failed.clear()
  else failed.delete(assetHash)
  if (assetHash !== undefined) void dropModel(assetHash)
  notify()
}
