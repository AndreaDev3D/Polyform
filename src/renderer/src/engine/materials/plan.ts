// Decide, for one node in one frame, what its material means for a renderer:
// nothing, a raster to composite, a declared fallback colour, or "still
// producing". BOTH backends call this — it owns sizing, cache keys and class
// inputs, so the two can never disagree about what a material looks like,
// only about how they put the same bitmap on screen.
//
// The class decides the composite mode (ADR-030 — no placement knob):
//   procedural / sdf  -> 'over'     drawn after the node's fills
//   base              -> 'replace'  drawn instead of them
//   backdrop          -> handled in-renderer (the bg-blur pass split); this
//                        planner returns 'none' for it until that lands.

import type { MaterialUniformValue, RGBA, SceneNode } from '../types'
import { getShader, resolveUniforms, shaderStatus } from './registry'
import { signedDistanceField } from './edt'
import {
  getMaterialRaster,
  getStaleMaterialRaster,
  materialProductionPossible,
  materialRasterKey,
  requestMaterialRaster,
  type MaterialRaster,
  type MaterialRasterSpec,
} from './raster-cache'

export interface MaterialHelpers {
  /** Coverage of the node's outline at raster size — alpha bytes, straight rows. */
  rasterizeMask: (node: SceneNode, width: number, height: number) => Uint8ClampedArray | null
  /** The node's own fills at raster size — straight RGBA bytes. */
  rasterizeFills: (node: SceneNode, width: number, height: number) => Uint8ClampedArray | null
}

export type MaterialPlan =
  | { kind: 'none' }
  | { kind: 'pending'; mode: 'over' | 'replace' }
  | { kind: 'raster'; mode: 'over' | 'replace'; raster: MaterialRaster; key: string }
  | { kind: 'fallback'; mode: 'over' | 'replace'; color: RGBA }

const NONE: MaterialPlan = { kind: 'none' }

/** Longest side lands on a √2 bucket ≤1024; the other keeps the aspect. */
export function materialRasterSize(node: SceneNode, deviceScale: number): { width: number; height: number; pxScale: number } {
  const w = Math.max(1, node.width)
  const h = Math.max(1, node.height)
  const long = Math.max(w, h)
  const bucketed = bucketSide(long * Math.max(0.05, deviceScale))
  const pxScale = bucketed / long
  return {
    width: Math.max(1, Math.round(w * pxScale)),
    height: Math.max(1, Math.round(h * pxScale)),
    pxScale,
  }
}

function bucketSide(px: number): number {
  const clamped = Math.min(1024, Math.max(16, px))
  const step = Math.round(Math.log2(clamped) * 2)
  return Math.min(1024, Math.round(2 ** (step / 2)))
}

/** djb2 over a float array — content hashes for masks and outlines. */
function hashFloats(data: ArrayLike<number>): string {
  let h = 5381
  for (let i = 0; i < data.length; i++) {
    // Two rounds over the float's integer image keeps the hash cheap and stable.
    const v = Math.round(data[i] * 128)
    h = ((h << 5) + h + (v & 0xff)) | 0
    h = ((h << 5) + h + ((v >> 8) & 0xff)) | 0
  }
  return (h >>> 0).toString(36)
}

function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// SDFs are deterministic in their mask, and masks in the node geometry — but
// hashing geometry means re-listing every outline-relevant field, which is
// how things drift. Hash the mask bytes instead: honest, and cheap next to
// the EDT that follows a miss.
const sdfCache = new Map<string, Float32Array>()
const SDF_CACHE_MAX = 64

export function planMaterial(node: SceneNode, deviceScale: number, helpers: MaterialHelpers): MaterialPlan {
  const material = node.material
  if (!material) return NONE
  const shader = getShader(material.shaderId)
  if (!shader || shaderStatus(material.shaderId).kind !== 'ready') return NONE

  const manifest = shader.manifest
  if (manifest.class === 'backdrop') return NONE // commit: glass rides the pass split

  const mode: 'over' | 'replace' = manifest.class === 'base' ? 'replace' : 'over'
  if (!materialProductionPossible(shader)) {
    return { kind: 'fallback', mode, color: manifest.fallback }
  }

  const { width, height, pxScale } = materialRasterSize(node, deviceScale)
  const uniforms: Record<string, MaterialUniformValue> = resolveUniforms(manifest, material)
  const spec: MaterialRasterSpec = { shaderId: material.shaderId, uniforms, width, height, pxScale, classKey: '' }

  if (manifest.class === 'sdf') {
    const mask = helpers.rasterizeMask(node, width, height)
    if (!mask) return { kind: 'pending', mode }
    const maskKey = `${hashString(String(mask.length))}:${hashFloats(mask)}`
    spec.classKey = `sdf@${maskKey}`
    let sdf = sdfCache.get(spec.classKey)
    if (!sdf) {
      sdf = signedDistanceField(mask, width, height)
      sdfCache.set(spec.classKey, sdf)
      if (sdfCache.size > SDF_CACHE_MAX) {
        const first = sdfCache.keys().next().value
        if (first) sdfCache.delete(first)
      }
    }
    spec.sdf = sdf
  } else if (manifest.class === 'base') {
    const src = helpers.rasterizeFills(node, width, height)
    if (!src) return { kind: 'pending', mode }
    spec.classKey = `base@${hashFloats(src)}`
    spec.srcPixels = src
  }

  const key = requestMaterialRaster(spec)
  if (!key) return NONE
  const exact = getMaterialRaster(key)
  if (exact) return { kind: 'raster', mode, raster: exact, key }
  const stale = getStaleMaterialRaster(manifest, { ...spec, classKey: spec.classKey })
  if (stale) return { kind: 'raster', mode, raster: stale, key: stale.key }
  return { kind: 'pending', mode }
}

/** Key preview for cache-coherence tests. */
export function planKeyFor(node: SceneNode, deviceScale: number): string | null {
  const material = node.material
  if (!material) return null
  const shader = getShader(material.shaderId)
  if (!shader) return null
  const { width, height, pxScale } = materialRasterSize(node, deviceScale)
  return materialRasterKey(shader.manifest, {
    shaderId: material.shaderId,
    uniforms: resolveUniforms(shader.manifest, material),
    width,
    height,
    pxScale,
    classKey: '',
  })
}
