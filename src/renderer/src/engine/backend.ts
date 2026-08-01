// Per-module engine backend switch (ADR-002, docs/V0.4-Porting-Plan.md).
// Rust/WASM implementations replace TS module internals behind unchanged
// function signatures; a flag decides per module. Modules without a flag
// (geometry) have Rust ports proven equivalent by the parity suite but no
// runtime dispatch yet: crossing the WASM boundary per tiny math call costs
// more than the math itself — they flip when a batch consumer (booleans,
// hit-test) moves to Rust in Sprint B/C.
//
// Loading strategy: the .wasm binary is inlined into the bundle as base64
// (packaged Electron renderers load from file:// where fetch() of assets is
// blocked) and instantiated asynchronously (Chromium forbids synchronous
// compilation of modules > 4KB on the main thread). Until init resolves —
// or if it fails — every consumer stays on the TS implementation.

type WasmModule = typeof import('./wasm/pkg/polyform_core')

export type SwitchableModule = 'shapes' | 'spatial'
export type BackendKind = 'ts' | 'wasm'

// Defaults per the Sprint A benchmarks (docs/V0.4-Porting-Plan.md):
// - shapes: TS. Per-call encode/decode across the boundary outweighs the
//   Rust win for single-path calls; flips with Sprint B's batch consumers.
// - spatial: WASM. rstar bulk-load + query beats rbush and the win grows
//   with node count.
const flags: Record<SwitchableModule, BackendKind> = {
  shapes: 'ts',
  spatial: 'wasm',
}

const STORAGE_KEY = 'polyform.engineBackends'

let mod: WasmModule | null = null
let initPromise: Promise<boolean> | null = null

export function wasmReady(): boolean {
  return mod !== null
}

/** True when `m` should route to the WASM implementation right now. */
export function useWasm(m: SwitchableModule): boolean {
  return mod !== null && flags[m] === 'wasm'
}

/** The loaded WASM module. Only call behind a `useWasm()` / `wasmReady()` check. */
export function wasmHandle(): WasmModule {
  if (!mod) throw new Error('WASM engine not initialized')
  return mod
}

export function setEngineBackend(m: SwitchableModule, kind: BackendKind): void {
  flags[m] = kind
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(flags))
    }
  } catch {
    // storage unavailable (tests, private mode) — session-only switch
  }
}

export function getEngineBackends(): Record<SwitchableModule, BackendKind> & {
  wasmLoaded: boolean
} {
  return { ...flags, wasmLoaded: mod !== null }
}

function readStoredOverrides(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<Record<SwitchableModule, BackendKind>>
    for (const k of ['shapes', 'spatial'] as const) {
      const v = parsed[k]
      if (v === 'ts' || v === 'wasm') flags[k] = v
    }
  } catch {
    // ignore malformed overrides
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Load and instantiate the WASM engine. Idempotent; resolves false (and
 * leaves all backends on TS) if loading fails. Tests pass the wasm `bytes`
 * directly; the renderer decodes the inlined asset.
 */
export function initWasmEngine(bytes?: BufferSource): Promise<boolean> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const pkg = await import('./wasm/pkg/polyform_core.js')
      if (bytes) {
        pkg.initSync({ module: bytes })
      } else {
        const dataUri = (await import('./wasm/pkg/polyform_core_bg.wasm?inline')).default
        const bin = base64ToBytes(dataUri.slice(dataUri.indexOf(',') + 1))
        await pkg.default({ module_or_path: bin })
      }
      mod = pkg
      readStoredOverrides()
      console.info('[polyform] WASM engine core initialized', getEngineBackends())
      // Dev convenience: flip backends from the console, e.g.
      //   __polyformEngine.setBackend('spatial', 'ts')
      ;(globalThis as Record<string, unknown>).__polyformEngine = {
        setBackend: setEngineBackend,
        backends: getEngineBackends,
      }
      return true
    } catch (err) {
      console.warn('[polyform] WASM engine unavailable — staying on TS backends.', err)
      return false
    }
  })()
  return initPromise
}
