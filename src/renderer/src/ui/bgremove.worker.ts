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

const INPUT_SIZE = 1024

let session: ort.InferenceSession | null = null
let epUsed = ''

async function init(model: ArrayBuffer, ortMjs: ArrayBuffer, ortWasm: ArrayBuffer): Promise<string> {
  // Packaged renderers cannot fetch file:// — hand ort its runtime via blob URLs.
  ort.env.wasm.wasmPaths = {
    mjs: URL.createObjectURL(new Blob([ortMjs], { type: 'text/javascript' })),
    wasm: URL.createObjectURL(new Blob([ortWasm], { type: 'application/wasm' })),
  }
  // Multi-threaded wasm needs SharedArrayBuffer (Electron exposes it in
  // some contexts; browsers need crossOriginIsolated) — probe, don't assume.
  const threads =
    typeof SharedArrayBuffer !== 'undefined'
      ? Math.min(4, Math.max(1, (self.navigator?.hardwareConcurrency ?? 2) - 1))
      : 1
  ort.env.wasm.numThreads = threads
  ort.env.wasm.proxy = false
  console.info(`[polyform] bgremove: wasm threads=${threads}`)
  for (const ep of ['webgpu', 'wasm'] as const) {
    try {
      session = await ort.InferenceSession.create(model, { executionProviders: [ep] })
      epUsed = ep
      return ep
    } catch (err) {
      console.warn(`[polyform] bgremove: ${ep} EP unavailable`, err)
    }
  }
  throw new Error('no ONNX execution provider available')
}

/** ISNet preprocessing (rembg-compatible): stretch to 1024², /255, −0.5. */
function preprocess(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): ort.Tensor {
  const src = new OffscreenCanvas(width, height)
  src.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0)
  const dst = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE)
  const ctx = dst.getContext('2d')!
  ctx.drawImage(src, 0, 0, INPUT_SIZE, INPUT_SIZE)
  const data = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data
  const n = INPUT_SIZE * INPUT_SIZE
  const input = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    input[i] = data[i * 4] / 255 - 0.5
    input[n + i] = data[i * 4 + 1] / 255 - 0.5
    input[2 * n + i] = data[i * 4 + 2] / 255 - 0.5
  }
  return new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE])
}

/** Min-max normalize the matte (rembg post-processing). */
function matteToImageData(matte: Float32Array): ImageData {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < matte.length; i++) {
    if (matte[i] < min) min = matte[i]
    if (matte[i] > max) max = matte[i]
  }
  const range = Math.max(1e-6, max - min)
  const img = new ImageData(INPUT_SIZE, INPUT_SIZE)
  for (let i = 0; i < matte.length; i++) {
    const a = Math.round(((matte[i] - min) / range) * 255)
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
  const feeds: Record<string, ort.Tensor> = { [session.inputNames[0]]: input }
  const results = await session.run(feeds)
  const out = results[session.outputNames[0]]
  const matte = out.data as Float32Array

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
    | { kind: 'init'; model: ArrayBuffer; ortMjs: ArrayBuffer; ortWasm: ArrayBuffer }
    | { kind: 'run'; id: number; width: number; height: number; pixels: ArrayBuffer }
  if (msg.kind === 'init') {
    init(msg.model, msg.ortMjs, msg.ortWasm)
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
