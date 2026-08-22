// The material raster cache: one producer, two consumers (ADR-030).
//
// Shader output lives here as plain pixels (straight-alpha RGBA bytes) plus a
// lazily-created ImageBitmap for the renderers. Keys are CONTENT — shader id,
// registry generation, quantized uniforms, raster size, class inputs — so a
// raster survives scene re-bakes (the caching ADR-017 deferred) and dies
// exactly when something it depends on changes.
//
// The shape of the API is render3d/snapshots.ts, deliberately: synchronous
// `get` that never blocks a frame, `request` that fills misses in the
// background, an `onChange` the canvas subscribes to, and stale-until-swap so
// a uniform scrub redraws the old raster until the new one lands. Production
// prefers the island (GPU); built-ins fall back to their per-pixel TS twin
// when no island exists, so built-ins render correctly on machines with no
// GPU at all — including every export, which runs through Canvas2D.

import type { MaterialUniformValue } from '../types'
import { getShader, resolveUniforms, shaderGeneration, type ShaderManifest } from './registry'

export interface MaterialRasterSpec {
  shaderId: string
  /** Resolved uniforms (registry.resolveUniforms output — defaults applied). */
  uniforms: Record<string, MaterialUniformValue>
  /** Raster size in device pixels (already bucketed by the caller). */
  width: number
  height: number
  /** Device pixels per document unit at this bucket — shaders that think in
   *  document units divide by it; part of the key via width/height already. */
  pxScale: number
  /**
   * Content hash of class-specific inputs: '' for procedural, the fills hash
   * for base, the outline hash for sdf. Opaque here; the caller owns it.
   */
  classKey: string
  /** Class inputs, present when the class needs them at production time. */
  srcPixels?: Uint8ClampedArray
  sdf?: Float32Array
}

export interface MaterialRaster {
  key: string
  width: number
  height: number
  /** Straight-alpha RGBA bytes, row-major, top-left origin. */
  pixels: Uint8ClampedArray
  /** Created lazily where ImageBitmap exists; renderers draw this. */
  bitmap: ImageBitmap | null
}

/** Produce pixels for a spec, or null to decline (lets the twin try). */
export type MaterialProducer = (
  spec: MaterialRasterSpec,
  wgsl: string,
  manifest: ShaderManifest,
) => Promise<Uint8ClampedArray | null>

const BUDGET_BYTES = 64 * 1024 * 1024

/** √2 size buckets, clamped — the snapshots.ts scheme, tighter cap: materials
 *  are fills, not shadows, and 1024px of shader is plenty at any zoom. */
export function rasterBucket(px: number): number {
  const clamped = Math.min(1024, Math.max(16, px))
  const step = Math.round(Math.log2(clamped) * 2)
  return Math.min(1024, Math.round(2 ** (step / 2)))
}

/** Quantize a uniform value into key-stable integers (no float formatting). */
function quantize(value: MaterialUniformValue, step: number): string {
  if (typeof value === 'number') return String(Math.round(value / step))
  if (typeof value === 'boolean') return value ? '1' : '0'
  if ('r' in value) {
    return [value.r, value.g, value.b, value.a].map((c) => Math.round(c * 1000)).join(',')
  }
  return `${Math.round(value.x / step)},${Math.round(value.y / step)}`
}

export function materialRasterKey(manifest: ShaderManifest, spec: MaterialRasterSpec): string {
  const parts: string[] = [manifest.id, String(shaderGeneration()), `${spec.width}x${spec.height}`, spec.classKey]
  for (const u of manifest.uniforms) {
    parts.push(`${u.key}=${quantize(spec.uniforms[u.key] ?? u.default, u.step ?? 1e-3)}`)
  }
  return parts.join('|')
}

// ---------------------------------------------------------------------------

const entries = new Map<string, MaterialRaster>()
const pending = new Set<string>()
let bytes = 0
let holds = 0
let islandProducer: MaterialProducer | null = null
const listeners = new Set<() => void>()
const inflight = new Set<Promise<void>>()

export function onMaterialChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The island (or a test double) registers itself here. */
export function setMaterialProducer(producer: MaterialProducer | null): void {
  islandProducer = producer
}

/** Scrubs pin the cache: evicting a slider's own working set mid-drag would
 *  make the drag re-produce what it just threw away. */
export function holdMaterialEvictions(): () => void {
  holds++
  let done = false
  return () => {
    if (done) return
    done = true
    holds--
    evictOverBudget()
  }
}

function evictOverBudget(): void {
  if (holds > 0) return
  // Map iteration order is insertion order; get() re-inserts on touch, so the
  // front of the map is the least recently used — the snapshots.ts scheme.
  for (const [key, entry] of entries) {
    if (bytes <= BUDGET_BYTES) break
    entries.delete(key)
    bytes -= entry.pixels.byteLength
    entry.bitmap?.close?.()
  }
}

export function getMaterialRaster(key: string): MaterialRaster | null {
  const entry = entries.get(key)
  if (!entry) return null
  entries.delete(key)
  entries.set(key, entry) // LRU touch
  return entry
}

/**
 * The nearest usable raster for a shader while the exact one produces: the
 * most recently produced entry for the same shader id and class inputs. A
 * scrub redraws this until the fresh raster swaps in.
 */
export function getStaleMaterialRaster(manifest: ShaderManifest, spec: MaterialRasterSpec): MaterialRaster | null {
  const prefix = `${manifest.id}|${shaderGeneration()}|`
  let best: MaterialRaster | null = null
  for (const entry of entries.values()) {
    if (entry.key.startsWith(prefix) && entry.key.includes(`|${spec.classKey}|`)) best = entry
  }
  return best
}

/** Everything a shader produced, gone — project shader reloads land here. */
export function invalidateMaterialRasters(shaderId?: string): void {
  for (const [key, entry] of [...entries]) {
    if (shaderId && !key.startsWith(`${shaderId}|`)) continue
    entries.delete(key)
    bytes -= entry.pixels.byteLength
    entry.bitmap?.close?.()
  }
  notify()
}

function notify(): void {
  for (const fn of [...listeners]) fn()
}

/** Run a built-in's TS twin over the raster. Straight alpha, top-left rows. */
export function produceWithTwin(
  manifest: ShaderManifest,
  spec: MaterialRasterSpec,
  twin: NonNullable<ReturnType<typeof getShader>>['twin'],
): Uint8ClampedArray {
  const { width, height } = spec
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = twin!(x, y, width, height, spec.uniforms)
      const i = (y * width + x) * 4
      out[i] = Math.round(Math.min(1, Math.max(0, c.r)) * 255)
      out[i + 1] = Math.round(Math.min(1, Math.max(0, c.g)) * 255)
      out[i + 2] = Math.round(Math.min(1, Math.max(0, c.b)) * 255)
      out[i + 3] = Math.round(Math.min(1, Math.max(0, c.a)) * 255)
    }
  }
  return out
}

/**
 * Ensure a raster exists or is on its way. Returns the cache key. Misses are
 * filled asynchronously — island first, TS twin as the no-GPU fallback for
 * built-ins — and announced through onMaterialChange.
 */
export function requestMaterialRaster(spec: MaterialRasterSpec): string | null {
  const shader = getShader(spec.shaderId)
  if (!shader) return null
  const manifest = shader.manifest
  const resolved = resolveUniforms(manifest, { shaderId: spec.shaderId, uniforms: spec.uniforms })
  const full: MaterialRasterSpec = { ...spec, uniforms: resolved }
  const key = materialRasterKey(manifest, full)
  if (entries.has(key) || pending.has(key)) return key
  pending.add(key)

  const job = (async () => {
    let pixels: Uint8ClampedArray | null = null
    if (islandProducer) {
      try {
        pixels = await islandProducer(full, shader.wgsl, manifest)
      } catch {
        pixels = null // island failures are per-shader statuses, not cache faults
      }
    }
    if (!pixels && shader.twin) {
      pixels = produceWithTwin(manifest, full, shader.twin)
    }
    if (!pixels) return // WGSL-only shader with no island: consumers draw the fallback

    let bitmap: ImageBitmap | null = null
    if (typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
      try {
        // Fresh, unshared allocation; TS 5.9 just cannot see that through the generic.
        bitmap = await createImageBitmap(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, full.width, full.height))
      } catch {
        bitmap = null
      }
    }
    entries.set(key, { key, width: full.width, height: full.height, pixels, bitmap })
    bytes += pixels.byteLength
    evictOverBudget()
    notify()
  })().finally(() => pending.delete(key))

  const tracked: Promise<void> = job.then(
    () => undefined,
    () => undefined,
  )
  inflight.add(tracked)
  void tracked.finally(() => inflight.delete(tracked))
  return key
}

/** Exports wait for this so a PNG never ships a placeholder (png.ts pattern). */
export async function settleMaterials(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.all([...inflight])
  }
}

/** Test seam. */
export function resetMaterialCacheForTests(): void {
  for (const entry of entries.values()) entry.bitmap?.close?.()
  entries.clear()
  pending.clear()
  bytes = 0
  holds = 0
  islandProducer = null
}

export function materialCacheBytes(): number {
  return bytes
}
