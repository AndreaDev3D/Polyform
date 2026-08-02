// Background-removal inference worker (v0.4.1, ADR-019): ISNet on
// onnxruntime-web — WebGPU execution provider when available, WASM EP as
// the universal fallback. Everything heavy happens here: preprocessing
// (1024² resize + normalize), inference, matte upscale, alpha compositing
// and PNG encode. The main thread only orchestrates.
//
// Protocol:
//   -> { kind: 'init', model, ortMjs, ortWasm }   (ArrayBuffers)
//   <- { kind: 'ready', ep: 'webgpu' | 'wasm' }
//   -> { kind: 'run', id, width, height, pixels } (RGBA ArrayBuffer)
//   <- { kind: 'result', id, png }  |  { kind: 'error', id?, message }

import * as ort from 'onnxruntime-web/webgpu'

let INPUT_SIZE = 1024

// Session attempts, best first. Some models trip RUN-time WebGPU limits
// (e.g. BiRefNet's fused kernels exceeding maxStorageBuffersPerShaderStage)
// — lower graph-optimization levels fuse less, so each failed RUN advances
// one rung and retries before surrendering to wasm.
// NOTE: no webgpu/disabled rung — unfused graphs make the WebGPU EP compile
// shaders for minutes (looks like a hang) instead of failing fast.
const ATTEMPTS: { ep: 'webgpu' | 'wasm'; opt: 'all' | 'basic' | 'disabled' }[] = [
  { ep: 'webgpu', opt: 'all' },
  { ep: 'webgpu', opt: 'basic' },
  { ep: 'wasm', opt: 'all' },
]

let session: ort.InferenceSession | null = null
let modelBytes: ArrayBuffer | null = null
let attemptIndex = 0
let epUsed = ''

async function createSession(fromIndex: number): Promise<void> {
  for (let i = fromIndex; i < ATTEMPTS.length; i++) {
    const a = ATTEMPTS[i]
    try {
      session = await ort.InferenceSession.create(modelBytes!, {
        executionProviders: [a.ep],
        graphOptimizationLevel: a.opt,
        // wasm32 has a hard 4 GB ceiling and the CPU arena preallocates
        // greedily — large models fit only with arena/mem-pattern off.
        ...(a.ep === 'wasm' ? { enableCpuMemArena: false, enableMemPattern: false } : {}),
      })
      attemptIndex = i
      epUsed = a.opt === 'all' ? a.ep : `${a.ep}(opt:${a.opt})`
      return
    } catch (err) {
      console.warn(`[polyform] bgremove: session ${a.ep}/${a.opt} failed`, err)
    }
  }
  throw new Error('no ONNX execution provider available')
}

async function init(
  model: ArrayBuffer,
  ortMjs: ArrayBuffer,
  ortWasm: ArrayBuffer,
  maxThreads: number,
  inputSize: number,
): Promise<string> {
  if (inputSize > 0) INPUT_SIZE = inputSize
  // Packaged renderers cannot fetch file:// — hand ort its runtime via blob URLs.
  ort.env.wasm.wasmPaths = {
    mjs: URL.createObjectURL(new Blob([ortMjs], { type: 'text/javascript' })),
    wasm: URL.createObjectURL(new Blob([ortWasm], { type: 'application/wasm' })),
  }
  // Multi-threaded wasm needs SharedArrayBuffer (the main process enables
  // Chromium's SAB feature) — but threaded runs use SHARED wasm memory with
  // a tighter growth ceiling, which big models can blow (std::bad_alloc).
  // The service retries with maxThreads=1 on allocation failure; thread
  // count is fixed per worker lifetime (env is read at backend init).
  const auto =
    typeof SharedArrayBuffer !== 'undefined'
      ? Math.min(4, Math.max(1, (self.navigator?.hardwareConcurrency ?? 2) - 1))
      : 1
  const threads = maxThreads > 0 ? Math.min(maxThreads, auto) : auto
  ort.env.wasm.numThreads = threads
  ort.env.wasm.proxy = false
  console.info(`[polyform] bgremove: wasm threads=${threads}`)
  // ORT's own device request uses DEFAULT WebGPU limits (10 storage
  // buffers/stage) — BiRefNet-class kernels need 11+. Adapters usually
  // offer far more: pre-create a device at adapter-max and hand it to ort.
  try {
    const adapter = await (self.navigator as Navigator).gpu?.requestAdapter()
    if (adapter) {
      const lim = adapter.limits.maxStorageBuffersPerShaderStage
      console.info(`[polyform] bgremove: adapter maxStorageBuffersPerShaderStage=${lim}`)
      if (lim > 10) {
        const device = await adapter.requestDevice({
          requiredLimits: {
            maxStorageBuffersPerShaderStage: lim,
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxBufferSize: adapter.limits.maxBufferSize,
          },
        })
        ;(ort.env.webgpu as unknown as Record<string, unknown>).device = device
        console.info('[polyform] bgremove: injected raised-limits WebGPU device')
      }
    }
  } catch (err) {
    console.warn('[polyform] bgremove: device-limit probe failed (using ort defaults)', err)
  }
  modelBytes = model
  await createSession(0)
  return epUsed
}

/** BiRefNet preprocessing: stretch to 1024², /255, ImageNet mean/std. */
function preprocess(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): ort.Tensor {
  const src = new OffscreenCanvas(width, height)
  src.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0)
  const dst = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE)
  const ctx = dst.getContext('2d')!
  ctx.drawImage(src, 0, 0, INPUT_SIZE, INPUT_SIZE)
  const data = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data
  const n = INPUT_SIZE * INPUT_SIZE
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  const input = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    input[i] = (data[i * 4] / 255 - mean[0]) / std[0]
    input[n + i] = (data[i * 4 + 1] / 255 - mean[1]) / std[1]
    input[2 * n + i] = (data[i * 4 + 2] / 255 - mean[2]) / std[2]
  }
  return new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE])
}

/**
 * Matte to alpha: sigmoid when the model emits logits (values outside
 * [0,1]), then min-max stretch (no-op on already-saturated mattes).
 */
function matteToImageData(matte: ArrayLike<number>): ImageData {
  const n = matte.length
  const values = new Float32Array(n)
  let rawMin = Infinity
  let rawMax = -Infinity
  for (let i = 0; i < n; i++) {
    const v = matte[i]
    if (v < rawMin) rawMin = v
    if (v > rawMax) rawMax = v
  }
  const logits = rawMin < -0.01 || rawMax > 1.01
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    const v = logits ? 1 / (1 + Math.exp(-matte[i])) : matte[i]
    values[i] = v
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = Math.max(1e-6, max - min)
  const img = new ImageData(INPUT_SIZE, INPUT_SIZE)
  for (let i = 0; i < n; i++) {
    const a = Math.round(((values[i] - min) / range) * 255)
    img.data[i * 4] = 255
    img.data[i * 4 + 1] = 255
    img.data[i * 4 + 2] = 255
    img.data[i * 4 + 3] = a
  }
  return img
}

async function run(width: number, height: number, pixels: ArrayBuffer): Promise<ArrayBuffer> {
  if (!session) throw new Error('worker not initialized')
  const rgba = new Uint8ClampedArray(pixels)
  const input = preprocess(rgba, width, height)
  let results: Awaited<ReturnType<ort.InferenceSession['run']>> | null = null
  for (;;) {
    try {
      const feeds: Record<string, ort.Tensor> = { [session.inputNames[0]]: input }
      results = await session.run(feeds)
      break
    } catch (err) {
      // Run-time EP failure (device limits etc.) — degrade one rung.
      if (attemptIndex + 1 >= ATTEMPTS.length) throw err
      console.warn(`[polyform] bgremove: run failed on ${epUsed}, degrading`, err)
      await createSession(attemptIndex + 1)
      console.info(`[polyform] bgremove: retrying on ${epUsed}`)
    }
  }
  const out = results[session.outputNames[0]]
  const matte = out.data as unknown as ArrayLike<number>

  // Upscale the matte to source size (canvas bilinear via alpha channel).
  const matteCanvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE)
  matteCanvas.getContext('2d')!.putImageData(matteToImageData(matte), 0, 0)
  const maskCanvas = new OffscreenCanvas(width, height)
  const maskCtx = maskCanvas.getContext('2d')!
  maskCtx.drawImage(matteCanvas, 0, 0, width, height)
  const mask = maskCtx.getImageData(0, 0, width, height).data

  // Apply: keep source RGB, alpha = matte × original alpha.
  const outImg = new ImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    outImg.data[i * 4] = rgba[i * 4]
    outImg.data[i * 4 + 1] = rgba[i * 4 + 1]
    outImg.data[i * 4 + 2] = rgba[i * 4 + 2]
    outImg.data[i * 4 + 3] = Math.round((mask[i * 4 + 3] * rgba[i * 4 + 3]) / 255)
  }
  const outCanvas = new OffscreenCanvas(width, height)
  outCanvas.getContext('2d')!.putImageData(outImg, 0, 0)
  const blob = await outCanvas.convertToBlob({ type: 'image/png' })
  return blob.arrayBuffer()
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as
    | {
        kind: 'init'
        model: ArrayBuffer
        ortMjs: ArrayBuffer
        ortWasm: ArrayBuffer
        maxThreads: number
        inputSize: number
      }
    | { kind: 'run'; id: number; width: number; height: number; pixels: ArrayBuffer }
  if (msg.kind === 'init') {
    init(msg.model, msg.ortMjs, msg.ortWasm, msg.maxThreads, msg.inputSize)
      .then((ep) => self.postMessage({ kind: 'ready', ep }))
      .catch((err) => self.postMessage({ kind: 'error', message: String(err) }))
  } else if (msg.kind === 'run') {
    const t0 = performance.now()
    run(msg.width, msg.height, msg.pixels)
      .then((png) => {
        self.postMessage(
          { kind: 'result', id: msg.id, png, ms: performance.now() - t0, ep: epUsed },
          { transfer: [png] },
        )
      })
      .catch((err) => self.postMessage({ kind: 'error', id: msg.id, message: String(err) }))
  }
}
