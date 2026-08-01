// Renderer-side font byte loader for the shaped text stack (Sprint E):
// resolves engine font requests against Chromium's Local Font Access API.
// queryLocalFonts() FontData exposes blob() with the raw font file — no
// native module needed. When the requested family isn't installed, common
// fallbacks register UNDER THE REQUESTED KEY, mirroring how the browser's
// own font matching silently substituted in the legacy fillText path.

import { registerFontBytes, setFontRequestListener } from '../engine/fontstore'
import type { LocalFontData } from '../engine/fonts'

const FALLBACK_FAMILIES = ['Arial', 'Segoe UI', 'Helvetica', 'DejaVu Sans', 'Liberation Sans']

let allFonts: Promise<LocalFontData[]> | null = null

function queryAll(): Promise<LocalFontData[]> {
  if (!allFonts) {
    allFonts = (async () => {
      try {
        if (typeof window.queryLocalFonts === 'function') {
          return await window.queryLocalFonts()
        }
      } catch {
        // Permission denied / unavailable — shaped text stays off.
      }
      return []
    })()
  }
  return allFonts
}

const WEIGHT_NAMES: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/light/i, 300],
  [/medium/i, 500],
  [/black|heavy/i, 900],
  [/bold/i, 700],
]

function styleWeight(style: string): number {
  for (const [re, w] of WEIGHT_NAMES) {
    if (re.test(style)) return w
  }
  return 400
}

function styleScore(style: string, weight: number, italic: boolean): number {
  const isItalic = /italic|oblique/i.test(style)
  let score = -Math.abs(styleWeight(style) - weight) / 100
  if (isItalic !== italic) score -= 5
  return score
}

async function loadFace(family: string, weight: number, italic: boolean): Promise<void> {
  const fonts = await queryAll()
  if (fonts.length === 0) return
  const candidates = [family, ...FALLBACK_FAMILIES]
  for (const candidate of candidates) {
    const faces = fonts.filter((f) => f.family.toLowerCase() === candidate.toLowerCase())
    if (faces.length === 0) continue
    const best = faces
      .map((f) => ({ f, score: styleScore(f.style, weight, italic) }))
      .sort((a, b) => b.score - a.score)[0].f
    try {
      const bytes = new Uint8Array(await (await best.blob()).arrayBuffer())
      // Registered under the REQUESTED family so lookups resolve, even when
      // a fallback face supplied the bytes.
      if (registerFontBytes(family, weight, italic, bytes)) return
    } catch (err) {
      console.warn(`[polyform] failed to load font face "${best.fullName}":`, err)
    }
  }
}

/** Install the async resolver for engine font requests (idempotent). */
export function installFontLoader(): void {
  setFontRequestListener((family, weight, italic) => {
    void loadFace(family, weight, italic).catch((err) =>
      console.warn('[polyform] font load failed:', err),
    )
  })
}

/** Eagerly load a face (render-test harness — fonts before first bake). */
export async function preloadFont(family: string, weight = 400, italic = false): Promise<void> {
  await loadFace(family, weight, italic)
}
