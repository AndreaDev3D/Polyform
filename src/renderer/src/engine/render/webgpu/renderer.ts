// WebGPU scene renderer (Sprint D + effects compositor, ADR-016/017). Same
// visual contract as render/canvas2d.ts drawScene; overlays stay Canvas2D on
// a stacked canvas.
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
// Effects & blends (ADR-017): drop/inner shadows, layer blurs and isolated
// exotic blends pre-render at BAKE time into world-anchored per-node
// textures (the node's segment range replayed with a layer-local camera,
// then separable-gaussian blur passes), composited in the scene pass as
// world quads — panning stays a pure camera-uniform update. The scene pass
// resolves into an intermediate texture and blits to the canvas at frame
// end; background blur and exotic blend modes split the scene pass to
// sample the backdrop-so-far. MULTIPLY and SCREEN are exact fixed-function
// blend variants (per-primitive + inherited, mirroring Canvas2D); the other
// thirteen modes route through layer isolation + a backdrop-sampling
// composite shader implementing the W3C formulas.
//
// Documented divergences from the Canvas2D reference (all container-only):
// layer blur / exotic blends isolate the subtree and composite ONCE
// (Figma-style) where Canvas2D filters each primitive; effect composites
// always draw source-over even under an inherited MULTIPLY/SCREEN; backdrop
// effects inside an isolated layer fall back (bg blur skipped, exotic blend
// renders NORMAL).

import type { NodeId, Paint, SceneNode, BlendMode, DropShadowEffect, Model3dNode } from '../../types'
import { fillPaintBox, paintPoint, strokePaintBox, type PaintBox } from '../../paintbox'
import { isFrameLike } from '../../types'
import {
  getSnapshot,
  getStaleSnapshot,
  requestSnapshot,
  snapshotError,
  snapshotSpec,
} from '../../../render3d/snapshots'
import type { SceneGraph } from '../../scene'
import type { Mat, AABB } from '../../geometry'
import { IDENTITY, matMultiply } from '../../geometry'
import { layoutText } from '../../text'
import { rgbaToCss } from '../../color'
import type { RenderOptions } from '../canvas2d'
import { drawTextInto } from '../canvas2d'
import { MeshCache, zoomBucket, type NodeMesh } from './meshcache'
import { GlyphAtlas } from './glyphatlas'
import {
  BLUR_WGSL,
  COMPOSITE_WGSL,
  FX_WGSL,
  GLYPH_WGSL,
  GRADIENT_WGSL,
  SOLID_WGSL,
  STENCIL_WGSL,
  TEXTURE_WGSL,
} from './shaders'

const UNIFORM_ALIGN = 256
const GRADIENT_UNIFORM_SIZE = 224 // 6 vec4 + 8 color vec4 = 14 * 16
const TEXTURE_UNIFORM_SIZE = 64
const FX_UNIFORM_SIZE = 64
const BLUR_UNIFORM_SIZE = 48
const MAX_LAYER_TEX = 2048

/** Fixed-function blend variants (exact against the opaque scene target). */
const FIXED_BLEND: Partial<Record<BlendMode, number>> = {
  NORMAL: 0,
  MULTIPLY: 1,
  SCREEN: 2,
}

/** Shader-composited blend modes (ids match FX_WGSL blend_rgb). */
const FX_BLEND_MODE: Partial<Record<BlendMode, number>> = {
  OVERLAY: 2,
  DARKEN: 3,
  LIGHTEN: 4,
  COLOR_DODGE: 5,
  COLOR_BURN: 6,
  HARD_LIGHT: 7,
  SOFT_LIGHT: 8,
  DIFFERENCE: 9,
  EXCLUSION: 10,
  HUE: 11,
  SATURATION: 12,
  COLOR: 13,
  LUMINOSITY: 14,
}

interface ScissorRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type Segment =
  | { kind: 'batch'; blend: number; firstIndex: number; indexCount: number }
  | { kind: 'glyphs'; blend: number; firstIndex: number; indexCount: number }
  | { kind: 'stencil'; op: 'push' | 'pop'; firstIndex: number; indexCount: number }
  | { kind: 'scissor'; op: 'push' | 'pop'; rect?: ScissorRect }
  | { kind: 'setRef'; delta: number } // temporary stencil ref adjustment (stroke aligns)
  | { kind: 'skip'; to: number } // scene pass jumps over isolated/caster-only content
  | {
      kind: 'gradient'
      blend: number
      uniformOffset: number
      firstVertex: number
      firstIndex: number
      indexCount: number
    }
  | {
      kind: 'texture'
      blend: number
      uniformOffset: number
      texKey: string
      firstVertex: number
      firstIndex: number
      indexCount: number
    }
  | {
      kind: 'fxQuad'
      mode: number // 0 plain, 1 backdrop blur, >=2 blend modes (FX_WGSL)
      layerKey: string | null
      uniformOffset: number
      fallbackUniformOffset: number // mode-0 twin for replay contexts (-1: none)
      needsBackdrop: boolean
      radiusWorld: number // background blur radius in world units
      firstVertex: number
      firstIndex: number
      indexCount: number
    }

/** A pre-rendered effect layer: replay range + world->texture mapping. */
interface FxLayerSpec {
  key: string
  segStart: number
  segEnd: number
  originX: number
  originY: number
  scale: number // texture px per world unit
  texW: number
  texH: number
  blurRadiusPx: number
  sampleOffX: number
  sampleOffY: number
  tint: [number, number, number, number] | null // premultiplied shadow color
  invert: boolean // blur (1 - alpha): inner shadows
  mask: boolean // multiply result by the unblurred caster alpha
}

interface ExecCtx {
  dw: number
  dh: number
  camX: number
  camY: number
  zoomDpr: number
  scissors: ScissorRect[]
  stencilPops: Segment[]
  stencilDepth: number
  refDelta: number
  replay: boolean
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

  private solidPipelines!: GPURenderPipeline[]
  private stencilPushPipeline!: GPURenderPipeline
  private stencilPopPipeline!: GPURenderPipeline
  private gradientPipelines!: GPURenderPipeline[]
  private texturePipelines!: GPURenderPipeline[]
  private glyphPipelines!: GPURenderPipeline[]
  private fxPipeline!: GPURenderPipeline
  private blurPipeline!: GPURenderPipeline
  private blitPipeline!: GPURenderPipeline
  private glyphLayout!: GPUBindGroupLayout

  private cameraLayout!: GPUBindGroupLayout
  private cameraBuffer!: GPUBuffer
  private cameraBindGroup!: GPUBindGroup
  private gradientLayout!: GPUBindGroupLayout
  private textureLayout!: GPUBindGroupLayout
  private fxLayout!: GPUBindGroupLayout
  private blurLayout!: GPUBindGroupLayout
  private blitLayout!: GPUBindGroupLayout
  private sampler!: GPUSampler
  private blitUniform!: GPUBuffer
  private dummyTex!: GPUTexture

  private msaa: GPUTexture | null = null
  private depthStencil: GPUTexture | null = null
  private resolveTex: GPUTexture | null = null
  private backdropTex: GPUTexture | null = null
  private pingA: GPUTexture | null = null
  private pingB: GPUTexture | null = null
  private blitBindGroup: GPUBindGroup | null = null
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
  private hasBackdropFx = false

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
  /** Last snapshot uploaded per MODEL3D node, to detect pose changes. */
  private model3dBitmaps = new Map<string, ImageBitmap>()

  // Shaped text (Sprint E): glyph quads from the shared atlas
  private glyphArena = new GrowBuffer() // interleaved: x, y, u, v, color
  private glyphIndices = new GrowIndexBuffer()
  private glyphGpu: GPUBuffer | null = null
  private glyphIndexGpu: GPUBuffer | null = null
  private atlas = new GlyphAtlas()
  private atlasTexture: GPUTexture | null = null
  private atlasBindGroup: GPUBindGroup | null = null
  /** Session fallback to per-node rasters after repeated atlas overflow. */
  private glyphFallback = false

  // Effect layers (rebuilt each bake)
  private fxLayers: FxLayerSpec[] = []
  private fxKeyCounter = 0
  private fxTextures = new Map<string, GPUTexture>()
  private fxBindGroups = new Map<string, GPUBindGroup>()
  /** Per background-blur segment: per-frame blur uniforms + bind groups. */
  private frameFx = new Map<number, { uH: GPUBuffer; uV: GPUBuffer }>()
  private frameFxBindGroups = new Map<number, { h: GPUBindGroup; v: GPUBindGroup }>()

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
    this.resolveTex?.destroy()
    this.backdropTex?.destroy()
    this.pingA?.destroy()
    this.pingB?.destroy()
    this.dummyTex?.destroy()
    for (const t of this.textures.values()) t.destroy()
    for (const t of this.fxTextures.values()) t.destroy()
    for (const f of this.frameFx.values()) {
      f.uH.destroy()
      f.uV.destroy()
    }
    this.arenaGpu?.destroy()
    this.arenaIndexGpu?.destroy()
    this.localGpu?.destroy()
    this.localIndexGpu?.destroy()
    this.glyphGpu?.destroy()
    this.glyphIndexGpu?.destroy()
    this.atlasTexture?.destroy()
    this.uniformGpu?.destroy()
    this.blitUniform?.destroy()
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
    this.cameraLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    })
    this.cameraBindGroup = device.createBindGroup({
      layout: this.cameraLayout,
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
    this.fxLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.blurLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.blitLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    })
    this.blitUniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(this.blitUniform, 0, new Float32Array([0, 0, 1, 0]))
    this.dummyTex = device.createTexture({
      size: [1, 1],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    })

    // Fixed-function blend variants against the opaque scene target:
    // 0 = premultiplied source-over, 1 = MULTIPLY, 2 = SCREEN.
    const blendStates: GPUBlendState[] = [
      {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
      {
        color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
      {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    ]
    const stencilKeep = (compare: GPUCompareFunction, passOp: GPUStencilOperation) =>
      ({
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'always',
        stencilFront: { compare, passOp, failOp: 'keep', depthFailOp: 'keep' },
        stencilBack: { compare, passOp, failOp: 'keep', depthFailOp: 'keep' },
      }) satisfies GPUDepthStencilState

    const solidModule = device.createShaderModule({ code: SOLID_WGSL })
    this.solidPipelines = blendStates.map((blend) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.cameraLayout] }),
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
          targets: [{ format: this.format, blend }],
        },
        multisample: { count: 4 },
        depthStencil: stencilKeep('equal', 'keep'),
      }),
    )

    const stencilModule = device.createShaderModule({ code: STENCIL_WGSL })
    const stencilPipeline = (passOp: GPUStencilOperation, compare: GPUCompareFunction) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.cameraLayout] }),
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
    this.gradientPipelines = blendStates.map((blend) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this.cameraLayout, this.gradientLayout],
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
          targets: [{ format: this.format, blend }],
        },
        multisample: { count: 4 },
        depthStencil: stencilKeep('equal', 'keep'),
      }),
    )

    const textureModule = device.createShaderModule({ code: TEXTURE_WGSL })
    this.texturePipelines = blendStates.map((blend) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this.cameraLayout, this.textureLayout],
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
          targets: [{ format: this.format, blend }],
        },
        multisample: { count: 4 },
        depthStencil: stencilKeep('equal', 'keep'),
      }),
    )

    this.glyphLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    const glyphModule = device.createShaderModule({ code: GLYPH_WGSL })
    this.glyphPipelines = blendStates.map((blend) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this.cameraLayout, this.glyphLayout],
        }),
        vertex: {
          module: glyphModule,
          entryPoint: 'vs',
          buffers: [
            {
              arrayStride: 20,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x2' },
                { shaderLocation: 2, offset: 16, format: 'unorm8x4' },
              ],
            },
          ],
        },
        fragment: {
          module: glyphModule,
          entryPoint: 'fs',
          targets: [{ format: this.format, blend }],
        },
        multisample: { count: 4 },
        depthStencil: stencilKeep('equal', 'keep'),
      }),
    )

    const fxModule = device.createShaderModule({ code: FX_WGSL })
    this.fxPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.cameraLayout, this.fxLayout],
      }),
      vertex: {
        module: fxModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
        ],
      },
      fragment: {
        module: fxModule,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendStates[0] }],
      },
      multisample: { count: 4 },
      depthStencil: stencilKeep('equal', 'keep'),
    })

    const blurModule = device.createShaderModule({ code: BLUR_WGSL })
    this.blurPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blurLayout] }),
      vertex: { module: blurModule, entryPoint: 'vs' },
      fragment: {
        module: blurModule,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
    })

    const blitModule = device.createShaderModule({ code: COMPOSITE_WGSL })
    this.blitPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitLayout] }),
      vertex: { module: blitModule, entryPoint: 'vs' },
      fragment: {
        module: blitModule,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
    })
  }

  // -------------------------------------------------------------------------
  // Bake: scene -> arenas + segments (+ effect layer specs)
  // -------------------------------------------------------------------------

  private bakeOpts!: RenderOptions
  private bakeScene!: SceneGraph
  private currentBatchStart = -1
  private currentBatchBlend = 0
  private currentGlyphStart = -1
  private currentGlyphBlend = 0

  private bake(scene: SceneGraph, opts: RenderOptions): void {
    this.bakeScene = scene
    this.bakeOpts = opts
    this.meshCache.prune(scene)

    // An atlas overflow mid-bake invalidates uv refs baked before the clear
    // — rebuild once against the freshly cleared atlas; if even that
    // overflows, fall back to per-node text rasters for the session.
    for (let attempt = 0; ; attempt++) {
      this.arena.reset()
      this.arenaIndices.reset()
      this.localArena.reset()
      this.localIndices.reset()
      this.glyphArena.reset()
      this.glyphIndices.reset()
      this.uniformLen = 0
      this.segments = []
      this.currentBatchStart = -1
      this.currentBatchBlend = 0
      this.currentGlyphStart = -1
      this.currentGlyphBlend = 0
      this.fxLayers = []
      this.fxKeyCounter = 0
      this.atlas.beginBake()

      // Through bakeChildren, not a bare loop over the roots: masks are a
      // property of a SIBLING LIST, and this list is a sibling list like any
      // other. Baking each root directly meant `isMask` was honoured inside every
      // container and ignored at the top level of a page — so a mask applied to a
      // top-level layer did nothing on the GPU while Canvas2D clipped correctly
      // (`drawScene` has always routed the page's roots through `drawChildren`).
      // Found by a parity fixture, which is what parity fixtures are for.
      this.bakeChildren(scene.rootIds(), IDENTITY, 1, 0, false)
      this.endBatch()
      if (!this.atlas.clearedDuringBake || attempt >= 2) break
      if (attempt === 1) this.glyphFallback = true
    }
    this.hasBackdropFx = this.segments.some((s) => s.kind === 'fxQuad' && s.needsBackdrop)
    this.uploadArenas()
    this.uploadAtlas()
    this.preRenderFxLayers()
  }

  private endSolidBatch(): void {
    if (this.currentBatchStart >= 0 && this.arenaIndices.len > this.currentBatchStart) {
      this.segments.push({
        kind: 'batch',
        blend: this.currentBatchBlend,
        firstIndex: this.currentBatchStart,
        indexCount: this.arenaIndices.len - this.currentBatchStart,
      })
    }
    this.currentBatchStart = -1
  }

  private endGlyphBatch(): void {
    if (this.currentGlyphStart >= 0 && this.glyphIndices.len > this.currentGlyphStart) {
      this.segments.push({
        kind: 'glyphs',
        blend: this.currentGlyphBlend,
        firstIndex: this.currentGlyphStart,
        indexCount: this.glyphIndices.len - this.currentGlyphStart,
      })
    }
    this.currentGlyphStart = -1
  }

  private endBatch(): void {
    this.endSolidBatch()
    this.endGlyphBatch()
  }

  private appendSolid(
    positions: Float32Array,
    indices: Uint32Array,
    m: Mat,
    color: [number, number, number, number],
    blend: number,
  ): void {
    if (indices.length === 0) return
    if (this.currentGlyphStart >= 0) this.endGlyphBatch()
    if (this.currentBatchStart >= 0 && this.currentBatchBlend !== blend) this.endSolidBatch()
    if (this.currentBatchStart < 0) {
      this.currentBatchStart = this.arenaIndices.len
      this.currentBatchBlend = blend
    }
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

  /**
   * @param box Where the paint's unit coordinates land. The node's own box for a
   *   fill; the box the STROKE covers for a stroke, because a LINE has height 0 and
   *   a gradient mapped through that has a zero-length axis — the shader then has
   *   nothing to project onto and the stroke vanishes. Same rule as Canvas2D, from
   *   the same module, so the two backends stay pixel-comparable (ADR-016).
   */
  private bakeGradient(
    node: SceneNode,
    paint: Extract<Paint, { type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' }>,
    mesh: { positions: Float32Array; indices: Uint32Array },
    m: Mat,
    opacity: number,
    blend: number,
    box: PaintBox,
  ): void {
    if (mesh.indices.length === 0 || paint.stops.length === 0) return
    this.endBatch()
    const loc = this.appendLocalMesh(mesh.positions, mesh.indices)
    const offset = this.allocUniform(GRADIENT_UNIFORM_SIZE)
    const f = new Float32Array(this.uniformData.buffer, offset, GRADIENT_UNIFORM_SIZE / 4)
    f.set([m.a, m.b, m.c, m.d, m.e, m.f, box.w, box.h], 0)
    const from = paintPoint(box, paint.start)
    const to = paintPoint(box, paint.end)
    const sx = from.x
    const sy = from.y
    const ex = to.x
    const ey = to.y
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
    this.segments.push({ kind: 'gradient', blend, uniformOffset: offset, ...loc })
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
    blend: number,
  ): void {
    const bitmap = this.bakeOpts.assets.getBitmap(paint.assetHash)
    if (!bitmap) {
      // Same placeholder the Canvas2D backend paints.
      this.appendSolid(mesh.positions, mesh.indices, m, [0.5, 0.5, 0.5, 0.35 * opacity], blend)
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
    this.segments.push({ kind: 'texture', blend, uniformOffset: offset, texKey, ...loc })
  }

  /** Glyph quads (world-transformed) into the shared batched glyph arena. */
  private appendGlyphQuads(
    quads: number[], // [x0, y0, x1, y1, u0, v0, u1, v1] * n, node-local
    m: Mat,
    color: [number, number, number, number],
    blend: number,
  ): void {
    if (quads.length === 0) return
    if (this.currentBatchStart >= 0) this.endSolidBatch()
    if (this.currentGlyphStart >= 0 && this.currentGlyphBlend !== blend) this.endGlyphBatch()
    if (this.currentGlyphStart < 0) {
      this.currentGlyphStart = this.glyphIndices.len
      this.currentGlyphBlend = blend
    }
    const a = color[3]
    const r = Math.round(Math.max(0, Math.min(1, color[0] * a)) * 255)
    const g = Math.round(Math.max(0, Math.min(1, color[1] * a)) * 255)
    const b = Math.round(Math.max(0, Math.min(1, color[2] * a)) * 255)
    const alpha = Math.round(Math.max(0, Math.min(1, a)) * 255)
    const packed = (r | (g << 8) | (b << 16) | (alpha << 24)) >>> 0
    const quadCount = quads.length / 8
    this.glyphArena.ensure(quadCount * 4 * 5)
    this.glyphIndices.ensure(quadCount * 6)
    const f32 = this.glyphArena.data
    const u32 = this.glyphArena.u32
    const idx = this.glyphIndices.data
    let w = this.glyphArena.len
    let iw = this.glyphIndices.len
    for (let q = 0; q < quadCount; q++) {
      const o = q * 8
      const x0 = quads[o]
      const y0 = quads[o + 1]
      const x1 = quads[o + 2]
      const y1 = quads[o + 3]
      const base = w / 5
      const corners = [
        [x0, y0, quads[o + 4], quads[o + 5]],
        [x1, y0, quads[o + 6], quads[o + 5]],
        [x1, y1, quads[o + 6], quads[o + 7]],
        [x0, y1, quads[o + 4], quads[o + 7]],
      ]
      for (const [x, y, u, v] of corners) {
        f32[w] = m.a * x + m.c * y + m.e
        f32[w + 1] = m.b * x + m.d * y + m.f
        f32[w + 2] = u
        f32[w + 3] = v
        u32[w + 4] = packed
        w += 5
      }
      idx[iw++] = base
      idx[iw++] = base + 1
      idx[iw++] = base + 2
      idx[iw++] = base
      idx[iw++] = base + 2
      idx[iw++] = base + 3
    }
    this.glyphArena.len = w
    this.glyphIndices.len = iw
  }

  private bakeText(node: Extract<SceneNode, { type: 'TEXT' }>, m: Mat, opacity: number, blend: number): void {
    const paint = node.fills.find((f) => f.visible)
    if (!paint || node.width <= 0 || node.height <= 0) return

    // Shaped path (Sprint E): batched atlas quads. SOLID fills only —
    // gradient/image text keeps the raster path (documented).
    if (!this.glyphFallback && paint.type === 'SOLID') {
      const layout = layoutText(node)
      if (layout.shaped) {
        const rasterScale = Math.min(4, Math.max(1, zoomBucket(this.bakeOpts.camera.zoom) * this.bakeOpts.dpr))
        const unitScale = (node.fontSize * rasterScale) / layout.shaped.unitsPerEm
        const quads: number[] = []
        let ok = true
        for (const line of layout.lines) {
          const glyphs = line.glyphs
          if (!glyphs) continue
          for (let i = 0; i + 3 <= glyphs.length; i += 3) {
            const entry = this.atlas.get(layout.shaped.fontId, glyphs[i], unitScale)
            if (!entry) {
              ok = false
              break
            }
            if (entry.empty) continue
            const gx = glyphs[i + 1]
            const gy = glyphs[i + 2]
            quads.push(
              gx + entry.x0 / rasterScale,
              gy + entry.y0 / rasterScale,
              gx + entry.x1 / rasterScale,
              gy + entry.y1 / rasterScale,
              entry.u0,
              entry.v0,
              entry.u1,
              entry.v1,
            )
          }
          if (!ok) break
        }
        if (ok) {
          this.appendGlyphQuads(quads, m, this.paintColor(paint, opacity), blend)
          return
        }
      }
    }

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
    this.segments.push({ kind: 'texture', blend, uniformOffset: offset, texKey, ...loc })
  }

  /**
   * A 3D model draws as one textured quad carrying its offscreen snapshot
   * (ADR-020). Snapshot misses fall back to the same grey placeholder the
   * Canvas2D backend paints, and the ready notification re-bakes.
   */
  private bakeModel3d(node: Model3dNode, m: Mat, opacity: number, blend: number): void {
    if (node.width <= 0 || node.height <= 0) return
    const deviceScale = this.bakeOpts.camera.zoom * this.bakeOpts.dpr
    const spec = node.assetHash ? snapshotSpec(node, node.width, node.height, deviceScale) : null
    let bitmap: ImageBitmap | undefined
    if (spec) {
      bitmap = getSnapshot(spec)
      if (!bitmap) {
        requestSnapshot(spec)
        if (!snapshotError(spec)) bitmap = getStaleSnapshot(spec)
      }
    }
    if (!bitmap) {
      // Same grey placeholder the Canvas2D backend paints on a miss.
      this.appendSolid(
        new Float32Array([0, 0, node.width, 0, node.width, node.height, 0, node.height]),
        new Uint32Array([0, 1, 2, 0, 2, 3]),
        m,
        [0.5, 0.5, 0.5, 0.35 * opacity],
        blend,
      )
      return
    }

    const texKey = `m3d:${node.id}`
    // The snapshot for a given view is content-identical, so the node id
    // plus the bitmap identity is enough — but the pose changes the pixels,
    // so retire the previous texture whenever the bitmap object differs.
    if (this.model3dBitmaps.get(texKey) !== bitmap) {
      this.retireTexture(texKey)
      this.ensureTexture(texKey, bitmap)
      this.model3dBitmaps.set(texKey, bitmap)
    }
    this.endBatch()
    const quad = new Float32Array([0, 0, node.width, 0, node.width, node.height, 0, node.height])
    const quadIdx = new Uint32Array([0, 1, 2, 0, 2, 3])
    const loc = this.appendLocalMesh(quad, quadIdx)
    const offset = this.allocUniform(TEXTURE_UNIFORM_SIZE)
    const f = new Float32Array(this.uniformData.buffer, offset, TEXTURE_UNIFORM_SIZE / 4)
    f.set([m.a, m.b, m.c, m.d, m.e, m.f, opacity, 0], 0)
    f.set([1 / node.width, 1 / node.height, 0, 0], 8)
    f.set([1, 1, 1, 0], 12)
    this.segments.push({ kind: 'texture', blend, uniformOffset: offset, texKey, ...loc })
  }

  /** Free a texture and its bind group so a key can be re-uploaded. */
  private retireTexture(key: string): void {
    this.textures.get(key)?.destroy()
    this.textures.delete(key)
    this.textureBindGroups.delete(key)
  }

  private paintColor(paint: Extract<Paint, { type: 'SOLID' }>, opacity: number): [number, number, number, number] {
    return [
      paint.color.r,
      paint.color.g,
      paint.color.b,
      paint.color.a * paint.opacity * opacity,
    ]
  }

  private bakeFillPaint(
    node: SceneNode,
    paint: Paint,
    mesh: NodeMesh,
    m: Mat,
    opacity: number,
    blend: number,
  ): void {
    if (paint.type === 'SOLID') {
      this.appendSolid(mesh.fillPositions, mesh.fillIndices, m, this.paintColor(paint, opacity), blend)
    } else if (paint.type === 'IMAGE') {
      this.bakeImage(node, paint, { positions: mesh.fillPositions, indices: mesh.fillIndices }, m, opacity, blend)
    } else {
      this.bakeGradient(node, paint, { positions: mesh.fillPositions, indices: mesh.fillIndices }, m, opacity, blend, fillPaintBox(node))
    }
  }

  private bakeFills(node: SceneNode, mesh: NodeMesh, m: Mat, opacity: number, blend: number): void {
    for (const paint of node.fills) {
      if (!paint.visible) continue
      this.bakeFillPaint(node, paint, mesh, m, opacity, blend)
    }
  }

  private bakeStrokes(node: SceneNode, mesh: NodeMesh, m: Mat, opacity: number, blend: number): void {
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
        this.appendSolid(mesh.strokePositions, mesh.strokeIndices, m, this.paintColor(paint, opacity), blend)
      } else {
        this.bakeGradient(node, paint, { positions: mesh.strokePositions, indices: mesh.strokeIndices }, m, opacity, blend, strokePaintBox(node))
      }
    }
    if (needsClip) {
      if (mesh.strokeAlignCode === 2) this.segments.push({ kind: 'setRef', delta: 1 })
      this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'pop')
    }
  }

  private bakeChildren(
    children: readonly NodeId[],
    parentMat: Mat,
    opacity: number,
    blend: number,
    inLayer: boolean,
  ): void {
    const scene = this.bakeScene
    let maskDepth = 0
    for (const cid of children) {
      const child = scene.getNode(cid)
      if (!child) continue
      if (child.isMask && child.visible) {
        const m = matMultiply(parentMat, scene.localMatrix(child))
        // The mask's coverage, not the mask node's own fill: a group masks with
        // the union of its contents and a text node with its glyphs.
        const mesh = this.meshCache.getMask(scene, child, this.bakeOpts.camera.zoom)
        this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'push')
        maskDepth++
        continue
      }
      this.bakeNode(cid, parentMat, opacity, blend, inLayer)
    }
    while (maskDepth-- > 0) {
      // Pop reuses its paired push's mesh range (resolved at execute time).
      this.endBatch()
      this.segments.push({ kind: 'stencil', op: 'pop', firstIndex: -1, indexCount: -1 })
    }
  }

  // -------------------------------------------------------------------------
  // Effect layer plumbing
  // -------------------------------------------------------------------------

  /** World AABB of a node incl. unclipped descendants (isolation bounds). */
  private subtreeBounds(id: NodeId): AABB {
    const scene = this.bakeScene
    const node = scene.getNode(id)
    const own = scene.worldAABB(id)
    if (!node) return own
    const kids = (node as { children?: readonly NodeId[] }).children
    if (!kids || kids.length === 0) return own
    if (isFrameLike(node) && node.clipsContent) return own
    let minX = own.minX
    let minY = own.minY
    let maxX = own.maxX
    let maxY = own.maxY
    for (const cid of kids) {
      const c = this.subtreeBounds(cid)
      minX = Math.min(minX, c.minX)
      minY = Math.min(minY, c.minY)
      maxX = Math.max(maxX, c.maxX)
      maxY = Math.max(maxY, c.maxY)
    }
    return { minX, minY, maxX, maxY }
  }

  private layerGeom(bb: AABB, padWorld: number): {
    originX: number
    originY: number
    scale: number
    texW: number
    texH: number
    x1: number
    y1: number
  } {
    const x0 = bb.minX - padWorld
    const y0 = bb.minY - padWorld
    const x1 = bb.maxX + padWorld
    const y1 = bb.maxY + padWorld
    const w = Math.max(1e-3, x1 - x0)
    const h = Math.max(1e-3, y1 - y0)
    let scale = Math.min(4, Math.max(0.125, zoomBucket(this.bakeOpts.camera.zoom) * this.bakeOpts.dpr))
    scale = Math.min(scale, MAX_LAYER_TEX / w, MAX_LAYER_TEX / h)
    const texW = Math.max(2, Math.min(MAX_LAYER_TEX, Math.ceil(w * scale)))
    const texH = Math.max(2, Math.min(MAX_LAYER_TEX, Math.ceil(h * scale)))
    return { originX: x0, originY: y0, scale, texW, texH, x1, y1 }
  }

  private emitFxQuad(args: {
    mode: number
    layerKey: string | null
    geom:
      | { kind: 'quad'; x0: number; y0: number; x1: number; y1: number }
      | { kind: 'mesh'; positions: Float32Array; indices: Uint32Array; m: Mat }
    opacity: number
    origin: [number, number]
    uvScale: [number, number]
    radiusWorld?: number
    needsBackdrop: boolean
    fallback?: boolean
  }): void {
    this.endBatch()
    let loc: { firstVertex: number; firstIndex: number; indexCount: number }
    let m: Mat = IDENTITY
    if (args.geom.kind === 'quad') {
      const { x0, y0, x1, y1 } = args.geom
      loc = this.appendLocalMesh(
        new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
        new Uint32Array([0, 1, 2, 0, 2, 3]),
      )
    } else {
      loc = this.appendLocalMesh(args.geom.positions, args.geom.indices)
      m = args.geom.m
    }
    const writeUniform = (mode: number): number => {
      const offset = this.allocUniform(FX_UNIFORM_SIZE)
      const f = new Float32Array(this.uniformData.buffer, offset, FX_UNIFORM_SIZE / 4)
      f.set([m.a, m.b, m.c, m.d, m.e, m.f, args.opacity, mode], 0)
      f.set([args.origin[0], args.origin[1], args.uvScale[0], args.uvScale[1]], 8)
      return offset
    }
    const uniformOffset = writeUniform(args.mode)
    const fallbackUniformOffset = args.fallback ? writeUniform(0) : -1
    this.segments.push({
      kind: 'fxQuad',
      mode: args.mode,
      layerKey: args.layerKey,
      uniformOffset,
      fallbackUniformOffset,
      needsBackdrop: args.needsBackdrop,
      radiusWorld: args.radiusWorld ?? 0,
      ...loc,
    })
  }

  private bakeNode(
    id: NodeId,
    parentMat: Mat,
    parentOpacity: number,
    parentBlend: number,
    inLayer: boolean,
  ): void {
    const scene = this.bakeScene
    const node = scene.getNode(id)
    if (!node || !node.visible || node.opacity <= 0) return
    const m = matMultiply(parentMat, scene.localMatrix(node))
    const opacity = parentOpacity * node.opacity

    // Effective blend: inherited like the Canvas2D reference (a NORMAL child
    // draws with its ancestor's composite op).
    let blend = parentBlend
    let fxBlendMode = -1
    if (node.blendMode !== 'NORMAL') {
      const fixed = FIXED_BLEND[node.blendMode]
      if (fixed !== undefined) blend = fixed
      else {
        blend = 0
        fxBlendMode = FX_BLEND_MODE[node.blendMode] ?? -1
        // Documented fallback: exotic blends inside an isolated layer render NORMAL.
        if (inLayer) fxBlendMode = -1
      }
    }

    const effects = node.effects.filter((e) => e.visible)
    let drop: DropShadowEffect | null = null
    let layerBlurRadius = 0
    for (const fx of effects) {
      // Last-one-wins mirrors applyEffectsBeforeDraw overwriting ctx state.
      if (fx.type === 'DROP_SHADOW') drop = fx
      else if (fx.type === 'LAYER_BLUR' && fx.radius > 0) layerBlurRadius = fx.radius
    }
    const inners = effects.filter((e) => e.type === 'INNER_SHADOW')
    const bgBlur = effects.find((e) => e.type === 'BACKGROUND_BLUR' && e.radius > 0)

    // The reference applies inner/background effects only to shape-painting
    // node types, and drop shadows only to nodes that paint themselves
    // (frames additionally never cast from strokes — quirk preserved).
    const geometric = node.type !== 'GROUP' && node.type !== 'TEXT' && node.type !== 'LINE'
    const hasFillPaint = node.fills.some((f) => f.visible)
    const hasStrokePaint = node.strokes.some((s) => s.visible)
    // A container with nothing of its own to paint casts from its whole
    // subtree, as one silhouette — the reference flattens these to a scratch
    // buffer for exactly this reason (compositeEffects in canvas2d.ts).
    const kidCount = (node as { children?: readonly NodeId[] }).children?.length ?? 0
    const flattens =
      kidCount > 0 && (node.type === 'GROUP' || (isFrameLike(node) && !hasFillPaint && !hasStrokePaint))
    let shadowCaster: 'fill' | 'stroke' | 'self' | null = null
    if (drop) {
      if (node.type === 'TEXT') shadowCaster = hasFillPaint ? 'self' : null
      else if (node.type === 'GROUP') shadowCaster = flattens ? 'self' : null
      else if (flattens) shadowCaster = 'self'
      else if (hasFillPaint) shadowCaster = 'fill'
      else if (hasStrokePaint && !isFrameLike(node)) shadowCaster = 'stroke'
    }
    const isolate = layerBlurRadius > 0 || fxBlendMode >= 0

    if (!shadowCaster && inners.length === 0 && !isolate && (!bgBlur || !geometric || inLayer)) {
      this.bakeNodePlain(node, m, opacity, blend, inLayer)
      return
    }

    // ---- Effect path -------------------------------------------------------
    const zoom = this.bakeOpts.camera.zoom
    this.endBatch()
    const wantStroke = node.strokes.some((s) => s.visible && s.type !== 'IMAGE')
    const mesh =
      node.type !== 'GROUP' && node.type !== 'TEXT'
        ? this.meshCache.get(scene, node, zoom, true, wantStroke)
        : null

    // 1. Background blur beneath everything of this node (reference order).
    if (bgBlur && !inLayer && geometric && mesh && mesh.fillIndices.length > 0) {
      this.emitFxQuad({
        mode: 1,
        layerKey: null,
        geom: { kind: 'mesh', positions: mesh.fillPositions, indices: mesh.fillIndices, m },
        opacity: 1,
        origin: [0, 0],
        uvScale: [0, 0],
        radiusWorld: bgBlur.type === 'BACKGROUND_BLUR' ? bgBlur.radius : 0,
        needsBackdrop: true,
      })
    }

    // 2. Drop shadow composite (layer range patched after the caster bakes).
    let shadowSpec: FxLayerSpec | null = null
    if (drop && shadowCaster) {
      // A flattened container casts from its children, which for a
      // non-clipping one can reach outside its own box.
      const bb = flattens ? this.subtreeBounds(node.id) : scene.worldAABB(node.id)
      const pad = drop.blur * 1.5 + Math.max(Math.abs(drop.offset.x), Math.abs(drop.offset.y)) + 2
      const lay = this.layerGeom(bb, pad)
      const key = `fx${this.fxKeyCounter++}`
      shadowSpec = {
        key,
        segStart: -1,
        segEnd: -1,
        originX: lay.originX,
        originY: lay.originY,
        scale: lay.scale,
        texW: lay.texW,
        texH: lay.texH,
        blurRadiusPx: drop.blur * lay.scale,
        sampleOffX: -drop.offset.x * lay.scale,
        sampleOffY: -drop.offset.y * lay.scale,
        tint: [
          drop.color.r * drop.color.a,
          drop.color.g * drop.color.a,
          drop.color.b * drop.color.a,
          drop.color.a,
        ],
        invert: false,
        mask: false,
      }
      // Caster colors already carry paint + cumulative opacity.
      this.emitFxQuad({
        mode: 0,
        layerKey: key,
        geom: { kind: 'quad', x0: lay.originX, y0: lay.originY, x1: lay.x1, y1: lay.y1 },
        opacity: 1,
        origin: [lay.originX, lay.originY],
        uvScale: [lay.scale / lay.texW, lay.scale / lay.texH],
        needsBackdrop: false,
      })
    }

    // 3. Isolated content (layer blur / exotic blend) is skipped by the scene
    //    pass and composited from its pre-rendered layer texture instead.
    let skipSeg: Extract<Segment, { kind: 'skip' }> | null = null
    if (isolate) {
      skipSeg = { kind: 'skip', to: -1 }
      this.segments.push(skipSeg)
    }
    const contentStart = this.segments.length

    // 4. The node's own content, in reference order.
    if (node.type === 'GROUP') {
      this.bakeChildren(node.children, m, opacity, blend, inLayer || isolate)
      this.endBatch()
    } else if (node.type === 'TEXT') {
      if (this.bakeOpts.editingTextId !== node.id) this.bakeText(node, m, opacity, blend)
      this.endBatch() // seal glyph quads inside the fx content range
    } else if (mesh) {
      // Fills — the first visible fill is sealed into its own segment range
      // so it can double as the drop-shadow caster.
      const casterStart = this.segments.length
      const fills = node.fills.filter((p) => p.visible)
      if (fills.length > 0) {
        this.bakeFillPaint(node, fills[0], mesh, m, opacity, blend)
        this.endBatch()
      }
      const casterEnd = this.segments.length
      for (let i = 1; i < fills.length; i++) this.bakeFillPaint(node, fills[i], mesh, m, opacity, blend)
      this.endBatch()
      if (shadowSpec && shadowCaster === 'fill') {
        shadowSpec.segStart = casterStart
        shadowSpec.segEnd = casterEnd
      }

      // Inner shadows: tint × blur(1 − α) masked by α, from a white caster
      // mesh the scene pass skips.
      if (geometric && mesh.fillIndices.length > 0) {
        for (const fx of inners) {
          if (fx.type !== 'INNER_SHADOW') continue
          const bb = scene.worldAABB(node.id)
          const pad = fx.blur * 1.5 + Math.max(Math.abs(fx.offset.x), Math.abs(fx.offset.y)) + 2
          const lay = this.layerGeom(bb, pad)
          const key = `fx${this.fxKeyCounter++}`
          const casterSkip: Extract<Segment, { kind: 'skip' }> = { kind: 'skip', to: -1 }
          this.segments.push(casterSkip)
          const cStart = this.segments.length
          this.appendSolid(mesh.fillPositions, mesh.fillIndices, m, [1, 1, 1, 1], 0)
          this.endBatch()
          const cEnd = this.segments.length
          casterSkip.to = cEnd
          this.fxLayers.push({
            key,
            segStart: cStart,
            segEnd: cEnd,
            originX: lay.originX,
            originY: lay.originY,
            scale: lay.scale,
            texW: lay.texW,
            texH: lay.texH,
            blurRadiusPx: fx.blur * lay.scale,
            sampleOffX: -fx.offset.x * lay.scale,
            sampleOffY: -fx.offset.y * lay.scale,
            tint: [
              fx.color.r * fx.color.a,
              fx.color.g * fx.color.a,
              fx.color.b * fx.color.a,
              fx.color.a,
            ],
            invert: true,
            mask: true,
          })
          // The white caster carries no opacity — apply the cumulative here.
          this.emitFxQuad({
            mode: 0,
            layerKey: key,
            geom: { kind: 'quad', x0: lay.originX, y0: lay.originY, x1: lay.x1, y1: lay.y1 },
            opacity,
            origin: [lay.originX, lay.originY],
            uvScale: [lay.scale / lay.texW, lay.scale / lay.texH],
            needsBackdrop: false,
          })
        }
      }

      // Children (frames), mirroring the plain path's clip logic.
      if (isFrameLike(node)) {
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
            this.bakeChildren(node.children, m, opacity, blend, inLayer || isolate)
            this.endBatch()
            this.segments.push({ kind: 'scissor', op: 'pop' })
          } else {
            this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'push')
            this.bakeChildren(node.children, m, opacity, blend, inLayer || isolate)
            this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'pop')
          }
        } else {
          this.bakeChildren(node.children, m, opacity, blend, inLayer || isolate)
        }
      }

      // Strokes.
      const strokeStart = this.segments.length
      this.bakeStrokes(node, mesh, m, opacity, blend)
      this.endBatch()
      if (shadowSpec && shadowCaster === 'stroke') {
        shadowSpec.segStart = strokeStart
        shadowSpec.segEnd = this.segments.length
      }
    }
    const contentEnd = this.segments.length
    if (shadowSpec && shadowCaster === 'self') {
      shadowSpec.segStart = contentStart
      shadowSpec.segEnd = contentEnd
    }
    // Push after child specs so replay order satisfies dependencies.
    if (shadowSpec && shadowSpec.segStart >= 0) this.fxLayers.push(shadowSpec)

    if (isolate && skipSeg) {
      skipSeg.to = contentEnd
      const bb = this.subtreeBounds(id)
      const pad = layerBlurRadius * 1.5 + 2
      const lay = this.layerGeom(bb, pad)
      const key = `fx${this.fxKeyCounter++}`
      this.fxLayers.push({
        key,
        segStart: contentStart,
        segEnd: contentEnd,
        originX: lay.originX,
        originY: lay.originY,
        scale: lay.scale,
        texW: lay.texW,
        texH: lay.texH,
        blurRadiusPx: layerBlurRadius * lay.scale,
        sampleOffX: 0,
        sampleOffY: 0,
        tint: null,
        invert: false,
        mask: false,
      })
      this.emitFxQuad({
        mode: fxBlendMode >= 0 ? fxBlendMode : 0,
        layerKey: key,
        geom: { kind: 'quad', x0: lay.originX, y0: lay.originY, x1: lay.x1, y1: lay.y1 },
        opacity: 1,
        origin: [lay.originX, lay.originY],
        uvScale: [lay.scale / lay.texW, lay.scale / lay.texH],
        needsBackdrop: fxBlendMode >= 0,
        fallback: fxBlendMode >= 0,
      })
    }
  }

  private bakeNodePlain(node: SceneNode, m: Mat, opacity: number, blend: number, inLayer: boolean): void {
    const scene = this.bakeScene
    const zoom = this.bakeOpts.camera.zoom

    switch (node.type) {
      case 'FRAME':
      case 'COMPONENT':
      case 'INSTANCE': {
        const wantStroke = node.strokes.some((s) => s.visible && s.type !== 'IMAGE')
        const mesh = this.meshCache.get(scene, node, zoom, true, wantStroke)
        this.bakeFills(node, mesh, m, opacity, blend)
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
            this.bakeChildren(node.children, m, opacity, blend, inLayer)
            this.endBatch()
            this.segments.push({ kind: 'scissor', op: 'pop' })
          } else {
            this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'push')
            this.bakeChildren(node.children, m, opacity, blend, inLayer)
            this.appendStencil(mesh.fillPositions, mesh.fillIndices, m, 'pop')
          }
        } else {
          this.bakeChildren(node.children, m, opacity, blend, inLayer)
        }
        this.bakeStrokes(node, mesh, m, opacity, blend)
        break
      }
      case 'GROUP':
        this.bakeChildren(node.children, m, opacity, blend, inLayer)
        break
      case 'TEXT':
        if (this.bakeOpts.editingTextId !== node.id) this.bakeText(node, m, opacity, blend)
        break
      case 'MODEL3D':
        this.bakeModel3d(node, m, opacity, blend)
        break
      default: {
        // RECTANGLE / ELLIPSE / LINE / POLYGON / STAR / VECTOR / BOOLEAN
        const wantStroke = node.strokes.some((s) => s.visible && s.type !== 'IMAGE')
        const mesh = this.meshCache.get(scene, node, zoom, true, wantStroke)
        this.bakeFills(node, mesh, m, opacity, blend)
        this.bakeStrokes(node, mesh, m, opacity, blend)
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

    const glyphBytes = Math.max(16, this.glyphArena.len * 4)
    if (need(this.glyphGpu, glyphBytes)) {
      this.glyphGpu?.destroy()
      this.glyphGpu = device.createBuffer({
        size: Math.ceil((glyphBytes * 1.5) / 16) * 16,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(this.glyphGpu!, 0, this.glyphArena.data.buffer, 0, this.glyphArena.len * 4)

    const glyphIdxBytes = Math.max(16, this.glyphIndices.len * 4)
    if (need(this.glyphIndexGpu, glyphIdxBytes)) {
      this.glyphIndexGpu?.destroy()
      this.glyphIndexGpu = device.createBuffer({
        size: Math.ceil((glyphIdxBytes * 1.5) / 16) * 16,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
    }
    device.queue.writeBuffer(this.glyphIndexGpu!, 0, this.glyphIndices.data.buffer, 0, this.glyphIndices.len * 4)

    if (!this.uniformGpu || this.uniformGpu.size < this.uniformData.length) {
      // Recreating the buffer invalidates every bind group that referenced it.
      this.uniformGpu?.destroy()
      this.uniformGpu = device.createBuffer({
        size: this.uniformData.length,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.textureBindGroups.clear()
      this.gradientBindGroup = null
      this.fxBindGroups.clear()
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

  /** Upload freshly rasterized atlas cells (whole-canvas copy on change). */
  private uploadAtlas(): void {
    if (!this.atlas.dirty) return
    if (!this.atlasTexture) {
      this.atlasTexture = this.device.createTexture({
        size: [this.atlas.size, this.atlas.size],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      this.atlasBindGroup = null
    }
    this.device.queue.copyExternalImageToTexture(
      { source: this.atlas.canvas },
      { texture: this.atlasTexture, premultipliedAlpha: true },
      [this.atlas.size, this.atlas.size],
    )
    this.atlas.dirty = false
  }

  private getAtlasBindGroup(): GPUBindGroup | null {
    if (this.atlasBindGroup) return this.atlasBindGroup
    if (!this.atlasTexture) return null
    this.atlasBindGroup = this.device.createBindGroup({
      layout: this.glyphLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.atlasTexture.createView() },
      ],
    })
    return this.atlasBindGroup
  }

  // -------------------------------------------------------------------------
  // Effect layer pre-render (bake time — view-independent)
  // -------------------------------------------------------------------------

  private blurBindGroup(uniform: GPUBuffer, src: GPUTexture, mask: GPUTexture): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.blurLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: src.createView() },
        { binding: 3, resource: mask.createView() },
      ],
    })
  }

  private blurPass(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    dst: GPUTexture,
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: dst.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(this.blurPipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
  }

  private preRenderFxLayers(): void {
    const device = this.device
    // Reset per-bake effect resources.
    for (const t of this.fxTextures.values()) t.destroy()
    this.fxTextures.clear()
    this.fxBindGroups.clear()
    for (const f of this.frameFx.values()) {
      f.uH.destroy()
      f.uV.destroy()
    }
    this.frameFx.clear()
    this.frameFxBindGroups.clear()

    // Per-frame blur uniforms for background-blur segments (radius depends on
    // the live zoom, so they are written every frame).
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]
      if (seg.kind === 'fxQuad' && seg.mode === 1) {
        const mk = () =>
          device.createBuffer({
            size: BLUR_UNIFORM_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
        this.frameFx.set(i, { uH: mk(), uV: mk() })
      }
    }

    if (this.fxLayers.length === 0) return
    const transient: (GPUBuffer | GPUTexture)[] = []
    const encoder = device.createCommandEncoder()
    for (const spec of this.fxLayers) {
      const size: [number, number] = [spec.texW, spec.texH]
      const target = device.createTexture({
        size,
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.fxTextures.set(spec.key, target)
      const needBlur = spec.blurRadiusPx > 0 || spec.tint !== null || spec.invert
      const msaaT = device.createTexture({
        size,
        sampleCount: 4,
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const dsT = device.createTexture({
        size,
        sampleCount: 4,
        format: 'depth24plus-stencil8',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const tempA = needBlur
        ? device.createTexture({
            size,
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          })
        : null
      transient.push(msaaT, dsT)
      if (tempA) transient.push(tempA)

      // Replay the segment range with a layer-local camera.
      const camBuf = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      transient.push(camBuf)
      device.queue.writeBuffer(
        camBuf,
        0,
        new Float32Array([spec.originX, spec.originY, spec.scale, 0, spec.texW, spec.texH, 0, 0]),
      )
      const camBG = device.createBindGroup({
        layout: this.cameraLayout,
        entries: [{ binding: 0, resource: { buffer: camBuf } }],
      })
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: msaaT.createView(),
            resolveTarget: (tempA ?? target).createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'discard',
          },
        ],
        depthStencilAttachment: {
          view: dsT.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
          depthClearValue: 1,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
          stencilClearValue: 0,
        },
      })
      pass.setBindGroup(0, camBG)
      const ctx: ExecCtx = {
        dw: spec.texW,
        dh: spec.texH,
        camX: spec.originX,
        camY: spec.originY,
        zoomDpr: spec.scale,
        scissors: [],
        stencilPops: [],
        stencilDepth: 0,
        refDelta: 0,
        replay: true,
      }
      this.applyScissorTo(pass, ctx)
      this.execRange(pass, spec.segStart, spec.segEnd, ctx)
      pass.end()

      if (needBlur && tempA) {
        const tempB = device.createTexture({
          size,
          format: this.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        transient.push(tempB)
        const mkUniform = (data: number[]): GPUBuffer => {
          const buf = device.createBuffer({
            size: BLUR_UNIFORM_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
          device.queue.writeBuffer(buf, 0, new Float32Array(data))
          transient.push(buf)
          return buf
        }
        // H: invert (inner) + sample offset; V: tint + mask.
        const uH = mkUniform([
          1, 0, spec.blurRadiusPx, spec.invert ? 1 : 0,
          spec.sampleOffX, spec.sampleOffY, 0, 0,
          0, 0, 0, 0,
        ])
        const flagsV = (spec.tint ? 2 : 0) | (spec.mask ? 4 : 0)
        const t = spec.tint ?? [0, 0, 0, 0]
        const uV = mkUniform([
          0, 1, spec.blurRadiusPx, flagsV,
          0, 0, 0, 0,
          t[0], t[1], t[2], t[3],
        ])
        this.blurPass(encoder, this.blurBindGroup(uH, tempA, tempA), tempB)
        this.blurPass(encoder, this.blurBindGroup(uV, tempB, tempA), target)
      }
    }
    device.queue.submit([encoder.finish()])
    // Deallocation of in-flight resources is deferred by WebGPU until the
    // submitted work completes — safe to destroy immediately.
    for (const r of transient) r.destroy()
  }

  // -------------------------------------------------------------------------
  // Frame execution
  // -------------------------------------------------------------------------

  private ensureTargets(w: number, h: number): void {
    if (this.targetW === w && this.targetH === h && this.msaa && this.depthStencil) return
    this.msaa?.destroy()
    this.depthStencil?.destroy()
    this.resolveTex?.destroy()
    this.backdropTex?.destroy()
    this.pingA?.destroy()
    this.pingB?.destroy()
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
    this.resolveTex = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    this.backdropTex = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.pingA = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.pingB = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.blitBindGroup = null
    this.fxBindGroups.clear()
    this.frameFxBindGroups.clear()
    this.targetW = w
    this.targetH = h
  }

  private applyScissorTo(pass: GPURenderPassEncoder, ctx: ExecCtx): void {
    let x0 = 0
    let y0 = 0
    let x1 = ctx.dw
    let y1 = ctx.dh
    for (const r of ctx.scissors) {
      x0 = Math.max(x0, (r.minX - ctx.camX) * ctx.zoomDpr)
      y0 = Math.max(y0, (r.minY - ctx.camY) * ctx.zoomDpr)
      x1 = Math.min(x1, (r.maxX - ctx.camX) * ctx.zoomDpr)
      y1 = Math.min(y1, (r.maxY - ctx.camY) * ctx.zoomDpr)
    }
    const x = Math.max(0, Math.min(ctx.dw, Math.floor(x0)))
    const y = Math.max(0, Math.min(ctx.dh, Math.floor(y0)))
    const wpx = Math.max(0, Math.min(ctx.dw - x, Math.ceil(x1) - x))
    const hpx = Math.max(0, Math.min(ctx.dh - y, Math.ceil(y1) - y))
    pass.setScissorRect(x, y, wpx, hpx)
  }

  private fxQuadBindGroup(seg: Extract<Segment, { kind: 'fxQuad' }>): GPUBindGroup | null {
    const cacheKey = `${seg.mode}:${seg.layerKey ?? ''}`
    const cached = this.fxBindGroups.get(cacheKey)
    if (cached) return cached
    if (!this.uniformGpu) return null
    const layerTex = seg.layerKey ? this.fxTextures.get(seg.layerKey) : null
    if (seg.layerKey && !layerTex) return null
    const backdrop =
      seg.mode === 1 ? this.pingB : seg.mode >= 2 ? this.backdropTex : this.dummyTex
    const bg = this.device.createBindGroup({
      layout: this.fxLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformGpu, size: FX_UNIFORM_SIZE } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: (layerTex ?? this.dummyTex).createView() },
        { binding: 3, resource: (backdrop ?? this.dummyTex).createView() },
      ],
    })
    this.fxBindGroups.set(cacheKey, bg)
    return bg
  }

  /** Draw one segment. 'skip' is handled by callers (needs the loop index). */
  private drawSeg(pass: GPURenderPassEncoder, seg: Segment, ctx: ExecCtx): void {
    switch (seg.kind) {
      case 'batch': {
        pass.setPipeline(this.solidPipelines[seg.blend])
        pass.setStencilReference(ctx.stencilDepth + ctx.refDelta)
        pass.setVertexBuffer(0, this.arenaGpu!)
        pass.setIndexBuffer(this.arenaIndexGpu!, 'uint32')
        pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
        break
      }
      case 'glyphs': {
        const bg = this.getAtlasBindGroup()
        if (!bg) break
        pass.setPipeline(this.glyphPipelines[seg.blend])
        pass.setStencilReference(ctx.stencilDepth + ctx.refDelta)
        pass.setBindGroup(1, bg)
        pass.setVertexBuffer(0, this.glyphGpu!)
        pass.setIndexBuffer(this.glyphIndexGpu!, 'uint32')
        pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
        break
      }
      case 'setRef': {
        ctx.refDelta += seg.delta
        break
      }
      case 'stencil': {
        if (seg.op === 'push') {
          pass.setPipeline(this.stencilPushPipeline)
          pass.setStencilReference(ctx.stencilDepth)
          pass.setVertexBuffer(0, this.arenaGpu!)
          pass.setIndexBuffer(this.arenaIndexGpu!, 'uint32')
          if (seg.indexCount > 0) pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
          ctx.stencilPops.push(seg)
          ctx.stencilDepth++
        } else {
          const pushSeg = ctx.stencilPops.pop()
          ctx.stencilDepth--
          const first = seg.firstIndex >= 0 ? seg.firstIndex : (pushSeg as { firstIndex: number })?.firstIndex ?? 0
          const count = seg.indexCount >= 0 ? seg.indexCount : (pushSeg as { indexCount: number })?.indexCount ?? 0
          pass.setPipeline(this.stencilPopPipeline)
          pass.setStencilReference(ctx.stencilDepth + 1)
          pass.setVertexBuffer(0, this.arenaGpu!)
          pass.setIndexBuffer(this.arenaIndexGpu!, 'uint32')
          if (count > 0) pass.drawIndexed(count, 1, first)
        }
        break
      }
      case 'scissor': {
        if (seg.op === 'push') ctx.scissors.push(seg.rect!)
        else ctx.scissors.pop()
        this.applyScissorTo(pass, ctx)
        break
      }
      case 'gradient': {
        pass.setPipeline(this.gradientPipelines[seg.blend])
        pass.setStencilReference(ctx.stencilDepth + ctx.refDelta)
        pass.setBindGroup(1, this.gradientBindGroup!, [seg.uniformOffset])
        pass.setVertexBuffer(0, this.localGpu!)
        pass.setIndexBuffer(this.localIndexGpu!, 'uint32')
        pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
        break
      }
      case 'texture': {
        const bg = this.bindGroupFor(seg.texKey)
        if (!bg) break
        pass.setPipeline(this.texturePipelines[seg.blend])
        pass.setStencilReference(ctx.stencilDepth + ctx.refDelta)
        pass.setBindGroup(1, bg, [seg.uniformOffset])
        pass.setVertexBuffer(0, this.localGpu!)
        pass.setIndexBuffer(this.localIndexGpu!, 'uint32')
        pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
        break
      }
      case 'fxQuad': {
        // Backdrop-dependent draws cannot run inside a replay: background
        // blur is skipped; exotic blends composite via their mode-0 twin.
        if (ctx.replay && seg.mode === 1) break
        const useFallback = ctx.replay && seg.needsBackdrop && seg.fallbackUniformOffset >= 0
        const bg = this.fxQuadBindGroup(seg)
        if (!bg) break
        pass.setPipeline(this.fxPipeline)
        pass.setStencilReference(ctx.stencilDepth + ctx.refDelta)
        pass.setBindGroup(1, bg, [useFallback ? seg.fallbackUniformOffset : seg.uniformOffset])
        pass.setVertexBuffer(0, this.localGpu!)
        pass.setIndexBuffer(this.localIndexGpu!, 'uint32')
        pass.drawIndexed(seg.indexCount, 1, seg.firstIndex)
        break
      }
      case 'skip':
        break
    }
  }

  /** Execute a segment range into an already-configured pass (fx replays). */
  private execRange(pass: GPURenderPassEncoder, from: number, to: number, ctx: ExecCtx): void {
    for (let i = from; i < to; i++) {
      const seg = this.segments[i]
      if (seg.kind === 'skip') {
        i = seg.to - 1
        continue
      }
      this.drawSeg(pass, seg, ctx)
    }
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

    // Per-frame blur uniforms for background-blur segments (device-px radius
    // tracks the live zoom). Queued writes land before the submit below.
    const zoomDpr = opts.camera.zoom * opts.dpr
    for (const [i, f] of this.frameFx) {
      const seg = this.segments[i]
      if (!seg || seg.kind !== 'fxQuad') continue
      const r = seg.radiusWorld * zoomDpr
      this.device.queue.writeBuffer(f.uH, 0, new Float32Array([1, 0, r, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
      this.device.queue.writeBuffer(f.uV, 0, new Float32Array([0, 1, r, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    }

    const bg = parseColor(opts.background ?? '#1e1e1e')
    const tTex = performance.now()
    const currentTexture = this.context.getCurrentTexture()
    this.lastTimings.texture = performance.now() - tTex
    const tEnc = performance.now()
    const encoder = this.device.createCommandEncoder()
    const keepScene = this.hasBackdropFx
    const beginScene = (first: boolean): GPURenderPassEncoder => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.msaa!.createView(),
            resolveTarget: this.resolveTex!.createView(),
            clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 },
            loadOp: first ? 'clear' : 'load',
            storeOp: keepScene ? 'store' : 'discard',
          },
        ],
        depthStencilAttachment: {
          view: this.depthStencil!.createView(),
          depthLoadOp: first ? 'clear' : 'load',
          depthStoreOp: keepScene ? 'store' : 'discard',
          depthClearValue: 1,
          stencilLoadOp: first ? 'clear' : 'load',
          stencilStoreOp: keepScene ? 'store' : 'discard',
          stencilClearValue: 0,
        },
      })
      pass.setBindGroup(0, this.cameraBindGroup)
      return pass
    }

    let pass = beginScene(true)
    this.lastTimings.begin = performance.now() - tEnc
    const tLoop = performance.now()

    const ctx: ExecCtx = {
      dw,
      dh,
      camX: opts.camera.x,
      camY: opts.camera.y,
      zoomDpr,
      scissors: [],
      stencilPops: [],
      stencilDepth: 0,
      refDelta: 0,
      replay: false,
    }
    this.applyScissorTo(pass, ctx)

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]
      if (seg.kind === 'skip') {
        i = seg.to - 1
        continue
      }
      if (seg.kind === 'fxQuad' && seg.needsBackdrop) {
        // Split the scene pass: resolve what is painted so far, snapshot it,
        // (for background blur) blur it, then resume and composite.
        pass.end()
        encoder.copyTextureToTexture(
          { texture: this.resolveTex! },
          { texture: this.backdropTex! },
          [dw, dh],
        )
        if (seg.mode === 1) {
          const f = this.frameFx.get(i)
          if (f) {
            let bgs = this.frameFxBindGroups.get(i)
            if (!bgs) {
              bgs = {
                h: this.blurBindGroup(f.uH, this.backdropTex!, this.dummyTex),
                v: this.blurBindGroup(f.uV, this.pingA!, this.dummyTex),
              }
              this.frameFxBindGroups.set(i, bgs)
            }
            this.blurPass(encoder, bgs.h, this.pingA!)
            this.blurPass(encoder, bgs.v, this.pingB!)
          }
        }
        pass = beginScene(false)
        this.applyScissorTo(pass, ctx)
      }
      this.drawSeg(pass, seg, ctx)
    }
    this.lastTimings.loop = performance.now() - tLoop
    const tEnd = performance.now()
    pass.end()

    // Final blit: intermediate resolve target -> canvas.
    if (!this.blitBindGroup) {
      this.blitBindGroup = this.device.createBindGroup({
        layout: this.blitLayout,
        entries: [
          { binding: 0, resource: { buffer: this.blitUniform } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.resolveTex!.createView() },
        ],
      })
    }
    const blitPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: currentTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    blitPass.setPipeline(this.blitPipeline)
    blitPass.setBindGroup(0, this.blitBindGroup)
    blitPass.draw(3)
    blitPass.end()
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
