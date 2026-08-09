// Zoom levels, and reading the one a person typed.
//
// The limits live here rather than inline in the actions so the field that
// accepts a typed percentage and the code that applies it cannot disagree about
// what is reachable.

/** 2%. Below this a document is a smudge. */
export const MIN_ZOOM = 0.02
/** 6400%, matching the readout's three digits at most. */
export const MAX_ZOOM = 64

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
}

/** What the readout says, and what the field is seeded with. */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}

/**
 * Reads a typed zoom into a multiplier: `54`, `54%`, `  200 %` → 0.54, 0.54, 2.
 *
 * A bare number is a percentage, so `0.5` means half a percent and clamps to the
 * floor — surprising in isolation, but the alternative is guessing which of two
 * scales someone meant from how small the number is.
 *
 * Returns null for anything that is not a number, so the caller can leave the
 * camera alone instead of jumping to NaN.
 */
export function parseZoomText(text: string): number | null {
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*%?\s*$/.exec(text)
  if (!m) return null
  const value = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null
  return clampZoom(value / 100)
}
