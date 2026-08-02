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

export const BG_MODEL = {
  name: 'isnet-general-use.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
  sizeMB: 171,
  license: 'Apache-2.0 (ISNet/DIS weights, rembg release artifact)',
}

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

export async function bgModelStatus(): Promise<{ ready: boolean; sizeMB: number }> {
  try {
    await fs.access(modelPath())
    return { ready: true, sizeMB: BG_MODEL.sizeMB }
  } catch {
    return { ready: false, sizeMB: BG_MODEL.sizeMB }
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
 * onnxruntime-web runtime files (.mjs + .wasm, jsep build for the WebGPU
 * EP). The renderer turns these into blob: URLs for ort's wasmPaths —
 * fetch() of packaged file:// paths would fail.
 */
export async function bgOrtRuntimeRead(): Promise<{ mjs: Uint8Array; wasm: Uint8Array } | null> {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', 'onnxruntime-web', 'dist'),
    path.join(process.resourcesPath ?? '', 'onnxruntime-web'),
  ]
  for (const dir of candidates) {
    try {
      const mjs = await fs.readFile(path.join(dir, 'ort-wasm-simd-threaded.jsep.mjs'))
      const wasm = await fs.readFile(path.join(dir, 'ort-wasm-simd-threaded.jsep.wasm'))
      return { mjs: new Uint8Array(mjs), wasm: new Uint8Array(wasm) }
    } catch {
      // try next candidate
    }
  }
  return null
}
