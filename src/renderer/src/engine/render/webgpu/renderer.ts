// WebGPU scene renderer (Sprint D, ADR-003). Same visual contract as
// render/canvas2d.ts drawScene; overlays stay Canvas2D on a stacked canvas.
//
// Architecture: the scene is BAKED once per scene version (+ zoom bucket,
// dpr, editing state) into world-space geometry arenas and an ordered
// segment list; per frame only a camera uniform changes, so panning a 100k
// shape document replays a handful of draw calls. Solid fills/strokes with
// normal blending collapse into large batches; gradients, images and text
// rasters draw individually from a 256-aligned uniform arena. Masks,
// rotated/rounded frame clips and INSIDE/OUTSIDE stroke aligns share one
// stencil stack (scissor fast-path for unrotated sharp frames).
//
// Beta gaps (documented in the matrix / porting plan): effects
// (shadows/blurs) and non-NORMAL blend modes are not yet composited — nodes
// draw their base geometry. The Canvas2D backend remains the default.

import type { NodeId, Paint, SceneNode } from '../../types'
import { isFrameLike } from '../../types'
import type { SceneGraph } from '../../scene'
import type { Mat } from '../../geometry'
import { IDENTITY, matMultiply } from '../../geometry'
import { layoutText } from '../../text'
import { rgbaToCss } from '../../color'
import type { AssetCache } from '../../assets'
import type { RenderOptions } from '../canvas2d'
import { drawTextInto } from '../canvas2d'
import { MeshCache, zoomBucket, type NodeMesh } from './meshcache'
import { GRADIENT_WGSL, SOLID_WGSL, STENCIL_WGSL, TEXTURE_WGSL } from './shaders'

const UNIFORM_ALIGN = 256
const GRADIENT_UNIFORM_SIZE = 224 // 6 vec4 + 8 color vec4 = 14 * 16
const TEXTURE_UNIFORM_SIZE = 64

interface ScissorRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type Segment =
  | { kind: 'batch'; firstIndex: number; indexCount: number }
  | { kind: 'stencil'; op: 'push' | 'pop'; firstIndex: number; indexCount: number }
  | { kind: 'scissor'; op: 'push' | 'pop'; rect?: ScissorRect }
  | { kind: 'setRef'; delta: number } // temporary stencil ref adjustment (stroke aligns)
  | {
      kind: 'gradient'
      uniformOffset: number
      firstVertex: number
      firstIndex: number
      indexCount: number
    }
  | {
      kind: 'texture'
      uniformOffset: number
      texKey: string
      firstVertex: number
      firstIndex: number
      indexCount: number
    }

class GrowBuffer {
  data: Float32Array
  u32: Uint32Array
  len = 0
  constructor(cap = 1 << 16) {
    this.data = new Float32Array(cap)
    this.u32 = new Uint32Array(this.data.buffer)
  }
  ensure(extraFloats: number): void {
    if (this.len + extraFloats <= this.data.length) return
    let cap = this.data.length
    while (cap < this.len + extraFloats) cap *= 2
    const next = new Float32Array(cap)
    next.set(this.data.subarray(0, this.len))
    this.data = next
    this.u32 = new Uint32Array(next.buffer)
  }
  reset(): void {
    this.len = 0
  }
}

class GrowIndexBuffer {
  data: Uint32Array
  len = 0
  constructor(cap = 1 << 16) {
    this.data = new Uint32Array(cap)
  }
  ensure(extra: number): void {
    if (this.len + extra <= this.data.length) return
    let cap = this.data.length
    while (cap < this.len + extra) cap *= 2
    const next = new Uint32Array(cap)
    next.set(this.data.subarray(0, this.len))
    this.data = next
  }
  reset(): void {
    this.len = 0
  }
}

function parseColor(css: string): [number, number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(css)
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s))
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts[3] ?? 1]
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(css)
  if (hex) {
    const v = parseInt(hex[1], 16)
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1]
  }
  return [0.12, 0.12, 0.12, 1]
}

export class WebGPURenderer {
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.gpu
  }

  static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer | null> {
    if (!WebGPURenderer.isSupported()) return null
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return null
    const device = await adapter.requestDevice()
    device.addEventListener('uncapturederror', (e) => {
      console.warn('[polyform] WebGPU error:', (e as GPUUncapturedErrorEvent).error.message)
    })
    const context = canvas.getContext('webgpu')
    if (!context) return null
    const renderer = new WebGPURenderer(canvas, device, context)
    renderer.adapterInfo = `${adapter.info?.vendor ?? '?'} ${adapter.info?.architecture ?? ''} ${adapter.info?.description ?? ''}`.trim()
    renderer.configure()
    return renderer
  }

  adapterInfo = ''

  private canvas: HTMLCanvasElement
  private device: GPUDevice
  private context: GPUCanvasContext
  private format: GPUTextureFormat

  private solidPipeline!: GPURenderPipeline
  private stencilPushPipeline!: GPURenderPipeline
  private stencilPopPipeline!: GPURenderPipeline
  private gradientPipeline!: GPURenderPipeline
  private texturePipeline!: GPURenderPipeline

  private cameraBuffer!: GPUBuffer
  private cameraBindGroup!: GPUBindGroup
  private gradientLayout!: GPUBindGroupLayout
  private textureLayout!: GPUBindGroupLayout
  private sampler!: GPUSampler

  private msaa: GPUTexture | null = null
  private depthStencil: GPUTexture | null = null
  private targetW = 0
  private targetH = 0

  // Bake state
  private meshCache = new MeshCache()
  private arena = new GrowBuffer() // interleaved: x, y (f32), color (unorm8x4 in 1 float slot)
  private arenaIndices = new GrowIndexBuffer()
  private localArena = new GrowBuffer() // pos-only local-space meshes for special draws
  private localIndices = new GrowIndexBuffer()
  private uniformData = new Uint8Array(UNIFORM_ALIGN * 256)
  private uniformLen = 0
  private segments: Segment[] = []
  private bakedKey = ''
  private invalidated = true

  private arenaGpu: GPUBuffer | null = null
  private arenaIndexGpu: GPUBuffer | null = null
  private localGpu: GPUBuffer | null = null
  private localIndexGpu: GPUBuffer | null = null
  private uniformGpu: GPUBuffer | null = null
  private gradientBindGroup: GPUBindGroup | null = null

  /** Textures by segment key ('img:<hash>' / 'txt:<key>'). */
  private textures = new Map<string, GPUTexture>()
  /** Bind groups resolved lazily at execute time against the CURRENT uniform buffer. */
  private textureBindGroups = new Map<string, GPUBindGroup>()

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, context: GPUCanvasContext) {
    this.canvas = canvas
    this.device = device
    this.context = context
    this.format = navigator.gpu.getPreferredCanvasFormat()
  }

  /** Force a re-bake (e.g. an image bitmap finished loading). */
  invalidate(): void {
    this.invalidated = true
  }

  /** Diagnostics: bakes performed since creation (perf harness). */
  bakeCount = 0
  /** Diagnostics: per-phase ms of the last render() call. */
  lastTimings = { texture: 0, encode: 0, submit: 0, begin: 0, loop: 0, end: 0, segments: 0, indices: 0 }

  dispose(): void {
    this.msaa?.destroy()
    this.depthStencil?.destroy()
    for (const t of this.textures.values()) t.destroy()
    this.arenaGpu?.destroy()
    this.arenaIndexGpu?.destroy()
    this.localGpu?.destroy()
    this.localIndexGpu?.destroy()
    this.uniformGpu?.destroy()
    this.device.destroy()
  }

  private configure(): void {
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    const device = this.device

    this.cameraBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const cameraLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    })
    this.cameraBindGroup = device.createBindGroup({
      layout: cameraLayout,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    })

    this.gradientLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
      ],
    })
    this.textureLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    })

    const premultiplied: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    }
    const stencilKeep = (compare: GPUCompareFunction, passOp: GPUStencilOperation) =>
      ({
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'always',
        stencilFront: { compare, passOp, failOp: 'keep', depthFailOp: 'keep' },
        stencilBack: { compare, passOp, failOp: 'keep', depthFailOp: 'keep' },
      }) satisfies GPUDepthStencilState

    const solidModule = device.createShaderModule({ code: SOLID_WGSL })
    this.solidPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [cameraLayout] }),
      vertex: {
        module: solidModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 12,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'unorm8x4' },
            ],
          },
        ],
      },
      fragment: {
        module: solidModule,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: premultiplied }],
      },
      multisample: { count: 4 },
      depthStencil: stencilKeep('equal', 'keep'),
    })

    const stencilModule = device.createShaderModule({ code: STENCIL_WGSL })
    const stencilPipeline = (passOp: GPUStencilOperation, compare: GPUCompareFunction) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [cameraLayout] }),
        vertex: {
          module: stencilModule,
          entryPoint: 'vs',
          buffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
            },
          ],
        },
        fragment: {
          module: stencilModule,
          entryPoint: 'fs',
          targets: [{ format: this.format, writeMask: 0 }],
        },
        multisample: { count: 4 },
        depthStencil: stencilKeep(compare, passOp),
      })
    this.stencilPushPipeline = stencilPipeline('increment-clamp', 'equal')
    this.stencilPopPipeline = stencilPipeline('decrement-clamp', 'equal')

    const gradientModule = device.createShaderModule({ code: GRADIENT_WGSL })
    this.gradientPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [cameraLayout, this.gradientLayout],
      }),
      vertex: {
        module: gradientModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
        ],
      },
      fragment: {
        module: gradientModule,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: premultiplied }],
      },
      multisample: { count: 4 },
      depthStencil: stencilKeep('equal', 'keep'),
    })

    const textureModule = device.createShaderModule({ code: TEXTURE_WGSL })
    this.texturePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [cameraLayout, this.textureLayout],
      }),
      vertex: {
        module: textureModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
        ],
      },
      fragment: {
        module: textureModule,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: premultiplied }],
      },
      multisample: { count: 4 },
      depthStencil: stencilKeep('equal', 'keep'),
    })
  }

  // -------------------------------------------------------------------------
  // Bake: scene -> arenas + segments
  // -------------------------------------------------------------------------

  private bakeOpts!: RenderOptions
  private bakeScene!: SceneGraph
  private currentBatchStart = -1

  private bake(scene: SceneGraph, opts: RenderOptions): void {
    this.bakeScene = scene
    this.bakeOpts = opts
    this.arena.reset()
    this.arenaIndices.reset()
    this.localArena.reset()
    this.localIndices.reset()
    this.uniformLen = 0
    this.segments = []
    this.currentBatchStart = -1
    this.meshCache.prune(scene)

    for (const id of scene.rootIds()) {
      this.bakeNode(id, IDENTITY, 1)
    }
    this.endBatch()
    this.uploadArenas()
  }

  private endBatch(): void {
    if (this.currentBatchStart >= 0 && this.arenaIndices.len > this.currentBatchStart) {
      this.segments.push({
        kind: 'batch',
        firstIndex: this.currentBatchStart,
        indexCount: this.arenaIndices.len - this.currentBatchStart,
      })
    }
    this.currentBatchStart = -1
  }

  private appendSolid(
    positions: Float32Array,
    indices: Uint32Array,
    m: Mat,
    color: [number, number, number, number],
  ): void {
    if (indices.length === 0) return
    if (this.currentBatchStart < 0) this.currentBatchStart = this.arenaIndices.len
    const vertCount = positions.length / 2
    const base = this.arena.len / 3
    this.arena.ensure(vertCount * 3)
    const a = color[3]
    const r = Math.round(Math.max(0, Math.min(1, color[0] * a)) * 255)
    const g = Math.round(Math.max(0, Math.min(1, color[1] * a)) * 255)
    const b = Math.round(Math.max(0, Math.min(1, color[2] * a)) * 255)
    const alpha = Math.round(Math.max(0, Math.min(1, a)) * 255)
    const packed = (r | (g << 8) | (b << 16) | (alpha << 24)) >>> 0
    const f32 = this.arena.data
    const u32 = this.arena.u32
    let w = this.arena.len
    for (let i = 0; i < vertCount; i++) {
      const x = positions[i * 2]
      const y = positions[i * 2 + 1]
      f32[w] = m.a * x + m.c * y + m.e
      f32[w + 1] = m.b * x + m.d * y + m.f
      u32[w + 2] = packed
      w += 3
    }
    this.arena.len = w
    this.arenaIndices.ensure(indices.length)
    const idx = this.arenaIndices.data
    let iw = this.arenaIndices.len
    for (let i = 0; i < indices.length; i++) idx[iw++] = indices[i] + base
    this.arenaIndices.len = iw
  }

  /** World-space stencil mesh (position-only rows in the solid arena). */
  private appendStencil(positions: Float32Array, indices: Uint32Array, m: Mat, op: 'push' | 'pop'): void {
    if (indices.length === 0) {
      // Degenerate clip: still push a zero-count segment to keep push/pop
      // pairing (nothing will draw inside anyway).
      this.segments.push({ kind: 'stencil', op, firstIndex: 0, indexCount: 0 })
      return
    }
    this.endBatch()
    const vertCount = positions.length / 2
    const base = this.arena.len / 3
    this.arena.ensure(vertCount * 3)
    const f32 = this.arena.data
    let w = this.arena.len
    for (let i = 0; i < vertCount; i++) {
      const x = positions[i * 2]
      const y = positions[i * 2 + 1]
      f32[w] = m.a * x + m.c * y + m.e
      f32[w + 1] = m.b * x + m.d * y + m.f
      f32[w + 2] = 0
      w += 3
    }
    this.arena.len = w
    this.arenaIndices.ensure(indices.length)
    const idx = this.arenaIndices.data
    const first = this.arenaIndices.len
    let iw = first
    for (let i = 0; i < indices.length; i++) idx[iw++] = indices[i] + base
    this.arenaIndices.len = iw
    this.segments.push({ kind: 'stencil', op, firstIndex: first, indexCount: indices.length })
  }

  private appendLocalMesh(positions: Float32Array, indices: Uint32Array): {
    firstVertex: number
    firstIndex: number
    indexCount: number
  } {
    const base = this.localArena.len / 2
    this.localArena.ensure(positions.length)
    this.localArena.data.set(positions, this.localArena.len)
    this.localArena.len += positions.length
    const first = this.localIndices.len
    this.localIndices.ensure(indices.length)
    const idx = this.localIndices.data
    let iw = first
    for (let i = 0; i < indices.length; i++) idx[iw++] = indices[i] + base
    this.localIndices.len = iw
    return { firstVertex: 0, firstIndex: first, indexCount: indices.length }
  }

  private allocUniform(size: number): number {
    const offset = this.uniformLen
    const padded = Math.ceil(size / UNIFORM_ALIGN) * UNIFORM_ALIGN
    if (offset + padded > this.uniformData.length) {
      const next = new Uint8Array(this.uniformData.length * 2)
      next.set(this.uniformData)
      this.uniformData = next
    }
    this.uniformLen = offset + padded
    return offset
  }

  private bakeGradient(
    node: SceneNode,
    paint: Extract<Paint, { type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' }>,
    mesh: { positions: Float32Array; indices: Uint32Array },
    m: Mat,
    opacity: number,
  ): void {
    if (mesh.indices.length === 0 || paint.stops.length === 0) return
    this.endBatch()
    const loc = this.appendLocalMesh(mesh.positions, mesh.indices)
    const offset = this.allocUniform(GRADIENT_UNIFORM_SIZE)
    const f = new Float32Array(this.uniformData.buffer, offset, GRADIENT_UNIFORM_SIZE / 4)
    const w = node.width
    const h = node.height
    f.set([m.a, m.b, m.c, m.d, m.e, m.f, w, h], 0)
    const sx = paint.start.x * w
    const sy = paint.start.y * h
    const ex = paint.end.x * w
    const ey = paint.end.y * h
    f.set([sx, sy, ex, ey], 8)
    const radial = paint.type === 'GRADIENT_RADIAL'
    const radius = Math.max(1e-3, Math.hypot(ex - sx, ey - sy))
    const stops = paint.stops.slice(0, 8)
    f.set([radial ? 1 : 0, stops.length, paint.opacity * opacity, radius], 12)
    for (let i = 0; i < 8; i++) {
      const idx = Math.min(i, stops.length - 1)
      const off = Math.max(0, Math.min(1, stops[idx]?.position ?? 0))
      if (i < 4) f[16 + i] = off
      else f[20 + i - 4] = off
    }
    for (let i = 0; i < 8; i++) {
      const s = stops[Math.min(i, stops.length - 1)]
      f.set([s.color.r, s.color.g, s.color.b, s.color.a], 24 + i * 4)
    }
    this.segments.push({ kind: 'gradient', uniformOffset: offset, ...loc })
  }

  /** Upload a texture for a segment key if not present. */
  private ensureTexture(key: string, source: ImageBitmap | OffscreenCanvas): void {
    if (this.textures.has(key)) return
    const texture = this.device.createTexture({
      size: [source.width, source.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture, premultipliedAlpha: true },
      [source.width, source.height],
    )
    this.textures.set(key, texture)
  }

  /** Bind group for a texture key, valid against the CURRENT uniform buffer. */
  private bindGroupFor(key: string): GPUBindGroup | null {
    const cached = this.textureBindGroups.get(key)
    if (cached) return cached
    const texture = this.textures.get(key)
    if (!texture || !this.uniformGpu) return null
    const bg = this.device.createBindGroup({
      layout: this.textureLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformGpu, size: TEXTURE_UNIFORM_SIZE } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: texture.createView() },
      ],
    })
    this.textureBindGroups.set(key, bg)
    return bg
  }

  private bakeImage(
    node: SceneNode,
    paint: Extract<Paint, { type: 'IMAGE' }>,
    mesh: { positions: Float32Array; indices: Uint32Array },
    m: Mat,
    opacity: number,
  ): void {
    const bitmap = this.bakeOpts.assets.getBitmap(paint.assetHash)
    if (!bitmap) {
      // Same placeholder the Canvas2D backend paints.
      this.appendSolid(mesh.positions, mesh.indices, m, [0.5, 0.5, 0.5, 0.35 * opacity])
      return
    }
    if (mesh.indices.length === 0) return
    this.endBatch()
    const texKey = `img:${paint.assetHash}`
    this.ensureTexture(texKey, bitmap)
    const loc = this.appendLocalMesh(mesh.positions, mesh.indices)
    const offset = this.allocUniform(TEXTURE_UNIFORM_SIZE)
    const f = new Float32Array(this.uniformData.buffer, offset, TEXTURE_UNIFORM_SIZE / 4)
    const w = node.width
    const h = node.height
    const iw = bitmap.width
    const ih = bitmap.height
    // Crop rect in source px (mirrors canvas2d).
    const crop = paint.crop
    let sx = 0
    let sy = 0
    let sw = iw
    let sh = ih
    if (crop && crop.w > 0.001 && crop.h > 0.001) {
      sx = Math.max(0, Math.min(1, crop.x)) * iw
      sy = Math.max(0, Math.min(1, crop.y)) * ih
      sw = Math.max(0.001, Math.min(1 - crop.x, crop.w)) * iw
      sh = Math.max(0.001, Math.min(1 - crop.y, crop.h)) * ih
    }
    let scaleX: number
    let scaleY: number
    let offX: number
    let offY: number
    let tile = 0
    if (paint.scaleMode === 'TILE') {
      // Natural-size repeat of the full image.
      scaleX = 1 / iw
      scaleY = 1 / ih
      offX = 0
      offY = 0
      tile = 1
    } else if (paint.scaleMode === 'STRETCH') {
      // local (0..w, 0..h) -> crop uv
      scaleX = sw / iw / w
      scaleY = sh / ih / h
      offX = sx / iw
      offY = sy / ih
    } else {
      const scale = paint.scaleMode === 'FILL' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh)
      const dw = sw * scale
      const dh = sh * scale
      const dx = (w - dw) / 2
      const dy = (h - dh) / 2
      scaleX = sw / iw / dw
      scaleY = sh / ih / dh
      offX = sx / iw - dx * scaleX
      offY = sy / ih - dy * scaleY
    }
    const adj = paint.adjust
    const clamp01 = (v: number) => Math.max(0, 1 + v)
    f.set([m.a, m.b, m.c, m.d, m.e, m.f, paint.opacity * opacity, 0], 0)
    f.set([scaleX, scaleY, offX, offY], 8)
    f.set(
      [clamp01(adj?.exposure ?? 0), clamp01(adj?.contrast ?? 0), clamp01(adj?.saturation ?? 0), tile],
      12,
    )
    this.segments.push({ kind: 'texture', uniformOffset: offset, texKey, ...loc })
  }

  private bakeText(node: Extract<SceneNode, { type: 'TEXT' }>, m: Mat, opacity: number): void {
    const paint = node.fills.find((f) => f.visible)
    if (!paint || node.width <= 0 || node.height <= 0) return
    const bucket = zoomBucket(this.bakeOpts.camera.zoom)
    const scale = Math.min(4, Math.max(1, bucket * this.bakeOpts.dpr))
    const layout = layoutText(node)
    const key = JSON.stringify([
      node.characters,
      layout.font,
      node.letterSpacing,
      node.textAlignH,
      node.textAlignV,
      node.width,
      node.height,
      scale,
      paint.type === 'SOLID' ? rgbaToCss(paint.color, paint.opacity) : paint.type,
    ])
    const texKey = `txt:${key}`
    if (!this.textures.has(texKey)) {
      const pw = Math.min(4096, Math.max(1, Math.ceil(node.width * scale)))
      const ph = Math.min(4096, Math.max(1, Math.ceil(node.height * scale)))
      const off = new OffscreenCanvas(pw, ph)
      const ctx = off.getContext('2d')!
      ctx.scale(scale, scale)
      drawTextInto(ctx as unknown as CanvasRenderingContext2D, node)
      this.ensureTexture(texKey, off)
    }
    this.endBatch()
    // Quad in local space.
    const quad = new Float32Array([0, 0, node.width, 0, node.width, node.height, 0, node.height])
    const quadIdx = new Uint32Array([0, 1, 2, 0, 2, 3])
    const loc = this.appendLocalMesh(quad, quadIdx)
    const offset = this.allocUniform(TEXTURE_UNIFORM_SIZE)
    const f = new Float32Array(this.uniformData.buffer, offset, TEXTURE_UNIFORM_SIZE / 4)
    f.set([m.a, m.b, m.c, m.d, m.e, m.f, opacity, 0], 0)
    f.set([1 / node.width, 1 / node.height, 0, 0], 8)
    f.set([1, 1, 1, 0], 12)
    this.segments.push({ kind: 'texture', uniformOffset: offset, texKey, ...loc })
  }

  private paintColor(paint: Extract<Paint, { type: 'SOLID' }>, opacity: number): [number, number, number, number] {
    return [
      paint.color.r,
      paint.color.g,
      paint.color.b,
      paint.color.a * paint.opacity * opacity,
    ]
  }

  private bakeFills(node: SceneNode, mesh: NodeMesh, m: Mat, opacity: number): void {
    for (const paint of node.fills) {
      if (!paint.visible) continue
      if (paint.type === 'SOLID') {
        this.appendSolid(mesh.fillPositions, mesh.fillIndices, m, this.paintColor(paint, opacity))
      } else if (paint.type === 'IMAGE') {
        this.bakeImage(node, paint, { positions: mesh.fillPositions, indices: mesh.fillIndices }, m, opacity)
      } else {
        this.bakeGradient(node, paint, { positions: mesh.fillPositions, indices: mesh.fillIndices }, m, opacity)
      }
    }
  }

  private bakeStrokes(node: SceneNode, mesh: NodeMesh, m: Mat, opacity: number): void {
    if (node.strokeWeight <= 0 || mesh.strokeIndices.length === 0) return
    if (!node.strokes.some((s) => s.visible && s.type !== 'IMAGE')) return
    const needsClip = mesh.strokeAlignCode !== 0 && mesh.fillIndices.length > 0
    if (needsClip) {
      // Push the fill region. Execute-side draws default to ref=stencilDepth
      // (i.e. INSIDE the fill). OUTSIDE strokes test the ring outside the
      // fill but inside outer clips: ref = depth - 1.
      this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'push')
      if (mesh.strokeAlignCode === 2) this.segments.push({ kind: 'setRef', delta: -1 })
    }
    for (const paint of node.strokes) {
      if (!paint.visible || paint.type === 'IMAGE') continue
      if (paint.type === 'SOLID') {
        this.appendSolid(mesh.strokePositions, mesh.strokeIndices, m, this.paintColor(paint, opacity))
      } else {
        this.bakeGradient(node, paint, { positions: mesh.strokePositions, indices: mesh.strokeIndices }, m, opacity)
      }
    }
    if (needsClip) {
      if (mesh.strokeAlignCode === 2) this.segments.push({ kind: 'setRef', delta: 1 })
      this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'pop')
    }
  }

  private bakeChildren(children: readonly NodeId[], parentMat: Mat, opacity: number): void {
    const scene = this.bakeScene
    let maskDepth = 0
    for (const cid of children) {
      const child = scene.getNode(cid)
      if (!child) continue
      if (child.isMask && child.visible) {
        const m = matMultiply(parentMat, scene.localMatrix(child))
        const mesh = this.meshCache.get(scene, child, this.bakeOpts.camera.zoom, true, false)
        this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'push')
        maskDepth++
        continue
      }
      this.bakeNode(cid, parentMat, opacity)
    }
    while (maskDepth-- > 0) {
      // Pop reuses its paired push's mesh range (resolved at execute time).
      this.endBatch()
      this.segments.push({ kind: 'stencil', op: 'pop', firstIndex: -1, indexCount: -1 })
    }
  }

  private bakeNode(id: NodeId, parentMat: Mat, parentOpacity: number): void {
    const scene = this.bakeScene
    const node = scene.getNode(id)
    if (!node || !node.visible || node.opacity <= 0) return
    const m = matMultiply(parentMat, scene.localMatrix(node))
    const opacity = parentOpacity * node.opacity
    const zoom = this.bakeOpts.camera.zoom

    switch (node.type) {
      case 'FRAME':
      case 'COMPONENT':
      case 'INSTANCE': {
        const wantStroke = node.strokes.some((s) => s.visible && s.type !== 'IMAGE')
        const mesh = this.meshCache.get(scene, node, zoom, true, wantStroke)
        this.bakeFills(node, mesh, m, opacity)
        if (node.clipsContent) {
          const r = node.cornerRadius
          const axisAligned = Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && m.a > 0 && m.d > 0
          const sharp = r.tl === 0 && r.tr === 0 && r.br === 0 && r.bl === 0
          if (axisAligned && sharp) {
            this.endBatch()
            this.segments.push({
              kind: 'scissor',
              op: 'push',
              rect: {
                minX: m.e,
                minY: m.f,
                maxX: m.e + node.width * m.a,
                maxY: m.f + node.height * m.d,
              },
            })
            this.bakeChildren(node.children, m, opacity)
            this.endBatch()
            this.segments.push({ kind: 'scissor', op: 'pop' })
          } else {
            this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'push')
            this.bakeChildren(node.children, m, opacity)
            this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'pop')
          }
        } else {
          this.bakeChildren(node.children, m, opacity)
        }
        this.bakeStrokes(node, mesh, m, opacity)
        break
      }
      case 'GROUP':
        this.bakeChildren(node.children, m, opacity)
        break
      case 'TEXT':
        if (this.bakeOpts.editingTextId !== node.id) this.bakeText(node, m, opacity)
        break
      default: {
        // RECTANGLE / ELLIPSE / LINE / POLYGON / STAR / VECTOR / BOOLEAN
        const wantStroke = node.strokes.some((s) => s.visible && s.type !== 'IMAGE')
        const mesh = this.meshCache.get(scene, node, zoom, true, wantStroke)
        this.bakeFills(node, mesh, m, opacity)
        this.bakeStrokes(node, mesh, m, opacity)
        break
      }
    }
  }

  private uploadArenas(): void {
    const device = this.device
    const need = (buf: GPUBuffer | null, bytes: number) => !buf || buf.size < bytes
    const arenaBytes = Math.max(16, this.arena.len * 4)
    if (need(this.arenaGpu, arenaBytes)) {
      this.arenaGpu?.destroy()
      this.arenaGpu = device.createBuffer({
        size: Math.ceil((arenaBytes * 1.5) / 16) * 16,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(this.arenaGpu!, 0, this.arena.data.buffer, 0, this.arena.len * 4)

    const idxBytes = Math.max(16, this.arenaIndices.len * 4)
    if (need(this.arenaIndexGpu, idxBytes)) {
      this.arenaIndexGpu?.destroy()
      this.arenaIndexGpu = device.createBuffer({
        size: Math.ceil((idxBytes * 1.5) / 16) * 16,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(this.arenaIndexGpu!, 0, this.arenaIndices.data.buffer, 0, this.arenaIndices.len * 4)

    const localBytes = Math.max(16, this.localArena.len * 4)
    if (need(this.localGpu, localBytes)) {
      this.localGpu?.destroy()
      this.localGpu = device.createBuffer({
        size: Math.ceil((localBytes * 1.5) / 16) * 16,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(this.localGpu!, 0, this.localArena.data.buffer, 0, this.localArena.len * 4)

    const localIdxBytes = Math.max(16, this.localIndices.len * 4)
    if (need(this.localIndexGpu, localIdxBytes)) {
      this.localIndexGpu?.destroy()
      this.localIndexGpu = device.createBuffer({
        size: Math.ceil((localIdxBytes * 1.5) / 16) * 16,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(this.localIndexGpu!, 0, this.localIndices.data.buffer, 0, this.localIndices.len * 4)

    if (!this.uniformGpu || this.uniformGpu.size < this.uniformData.length) {
      // Recreating the buffer invalidates every bind group that referenced it.
      this.uniformGpu?.destroy()
      this.uniformGpu = device.createBuffer({
        size: this.uniformData.length,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.textureBindGroups.clear()
      this.gradientBindGroup = null
    }
    if (this.uniformLen > 0) {
      device.queue.writeBuffer(this.uniformGpu, 0, this.uniformData.buffer, 0, this.uniformLen)
    }
    if (!this.gradientBindGroup) {
      this.gradientBindGroup = device.createBindGroup({
        layout: this.gradientLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformGpu, size: GRADIENT_UNIFORM_SIZE } },
        ],
      })
    }
  }

  // -------------------------------------------------------------------------
  // Frame execution
  // -------------------------------------------------------------------------

  private ensureTargets(w: number, h: number): void {
    if (this.targetW === w && this.targetH === h && this.msaa && this.depthStencil) return
    this.msaa?.destroy()
    this.depthStencil?.destroy()
    this.msaa = this.device.createTexture({
      size: [w, h],
      sampleCount: 4,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.depthStencil = this.device.createTexture({
      size: [w, h],
      sampleCount: 4,
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.targetW = w
    this.targetH = h
  }

  render(scene: SceneGraph, opts: RenderOptions): void {
    const dw = Math.max(1, Math.round(opts.width * opts.dpr))
    const dh = Math.max(1, Math.round(opts.height * opts.dpr))
    if (this.canvas.width !== dw || this.canvas.height !== dh) {
      this.canvas.width = dw
      this.canvas.height = dh
    }
    this.ensureTargets(dw, dh)

    const bakeKey = JSON.stringify([
      scene.version,
      zoomBucket(opts.camera.zoom),
      opts.dpr,
      opts.editingTextId ?? null,
    ])
    if (this.invalidated || bakeKey !== this.bakedKey) {
      this.bake(scene, opts)
      this.bakedKey = bakeKey
      this.invalidated = false
      this.bakeCount++
    }

    // Camera uniform.
    const cam = new Float32Array(8)
    cam.set([opts.camera.x, opts.camera.y, opts.camera.zoom * opts.dpr, 0, dw, dh, 0, 0])
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cam)

    const bg = parseColor(opts.background ?? '#1e1e1e')
    const tTex = performance.now()
    const currentTexture = this.context.getCurrentTexture()
    this.lastTimings.texture = performance.now() - tTex
    const tEnc = performance.now()
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.msaa!.createView(),
          resolveTarget: currentTexture.createView(),
          clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: {
        view: this.depthStencil!.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        depthClearValue: 1,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
        stencilClearValue: 0,
      },
    })
    this.lastTimings.begin = performance.now() - tEnc
    const tLoop = performance.now()
    pass.setBindGroup(0, this.cameraBindGroup)

    // Execute segments.
    const scissors: ScissorRect[] = []
    const stencilPops: Segment[] = [] // stack of push segments for '-1' pops
    let stencilDepth = 0
    let refDelta = 0
    const zoomDpr = opts.camera.zoom * opts.dpr

    const applyScissor = () => {
      let x0 = 0
      let y0 = 0
      let x1 = dw
      let y1 = dh
      for (const r of scissors) {
        x0 = Math.max(x0, (r.minX - opts.camera.x) * zoomDpr)
        y0 = Math.max(y0, (r.minY - opts.camera.y) * zoomDpr)
        x1 = Math.min(x1, (r.maxX - opts.camera.x) * zoomDpr)
        y1 = Math.min(y1, (r.maxY - opts.camera.y) * zoomDpr)
      }
      const x = Math.max(0, Math.min(dw, Math.floor(x0)))
      const y = Math.max(0, Math.min(dh, Math.floor(y0)))
      const wpx = Math.max(0, Math.min(dw - x, Math.ceil(x1) - x))
      const hpx = Math.max(0, Math.min(dh - y, Math.ceil(y1) - y))
      pass.setScissorRect(x, y, wpx, hpx)
    }
    applyScissor()

    for (const seg of this.segments) {
      switch (seg.kind) {
        case 'batch': {
          pass.setPipeline(this.solidPipeline)
          pass.setStencilReference(stencilDepth + refDelta)
          pass.setVertexBuffer(0, this.arenaGpu!)
          pass.setIndexBuffer(this.arenaIndexGpu!, 'uint32')
          pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
          break
        }
        case 'setRef': {
          refDelta += seg.delta
          break
        }
        case 'stencil': {
          if (seg.op === 'push') {
            pass.setPipeline(this.stencilPushPipeline)
            pass.setStencilReference(stencilDepth)
            pass.setVertexBuffer(0, this.arenaGpu!)
            pass.setIndexBuffer(this.arenaIndexGpu!, 'uint32')
            if (seg.indexCount > 0) pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
            stencilPops.push(seg)
            stencilDepth++
          } else {
            const pushSeg = stencilPops.pop()
            stencilDepth--
            const first = seg.firstIndex >= 0 ? seg.firstIndex : (pushSeg as { firstIndex: number })?.firstIndex ?? 0
            const count = seg.indexCount >= 0 ? seg.indexCount : (pushSeg as { indexCount: number })?.indexCount ?? 0
            pass.setPipeline(this.stencilPopPipeline)
            pass.setStencilReference(stencilDepth + 1)
            pass.setVertexBuffer(0, this.arenaGpu!)
            pass.setIndexBuffer(this.arenaIndexGpu!, 'uint32')
            if (count > 0) pass.drawIndexed(count, 1, first)
          }
          break
        }
        case 'scissor': {
          if (seg.op === 'push') scissors.push(seg.rect!)
          else scissors.pop()
          applyScissor()
          break
        }
        case 'gradient': {
          pass.setPipeline(this.gradientPipeline)
          pass.setStencilReference(stencilDepth + refDelta)
          pass.setBindGroup(1, this.gradientBindGroup!, [seg.uniformOffset])
          pass.setVertexBuffer(0, this.localGpu!)
          pass.setIndexBuffer(this.localIndexGpu!, 'uint32')
          pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
          break
        }
        case 'texture': {
          const bg = this.bindGroupFor(seg.texKey)
          if (!bg) break
          pass.setPipeline(this.texturePipeline)
          pass.setStencilReference(stencilDepth + refDelta)
          pass.setBindGroup(1, bg, [seg.uniformOffset])
          pass.setVertexBuffer(0, this.localGpu!)
          pass.setIndexBuffer(this.localIndexGpu!, 'uint32')
          pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
          break
        }
      }
    }
    this.lastTimings.loop = performance.now() - tLoop
    const tEnd = performance.now()
    pass.end()
    this.lastTimings.end = performance.now() - tEnd
    this.lastTimings.segments = this.segments.length
    this.lastTimings.indices = this.arenaIndices.len
    this.lastTimings.encode = performance.now() - tEnc
    const tSub = performance.now()
    this.device.queue.submit([encoder.finish()])
    this.lastTimings.submit = performance.now() - tSub
  }

  /**
   * Read the current canvas texture back as RGBA bytes (render-parity
   * harness). Must be called in the same task as render().
   */
  async readback(): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
    const texture = this.context.getCurrentTexture()
    const w = texture.width
    const h = texture.height
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256
    const buffer = this.device.createBuffer({
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = this.device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [w, h])
    this.device.queue.submit([encoder.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    const raw = new Uint8Array(buffer.getMappedRange())
    const out = new Uint8ClampedArray(w * h * 4)
    const bgra = this.format === 'bgra8unorm'
    for (let y = 0; y < h; y++) {
      const src = y * bytesPerRow
      const dst = y * w * 4
      for (let x = 0; x < w; x++) {
        const s = src + x * 4
        const d = dst + x * 4
        if (bgra) {
          out[d] = raw[s + 2]
          out[d + 1] = raw[s + 1]
          out[d + 2] = raw[s]
        } else {
          out[d] = raw[s]
          out[d + 1] = raw[s + 1]
          out[d + 2] = raw[s + 2]
        }
        out[d + 3] = raw[s + 3]
      }
    }
    buffer.unmap()
    buffer.destroy()
    return { data: out, width: w, height: h }
  }
}
