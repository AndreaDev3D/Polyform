// Background-removal model manager (v0.4.1, ADR-019). The ISNet model is
// NOT bundled — it downloads once on explicit user consent (~170 MB from
// the pinned rembg release), verifies against a pinned SHA-256, and lives
// in userData/models. Fully offline afterwards. onnxruntime-web's wasm/mjs
// runtime files ARE shipped with the app (node_modules in dev, resources
// in packaged builds) and are read here because packaged renderers cannot
// fetch file:// assets (ADR-015 lesson).

import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs, createWriteStream } from 'node:fs'
import path from 'node:path'

// BiRefNet_lite replaced ISNet after real-image acceptance showed ISNet's
// mattes too aggressive/imprecise (ADR-019 second amendment) — BiRefNet is
// the MIT-licensed architecture RMBG-2.0 builds on. fp32 for EP-universal
// correctness; a self-produced fp16/quantized artifact is the slimming path.
// Why THIS artifact (measured 2026-08-02, ADR-019): BiRefNet_lite@1024 is
// unrunnable in onnxruntime-web on Windows today — the WebGPU EP needs 11
// storage buffers/stage against Dawn's adapter max of 10, and wasm32 hits
// std::bad_alloc at 1024² activations (shared or not, arena on or off).
// The full BiRefNet at 512² input fits the wasm memory ceiling; fp16 file
// halves the download.
export const BG_MODEL = {
  name: 'birefnet_512_fp16.onnx',
  url: 'https://huggingface.co/onnx-community/BiRefNet_512x512-ONNX/resolve/main/onnx/model_fp16.onnx',
  sha256: '1b254749feb1edf83667a4c9da710cc1962a1980b8d0b2f4432100278c9ac0af',
  sizeMB: 473,
  inputSize: 512,
  license: 'MIT (BiRefNet, onnx-community export)',
}

/** Superseded model files cleaned from userData on ensure(). */
const OBSOLETE_MODELS = ['isnet-general-use.onnx', 'birefnet_lite_fp32.onnx']

function modelPath(): string {
  // Test/dev override so harnesses can point at a pre-downloaded file.
  const override = process.env.POLYFORM_BGMODEL_PATH
  if (override) return override
  return path.join(app.getPath('userData'), 'models', BG_MODEL.name)
}

async function sha256File(file: string): Promise<string> {
  const bytes = await fs.readFile(file)
  return createHash('sha256').update(bytes).digest('hex')
}

let verifiedThisSession = false

export async function bgModelStatus(): Promise<{ ready: boolean; sizeMB: number; inputSize: number }> {
  try {
    await fs.access(modelPath())
    return { ready: true, sizeMB: BG_MODEL.sizeMB, inputSize: BG_MODEL.inputSize }
  } catch {
    return { ready: false, sizeMB: BG_MODEL.sizeMB, inputSize: BG_MODEL.inputSize }
  }
}

/**
 * Download + verify the model (idempotent). Progress is reported via the
 * callback as bytes received / total. Rejects with a message on failure;
 * a hash mismatch deletes the download.
 */
export async function bgModelEnsure(
  onProgress: (received: number, total: number) => void,
): Promise<{ ok: boolean; error?: string }> {
  const target = modelPath()
  if ((await bgModelStatus()).ready) return { ok: true }
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })
  for (const stale of OBSOLETE_MODELS) {
    await fs.rm(path.join(dir, stale), { force: true }).catch(() => {})
  }
  const tmp = `${target}.download`
  try {
    const response = await net.fetch(BG_MODEL.url)
    if (!response.ok || !response.body) {
      return { ok: false, error: `download failed: HTTP ${response.status}` }
    }
    const total = Number(response.headers.get('content-length') ?? 0)
    const hash = createHash('sha256')
    const out = createWriteStream(tmp)
    let received = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.byteLength
      onProgress(received, total)
      await new Promise<void>((resolve, reject) => {
        out.write(value, (err) => (err ? reject(err) : resolve()))
      })
    }
    await new Promise<void>((resolve, reject) => out.end((err: unknown) => (err ? reject(err) : resolve())))
    const digest = hash.digest('hex')
    if (digest !== BG_MODEL.sha256) {
      await fs.rm(tmp, { force: true })
      return { ok: false, error: `checksum mismatch (got ${digest.slice(0, 12)}…)` }
    }
    await fs.rename(tmp, target)
    verifiedThisSession = true
    return { ok: true }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: String(err) }
  }
}

/** Model bytes for the renderer (verified once per session). */
export async function bgModelRead(): Promise<Uint8Array | null> {
  try {
    const target = modelPath()
    if (!verifiedThisSession && !process.env.POLYFORM_BGMODEL_PATH) {
      if ((await sha256File(target)) !== BG_MODEL.sha256) {
        await fs.rm(target, { force: true })
        return null
      }
      verifiedThisSession = true
    }
    return new Uint8Array(await fs.readFile(target))
  } catch {
    return null
  }
}

/**
 * onnxruntime-web runtime files (.mjs + .wasm). ort 1.27's webgpu bundle
 * requests the ASYNCIFY build (which carries both the wasm CPU EP and
 * `webgpuInit` — the jsep build is the pre-1.2x era and lacks it). The
 * renderer turns these into blob: URLs for ort's wasmPaths — fetch() of
 * packaged file:// paths would fail.
 */
export async function bgOrtRuntimeRead(): Promise<{ mjs: Uint8Array; wasm: Uint8Array } | null> {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', 'onnxruntime-web', 'dist'),
    path.join(process.resourcesPath ?? '', 'onnxruntime-web'),
  ]
  for (const dir of candidates) {
    try {
      const mjs = await fs.readFile(path.join(dir, 'ort-wasm-simd-threaded.asyncify.mjs'))
      const wasm = await fs.readFile(path.join(dir, 'ort-wasm-simd-threaded.asyncify.wasm'))
      return { mjs: new Uint8Array(mjs), wasm: new Uint8Array(wasm) }
    } catch {
      // try next candidate
    }
  }
  return null
}
