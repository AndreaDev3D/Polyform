// Remove Background service (v0.4.1, ADR-019): consent-gated one-time
// model download, worker-hosted ISNet inference, and a NON-DESTRUCTIVE
// asset swap — the cutout becomes a new SHA-256 asset, the original stays
// in the bundle, and the whole thing is one journal entry either way.

import { documentStore } from '../state/document'
import { assetCache } from '../engine/assets'
import type { ImagePaint, NodeId, Paint } from '../engine/types'

export type BgRemoveState =
  | { phase: 'idle' }
  | { phase: 'downloading'; pct: number }
  | { phase: 'loading' }
  | { phase: 'running' }
  | { phase: 'error'; message: string }

let state: BgRemoveState = { phase: 'idle' }
const listeners = new Set<() => void>()

export function bgRemoveState(): BgRemoveState {
  return state
}

export function onBgRemoveState(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function setState(next: BgRemoveState): void {
  state = next
  for (const cb of listeners) cb()
}

let worker: Worker | null = null
let workerReady: Promise<string> | null = null
let runId = 0
/** 0 = auto (threaded when SharedArrayBuffer exists); 1 after a bad_alloc —
 * threaded wasm's shared-memory ceiling can't fit large models. */
let maxThreads = 0

function resetWorker(): void {
  worker?.terminate()
  worker = null
  workerReady = null
}

function ensureWorker(): Promise<string> {
  if (workerReady) return workerReady
  workerReady = (async () => {
    const [model, ortRuntime, status] = await Promise.all([
      window.polyform.bgModelRead(),
      window.polyform.bgOrtRuntime(),
      window.polyform.bgModelStatus(),
    ])
    if (!model) throw new Error('model unavailable (re-download required)')
    if (!ortRuntime) throw new Error('onnxruntime runtime files not found')
    worker = new Worker(new URL('./bgremove.worker.ts', import.meta.url), { type: 'module' })
    const toBuf = (u8: Uint8Array): ArrayBuffer =>
      u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
    const modelBuf = toBuf(model)
    const mjsBuf = toBuf(ortRuntime.mjs)
    const wasmBuf = toBuf(ortRuntime.wasm)
    return new Promise<string>((resolve, reject) => {
      const w = worker!
      const onMsg = (e: MessageEvent) => {
        if (e.data?.kind === 'ready') {
          w.removeEventListener('message', onMsg)
          console.info(`[polyform] bgremove ready (execution provider: ${e.data.ep})`)
          resolve(e.data.ep as string)
        } else if (e.data?.kind === 'error') {
          w.removeEventListener('message', onMsg)
          reject(new Error(e.data.message))
        }
      }
      w.addEventListener('message', onMsg)
      w.postMessage(
        {
          kind: 'init',
          model: modelBuf,
          ortMjs: mjsBuf,
          ortWasm: wasmBuf,
          maxThreads,
          inputSize: status.inputSize ?? 1024,
        },
        [modelBuf, mjsBuf, wasmBuf],
      )
    })
  })()
  workerReady.catch(() => resetWorker())
  return workerReady
}

/** Consent + download if the model is missing. Returns false on decline/failure. */
async function ensureModel(): Promise<boolean> {
  const status = await window.polyform.bgModelStatus()
  if (status.ready) return true
  const ok = window.confirm(
    `Remove Background uses an on-device AI model (ISNet, Apache-2.0).\n\n` +
      `Polyform will download it once (~${status.sizeMB} MB), store it locally, ` +
      `and the feature works fully offline afterwards. Nothing about your ` +
      `document ever leaves this machine.\n\nDownload now?`,
  )
  if (!ok) return false
  setState({ phase: 'downloading', pct: 0 })
  const offProgress = window.polyform.onBgModelProgress((received, total) => {
    setState({ phase: 'downloading', pct: total > 0 ? Math.round((received / total) * 100) : 0 })
  })
  try {
    const result = await window.polyform.bgModelEnsure()
    if (!result.ok) {
      setState({ phase: 'error', message: result.error ?? 'download failed' })
      return false
    }
    return true
  } finally {
    offProgress()
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Hard ceiling per inference — a hung GPU/driver path must not spin
 * forever. Generous because large models on single-thread CPU are slow. */
const RUN_TIMEOUT_MS = 300_000

function runOnce(
  width: number,
  height: number,
  pixels: ArrayBuffer,
): Promise<{ png: ArrayBuffer; ms: number; ep: string }> {
  const id = ++runId
  return new Promise((resolve, reject) => {
    const w = worker!
    const timer = setTimeout(() => {
      w.removeEventListener('message', onMsg)
      // Kill the wedged worker; the next attempt re-initializes cleanly.
      resetWorker()
      reject(new Error(`inference timed out after ${RUN_TIMEOUT_MS / 1000}s — try again`))
    }, RUN_TIMEOUT_MS)
    const onMsg = (e: MessageEvent) => {
      if (e.data?.id !== id) return
      clearTimeout(timer)
      w.removeEventListener('message', onMsg)
      if (e.data.kind === 'result') resolve({ png: e.data.png, ms: e.data.ms, ep: e.data.ep })
      else reject(new Error(e.data.message))
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ kind: 'run', id, width, height, pixels }, [pixels])
  })
}

/** Run inference on RGBA pixels; resolves to PNG bytes. Exported for the harness. */
export async function runBgInference(
  width: number,
  height: number,
  pixels: ArrayBuffer,
): Promise<{ png: ArrayBuffer; ms: number; ep: string }> {
  await ensureWorker()
  // pixels transfers to the worker — keep a copy in case a retry is needed.
  const backup = maxThreads !== 1 ? pixels.slice(0) : null
  try {
    return await runOnce(width, height, pixels)
  } catch (err) {
    // Threaded wasm shared memory can't fit large models: retry once on a
    // fresh single-threaded worker.
    if (backup && /bad_alloc|out of memory/i.test(String(err))) {
      console.warn('[polyform] bgremove: allocation failure — retrying single-threaded')
      maxThreads = 1
      resetWorker()
      await ensureWorker()
      return runOnce(width, height, backup)
    }
    throw err
  }
}

/**
 * Remove the background of an IMAGE fill. Non-destructive: writes the
 * cutout as a new asset and swaps `assetHash`, remembering the original.
 */
export async function removeBackground(nodeId: NodeId, fillIndex: number): Promise<void> {
  if (state.phase === 'downloading' || state.phase === 'running' || state.phase === 'loading') return
  try {
    const scene = documentStore.scene
    const node = scene.getNode(nodeId)
    if (!node) return
    const paint = node.fills[fillIndex]
    if (!paint || paint.type !== 'IMAGE') return

    // On decline the state was never left idle; on failure it is 'error'.
    if (!(await ensureModel())) return
    setState({ phase: 'loading' })
    await ensureWorker()

    // Source pixels from the bundle asset (not the on-canvas crop/adjust —
    // those keep applying to the cutout unchanged).
    const asset = await window.polyform.assetsRead(paint.assetHash)
    if (!asset) throw new Error('source asset missing')
    const buf = asset.bytes.buffer.slice(
      asset.bytes.byteOffset,
      asset.bytes.byteOffset + asset.bytes.byteLength,
    ) as ArrayBuffer
    const bitmap = await createImageBitmap(new Blob([buf], { type: asset.mime }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)

    setState({ phase: 'running' })
    const { png, ms, ep } = await runBgInference(
      bitmap.width,
      bitmap.height,
      imageData.data.buffer as ArrayBuffer,
    )
    console.info(`[polyform] bgremove: ${bitmap.width}x${bitmap.height} in ${ms.toFixed(0)}ms (${ep})`)

    const hash = await sha256Hex(png)
    const written = await window.polyform.assetsWrite(new Uint8Array(png), 'png')
    if (!written) throw new Error('failed to write cutout asset')
    await assetCache.primeFromBytes(written.hash, new Uint8Array(png), 'image/png')

    // Re-read the LIVE fill (an edit may have landed during inference).
    const live = scene.getNode(nodeId)
    const livePaint = live?.fills[fillIndex]
    if (!live || !livePaint || livePaint.type !== 'IMAGE') throw new Error('fill changed during processing')
    const before = structuredClone(live.fills) as Paint[]
    const after = structuredClone(live.fills) as Paint[]
    const target = after[fillIndex] as ImagePaint
    target.originalAssetHash = target.originalAssetHash ?? target.assetHash
    target.assetHash = written.hash
    scene.updateNode(nodeId, { fills: after })
    documentStore.commit(
      [{ kind: 'update', id: nodeId, before: { fills: before }, after: { fills: after } }],
      'Remove Background',
      true,
    )
    setState({ phase: 'idle' })
  } catch (err) {
    console.warn('[polyform] remove background failed:', err)
    setState({ phase: 'error', message: String(err instanceof Error ? err.message : err) })
  }
}

/** Swap an image fill back to its pre-cutout asset (hash swap, journaled). */
export function restoreOriginal(nodeId: NodeId, fillIndex: number): void {
  const scene = documentStore.scene
  const node = scene.getNode(nodeId)
  if (!node) return
  const paint = node.fills[fillIndex]
  if (!paint || paint.type !== 'IMAGE' || !paint.originalAssetHash) return
  const before = structuredClone(node.fills) as Paint[]
  const after = structuredClone(node.fills) as Paint[]
  const target = after[fillIndex] as ImagePaint
  target.assetHash = target.originalAssetHash!
  delete target.originalAssetHash
  scene.updateNode(nodeId, { fills: after })
  documentStore.commit(
    [{ kind: 'update', id: nodeId, before: { fills: before }, after: { fills: after } }],
    'Restore Original Image',
    true,
  )
}
