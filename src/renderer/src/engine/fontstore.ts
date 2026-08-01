// Font byte registry for the shaped text stack (Sprint E). DOM-free: the
// renderer-side loader (ui/fontloader.ts) feeds it bytes obtained from
// queryLocalFonts().blob(); tests feed it bytes read from disk. Fonts load
// into the WASM engine (rustybuzz) and are addressed by id thereafter.
//
// Missing fonts are RECORDED and requested asynchronously — layoutText
// falls back to the Canvas2D path per node until the bytes arrive, then
// `onFontsChanged` listeners re-derive and repaint.

import { wasmHandle, wasmReady } from './backend'

export interface FontMetricsInfo {
  unitsPerEm: number
  ascender: number
  descender: number
  lineGap: number
}

export interface FontEntry {
  id: number
  metrics: FontMetricsInfo
}

const fonts = new Map<string, FontEntry>()
const familyFallback = new Map<string, FontEntry>()
const requested = new Set<string>()
let requestListener: ((family: string, weight: number, italic: boolean) => void) | null = null
const changeListeners = new Set<() => void>()

export function fontKey(family: string, weight: number, italic: boolean): string {
  return `${family}|${weight}|${italic ? 1 : 0}`
}

/**
 * Load font bytes into the engine under (family, weight, italic). Returns
 * false when the face fails to parse or the WASM engine is unavailable.
 */
export function registerFontBytes(
  family: string,
  weight: number,
  italic: boolean,
  bytes: Uint8Array,
): boolean {
  if (!wasmReady()) return false
  const id = wasmHandle().loadFont(bytes)
  if (id < 0) return false
  let metrics: FontMetricsInfo
  try {
    metrics = JSON.parse(wasmHandle().fontMetricsJson(id)) as FontMetricsInfo
    if (!metrics || !(metrics.unitsPerEm > 0)) return false
  } catch {
    return false
  }
  const entry: FontEntry = { id, metrics }
  fonts.set(fontKey(family, weight, italic), entry)
  if (!familyFallback.has(family)) familyFallback.set(family, entry)
  for (const cb of changeListeners) cb()
  return true
}

/**
 * Resolve a font for layout: exact (family, weight, italic) match, else any
 * loaded face of the family. A miss records the request (once) and fires
 * the async loader, returning null — callers fall back to the legacy path.
 */
export function fontEntryFor(family: string, weight: number, italic: boolean): FontEntry | null {
  const exact = fonts.get(fontKey(family, weight, italic))
  if (exact) return exact
  const fallback = familyFallback.get(family)
  if (fallback) return fallback
  const key = fontKey(family, weight, italic)
  if (!requested.has(key)) {
    requested.add(key)
    requestListener?.(family, weight, italic)
  }
  return null
}

/** Renderer-side loader hook; replays already-missed requests on install. */
export function setFontRequestListener(
  cb: ((family: string, weight: number, italic: boolean) => void) | null,
): void {
  requestListener = cb
  if (cb) {
    for (const key of requested) {
      const [family, weight, italic] = key.split('|')
      cb(family, Number(weight), italic === '1')
    }
  }
}

export function onFontsChanged(cb: () => void): () => void {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}

/** Loaded state for diagnostics / tests. */
export function loadedFontKeys(): string[] {
  return [...fonts.keys()]
}
