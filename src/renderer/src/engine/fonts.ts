// System font discovery via Chromium's Local Font Access API
// (queryLocalFonts), with a safe fallback list. The Electron main process
// grants the 'local-fonts' permission for our origin.

export interface LocalFontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
  /** Raw font file bytes (Local Font Access API) — feeds the shaping engine. */
  blob(): Promise<Blob>
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>
  }
}

export const FALLBACK_FONTS = [
  'Arial',
  'Calibri',
  'Cambria',
  'Comic Sans MS',
  'Consolas',
  'Courier New',
  'Georgia',
  'Impact',
  'Segoe UI',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
]

export async function listSystemFontFamilies(): Promise<string[]> {
  try {
    if (typeof window.queryLocalFonts === 'function') {
      const fonts = await window.queryLocalFonts()
      const families = [...new Set(fonts.map((f) => f.family))]
      families.sort((a, b) => a.localeCompare(b))
      if (families.length > 0) return families
    }
  } catch {
    // Permission denied or API unavailable — use fallback.
  }
  return FALLBACK_FONTS
}
