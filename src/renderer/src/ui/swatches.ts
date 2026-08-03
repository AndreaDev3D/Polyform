// Colour sources for the picker (UI redesign).
//
// A picker that only offers a rainbow makes you re-derive a colour you have
// already used ten times. Three cheap sources fix that: the colours already
// in this document, the shared styles, and what you reached for recently.

import { documentStore } from '../state/document'
import { rgbaToHex } from '../engine/color'
import type { Paint, RGBA } from '../engine/types'

export interface Swatch {
  /** '#RRGGBB' — the dedupe key, alpha excluded so tints group. */
  hex: string
  color: RGBA
  /** How many places in the document use it (drives ordering). */
  uses: number
  name?: string
}

function collect(paint: Paint, into: Map<string, Swatch>): void {
  const add = (c: RGBA) => {
    const hex = `#${rgbaToHex(c)}`
    const hit = into.get(hex)
    if (hit) hit.uses += 1
    else into.set(hex, { hex, color: { ...c }, uses: 1 })
  }
  if (paint.type === 'SOLID') add(paint.color)
  else if (paint.type !== 'IMAGE') for (const s of paint.stops) add(s.color)
}

/**
 * Every colour used on the current page, most-used first. Figma calls this
 * "On this page"; it is by far the most useful row in the picker.
 */
export function documentSwatches(limit = 24): Swatch[] {
  const scene = documentStore.scene
  const into = new Map<string, Swatch>()
  for (const id of scene.renderOrder()) {
    const node = scene.getNode(id)
    if (!node) continue
    for (const p of node.fills) collect(p, into)
    for (const p of node.strokes) collect(p, into)
  }
  return [...into.values()].sort((a, b) => b.uses - a.uses || a.hex.localeCompare(b.hex)).slice(0, limit)
}

/** Shared colour styles, so the picker can apply one by reference. */
export function styleSwatches(): { id: string; name: string; color: RGBA | null; css: string }[] {
  return documentStore.scene.doc.styles.colors.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.paint.type === 'SOLID' ? s.paint.color : null,
    css:
      s.paint.type === 'SOLID'
        ? `#${rgbaToHex(s.paint.color)}`
        : s.paint.type === 'IMAGE'
          ? 'repeating-conic-gradient(#666 0 25%, #999 0 50%)'
          : `linear-gradient(135deg, ${s.paint.stops.map((x) => `#${rgbaToHex(x.color)}`).join(', ')})`,
  }))
}

// --- recents ---------------------------------------------------------------

const RECENTS_KEY = 'polyform.recentColors'
const RECENTS_MAX = 12

export function recentSwatches(): Swatch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as RGBA[]
    return raw
      .filter((c) => c && typeof c.r === 'number')
      .map((c) => ({ hex: `#${rgbaToHex(c)}`, color: c, uses: 0 }))
  } catch {
    return []
  }
}

/** Called on commit, not on every drag frame — recents track intent. */
export function pushRecentColor(color: RGBA): void {
  try {
    const hex = rgbaToHex(color)
    const kept = recentSwatches()
      .filter((s) => s.hex !== `#${hex}`)
      .map((s) => s.color)
    localStorage.setItem(RECENTS_KEY, JSON.stringify([color, ...kept].slice(0, RECENTS_MAX)))
  } catch {
    /* storage disabled — recents are a convenience, never a requirement */
  }
}
