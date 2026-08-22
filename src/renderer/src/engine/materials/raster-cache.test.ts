// The cache's contracts: content keys, LRU under a byte budget, twin
// fallback production, stale-until-swap, and settle for exports. Everything
// here runs GPU-less — the island is just another producer to inject.

import { beforeEach, describe, expect, it } from 'vitest'
import { registerBuiltin, resetRegistryForTests, resolveUniforms, getShader } from './registry'
import { stripes } from './builtins/stripes'
import {
  getMaterialRaster,
  getStaleMaterialRaster,
  holdMaterialEvictions,
  invalidateMaterialRasters,
  materialCacheBytes,
  materialRasterKey,
  onMaterialChange,
  produceWithTwin,
  rasterBucket,
  requestMaterialRaster,
  resetMaterialCacheForTests,
  setMaterialProducer,
  settleMaterials,
  type MaterialRasterSpec,
} from './raster-cache'
import { packUniforms, wrapMaterialWgsl, MATERIAL_SIGNATURES } from './wrap-wgsl'

function spec(over: Partial<MaterialRasterSpec> = {}): MaterialRasterSpec {
  const manifest = getShader('stripes')!.manifest
  return {
    shaderId: 'stripes',
    uniforms: resolveUniforms(manifest, { shaderId: 'stripes', uniforms: {} }),
    width: 32,
    height: 32,
    pxScale: 1,
    classKey: '',
    ...over,
  }
}

beforeEach(() => {
  resetRegistryForTests()
  resetMaterialCacheForTests()
  registerBuiltin(stripes)
})

describe('keys and buckets', () => {
  it('buckets sizes on √2 steps within [16, 1024]', () => {
    expect(rasterBucket(4)).toBe(16)
    expect(rasterBucket(100)).toBeGreaterThanOrEqual(90)
    expect(rasterBucket(100)).toBeLessThanOrEqual(128)
    expect(rasterBucket(99999)).toBe(1024)
  })

  it('quantizes uniforms by manifest step — a sub-step wiggle is the same key', () => {
    const manifest = getShader('stripes')!.manifest
    const a = materialRasterKey(manifest, spec({ uniforms: { ...spec().uniforms, angle: 45 } }))
    const b = materialRasterKey(manifest, spec({ uniforms: { ...spec().uniforms, angle: 45.3 } }))
    const c = materialRasterKey(manifest, spec({ uniforms: { ...spec().uniforms, angle: 46 } }))
    expect(a).toBe(b) // step 1: 45.3 rounds to 45
    expect(a).not.toBe(c)
  })
})

describe('production', () => {
  it('falls back to the TS twin when no producer is installed', async () => {
    const key = requestMaterialRaster(spec())!
    expect(key).toBeTruthy()
    // With no island installed the twin path has no awaits, so the raster may
    // land synchronously — an implementation detail the caller must not rely
    // on either way. settle() is the contract.
    await settleMaterials()
    const raster = getMaterialRaster(key)!
    expect(raster.width).toBe(32)
    expect(raster.pixels.length).toBe(32 * 32 * 4)
    const distinct = new Set<string>()
    for (let i = 0; i < raster.pixels.length; i += 4) {
      distinct.add(`${raster.pixels[i]},${raster.pixels[i + 1]}`)
    }
    expect(distinct.size).toBeGreaterThan(1) // stripes are not one flat colour
  })

  it('prefers the installed producer and falls back per-request on decline', async () => {
    let calls = 0
    setMaterialProducer(async () => {
      calls++
      return null // decline: no GPU result
    })
    const key = requestMaterialRaster(spec())!
    await settleMaterials()
    expect(calls).toBe(1)
    expect(getMaterialRaster(key)).not.toBeNull() // twin filled it anyway
  })

  it('notifies listeners when a raster lands', async () => {
    let notified = 0
    const off = onMaterialChange(() => notified++)
    requestMaterialRaster(spec())
    await settleMaterials()
    off()
    expect(notified).toBe(1)
  })

  it('dedupes concurrent requests for the same key', async () => {
    let produced = 0
    setMaterialProducer(async (s) => {
      produced++
      return produceWithTwin(getShader('stripes')!.manifest, s, getShader('stripes')!.twin)
    })
    const k1 = requestMaterialRaster(spec())
    const k2 = requestMaterialRaster(spec())
    expect(k1).toBe(k2)
    await settleMaterials()
    expect(produced).toBe(1)
  })
})

describe('eviction', () => {
  it('holds the budget by evicting least-recently-used first', async () => {
    // 512x512 rasters are 1MiB each; the budget is 64MiB.
    for (let i = 0; i < 70; i++) {
      requestMaterialRaster(spec({ width: 512, height: 512, uniforms: { ...spec().uniforms, angle: i } }))
    }
    await settleMaterials()
    expect(materialCacheBytes()).toBeLessThanOrEqual(64 * 1024 * 1024)
    const manifest = getShader('stripes')!.manifest
    const oldest = materialRasterKey(manifest, spec({ width: 512, height: 512, uniforms: { ...spec().uniforms, angle: 0 } }))
    const newest = materialRasterKey(manifest, spec({ width: 512, height: 512, uniforms: { ...spec().uniforms, angle: 69 } }))
    expect(getMaterialRaster(oldest)).toBeNull()
    expect(getMaterialRaster(newest)).not.toBeNull()
  })

  it('suspends eviction while a hold is out (a scrub cannot starve itself)', async () => {
    const release = holdMaterialEvictions()
    for (let i = 0; i < 70; i++) {
      requestMaterialRaster(spec({ width: 512, height: 512, uniforms: { ...spec().uniforms, angle: i } }))
    }
    await settleMaterials()
    expect(materialCacheBytes()).toBeGreaterThan(64 * 1024 * 1024)
    release()
    expect(materialCacheBytes()).toBeLessThanOrEqual(64 * 1024 * 1024)
  })

  it('invalidate clears a shader’s rasters', async () => {
    const key = requestMaterialRaster(spec())!
    await settleMaterials()
    invalidateMaterialRasters('stripes')
    expect(getMaterialRaster(key)).toBeNull()
    expect(materialCacheBytes()).toBe(0)
  })
})

describe('stale-until-swap', () => {
  it('serves the most recent same-shader raster while a new key produces', async () => {
    const manifest = getShader('stripes')!.manifest
    requestMaterialRaster(spec({ uniforms: { ...spec().uniforms, angle: 10 } }))
    await settleMaterials()
    const stale = getStaleMaterialRaster(manifest, spec({ uniforms: { ...spec().uniforms, angle: 99 } }))
    expect(stale).not.toBeNull()
  })
})

describe('the WGSL wrapper', () => {
  it('injects one let per uniform inside fn material and floors the pixel', () => {
    const shader = getShader('stripes')!
    const code = wrapMaterialWgsl(shader.manifest, shader.wgsl)
    expect(code).toContain('let mode: f32 = u.slots[0].x;')
    expect(code).toContain('let colorA: vec4f = u.slots[1];')
    expect(code).toContain('let softness: f32 = u.slots[5].x;')
    expect(code).toContain('let p = floor(pos.xy);')
    expect(code).toContain('array<vec4f, 12>')
  })

  it('refuses a body without the class signature, naming the shader', () => {
    const shader = getShader('stripes')!
    expect(() => wrapMaterialWgsl({ ...shader.manifest, class: 'base' }, shader.wgsl)).toThrow(
      /must declare exactly.*src: vec4f/,
    )
    expect(MATERIAL_SIGNATURES.procedural).toContain('(p: vec2f, size: vec2f)')
  })

  it('packs uniforms into info + declaration-order vec4 slots', () => {
    const shader = getShader('stripes')!
    const resolved = resolveUniforms(shader.manifest, { shaderId: 'stripes', uniforms: { angle: 30 } })
    const packed = packUniforms(shader.manifest, resolved, 64, 32, 2, 7)
    expect([...packed.slice(0, 4)]).toEqual([64, 32, 2, 7])
    expect(packed[4]).toBe(0) // mode
    expect(packed[4 + 4 * 4]).toBe(30) // angle at slot 4 (.x)
    expect(packed[4 + 1 * 4 + 3]).toBe(1) // colorA alpha
  })
})
