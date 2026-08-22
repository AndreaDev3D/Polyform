// The material island: a second, private GPUDevice that does nothing but
// rasterize material output into the cache (ADR-030, on the ADR-020 shape:
// the document sees only textures — here, only bitmaps).
//
// The isolation is the security and stability story for user WGSL. The scene
// renderer treats an uncaptured device error as a renderer failure and
// rebuilds itself, at most three times, then falls back to Canvas2D for the
// session (CanvasView) — a path user content must not be able to reach. Here
// a bad shader is caught by pushErrorScope('validation') around its own
// compilation, becomes a per-shader failed status with the compiler's
// message, and costs nothing but itself. If this device dies it is
// re-requested on the next production; if the machine has no WebGPU at all,
// `installMaterialIsland` leaves the cache producer-less and built-ins
// produce through their TS twins instead.
//
// Rendering details that keep producers agreeing:
//   - blending OFF, target rgba8unorm: the shader's straight-alpha return
//     value is stored verbatim — no premultiply round-trip, no double-blend.
//   - the fragment floors @builtin(position), so island pixel (x,y) is the
//     same sample point as twin(x,y) (see wrap-wgsl.ts).

import { markShaderFailed, type ShaderManifest } from './registry'
import { setMaterialProducer, type MaterialRasterSpec } from './raster-cache'
import { packUniforms, wrapMaterialWgsl, WgslWrapError } from './wrap-wgsl'

interface Island {
  device: GPUDevice
  pipelines: Map<string, GPURenderPipeline | 'failed'>
}

let island: Island | null = null
let acquiring: Promise<Island | null> | null = null

async function ensureIsland(): Promise<Island | null> {
  if (island) return island
  if (acquiring) return acquiring
  acquiring = (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
      if (!gpu) return null
      const adapter = await gpu.requestAdapter()
      if (!adapter) return null
      const device = await adapter.requestDevice()
      const created: Island = { device, pipelines: new Map() }
      void device.lost.then(() => {
        // Whatever died with the device is re-creatable from the registry;
        // the next production simply re-acquires.
        if (island === created) island = null
      })
      island = created
      return created
    } catch {
      return null
    } finally {
      acquiring = null
    }
  })()
  return acquiring
}

/**
 * Compile (and cache) the pipeline for one shader. Validation errors land on
 * the shader's status — with the compiler's own message and line — and the
 * pipeline caches as 'failed' so a broken shader costs one compile, not one
 * per frame.
 */
async function pipelineFor(isl: Island, manifest: ShaderManifest, wgsl: string, cacheKey: string): Promise<GPURenderPipeline | null> {
  const cached = isl.pipelines.get(cacheKey)
  if (cached === 'failed') return null
  if (cached) return cached

  let code: string
  try {
    code = wrapMaterialWgsl(manifest, wgsl)
  } catch (err) {
    isl.pipelines.set(cacheKey, 'failed')
    markShaderFailed(manifest.id, err instanceof WgslWrapError ? err.message : String(err))
    return null
  }

  isl.device.pushErrorScope('validation')
  const module = isl.device.createShaderModule({ code })
  const info = await module.getCompilationInfo()
  const scopeError = await isl.device.popErrorScope()
  const firstError = info.messages.find((m) => m.type === 'error')
  if (scopeError || firstError) {
    isl.pipelines.set(cacheKey, 'failed')
    const message = firstError
      ? `wgsl ${firstError.lineNum}:${firstError.linePos}: ${firstError.message}`
      : (scopeError?.message ?? 'shader failed validation')
    markShaderFailed(manifest.id, message)
    return null
  }

  try {
    isl.device.pushErrorScope('validation')
    const pipeline = await isl.device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    const pipeErr = await isl.device.popErrorScope()
    if (pipeErr) {
      isl.pipelines.set(cacheKey, 'failed')
      markShaderFailed(manifest.id, pipeErr.message)
      return null
    }
    isl.pipelines.set(cacheKey, pipeline)
    return pipeline
  } catch (err) {
    isl.pipelines.set(cacheKey, 'failed')
    markShaderFailed(manifest.id, err instanceof Error ? err.message : String(err))
    return null
  }
}

async function produce(spec: MaterialRasterSpec, wgsl: string, manifest: ShaderManifest): Promise<Uint8ClampedArray | null> {
  const isl = await ensureIsland()
  if (!isl) return null
  const pipeline = await pipelineFor(isl, manifest, wgsl, `${manifest.id}@${hashSource(wgsl)}`)
  if (!pipeline) return null

  const { device } = isl
  const { width, height } = spec

  const uniforms = packUniforms(manifest, spec.uniforms, width, height, spec.pxScale)
  const uniformBuffer = device.createBuffer({
    size: uniforms.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // TS 5.9 types these as <ArrayBufferLike>; they are fresh, unshared allocations.
  device.queue.writeBuffer(uniformBuffer, 0, uniforms as Float32Array<ArrayBuffer>)

  const bindEntries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniformBuffer } }]
  const scratch: GPUTexture[] = []

  if (manifest.class === 'base') {
    const src = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const pixels = spec.srcPixels ?? new Uint8ClampedArray(width * height * 4)
    device.queue.writeTexture({ texture: src }, pixels as Uint8ClampedArray<ArrayBuffer>, { bytesPerRow: width * 4 }, [width, height])
    bindEntries.push({ binding: 1, resource: src.createView() })
    scratch.push(src)
  } else if (manifest.class === 'sdf') {
    const sdfTex = device.createTexture({
      size: [width, height],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const sdf = spec.sdf ?? new Float32Array(width * height)
    device.queue.writeTexture({ texture: sdfTex }, sdf as Float32Array<ArrayBuffer>, { bytesPerRow: width * 4 }, [width, height])
    bindEntries.push({ binding: 1, resource: sdfTex.createView() })
    scratch.push(sdfTex)
  }

  const target = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  scratch.push(target)

  const bytesPerRow = Math.ceil((width * 4) / 256) * 256
  const readback = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: bindEntries })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
    ],
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.draw(3)
  pass.end()
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [width, height])
  device.queue.submit([encoder.finish()])

  try {
    await readback.mapAsync(GPUMapMode.READ)
    const mapped = new Uint8Array(readback.getMappedRange())
    const out = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4)
    }
    return out
  } catch {
    return null
  } finally {
    try {
      readback.unmap()
    } catch {
      /* never mapped */
    }
    readback.destroy()
    uniformBuffer.destroy()
    for (const t of scratch) t.destroy()
  }
}

/** djb2 — key material sources so an edited project shader recompiles. */
function hashSource(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Point the raster cache at this island. Safe to call on machines with no
 * WebGPU: production declines per-request and twins take over.
 */
export function installMaterialIsland(): void {
  setMaterialProducer(produce)
}
