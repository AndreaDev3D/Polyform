// Shaped text stack gates (Sprint E, ADR-018): rustybuzz shaping + engine
// layout through the WASM boundary. Uses a system font (Windows / Linux CI
// / macOS candidates) — every test degrades to a loud skip when no font
// file is readable, so the suite stays green on exotic environments.
//
// These are CONTRACT tests (determinism, wrap invariants, fallback wiring),
// not frozen snapshots: glyph ids and advances legitimately differ between
// Arial and DejaVu Sans.

import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { initWasmEngine, wasmHandle } from './backend'
import { fontEntryFor, loadedFontKeys, registerFontBytes } from './fontstore'
import { layoutText } from './text'
import { decodeSubPaths } from './wasm/codec'
import { createNode } from './types'
import type { TextNode } from './types'

const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\arial.ttf',
  'C:\\Windows\\Fonts\\segoeui.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
]

let fontLoaded = false

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('./wasm/pkg/polyform_core_bg.wasm', import.meta.url))
  const ok = await initWasmEngine(readFileSync(wasmPath))
  expect(ok).toBe(true)
  const path = FONT_CANDIDATES.find((p) => existsSync(p))
  if (!path) {
    console.warn('text-shaped tests: no system font found — shaped assertions skipped')
    return
  }
  fontLoaded = registerFontBytes('TestFont', 400, false, new Uint8Array(readFileSync(path)))
  expect(fontLoaded).toBe(true)
})

function textNode(props: Partial<TextNode>): TextNode {
  const node = createNode('TEXT', 'text') as TextNode
  Object.assign(node, { fontFamily: 'TestFont', fontSize: 16, characters: 'Hello world' }, props)
  return node
}

describe('shaped layout (WASM text backend)', () => {
  it('produces a shaped layout with per-glyph positions', () => {
    if (!fontLoaded) return
    const layout = layoutText(textNode({ characters: 'AVATAR fi ffl To', width: 400 }))
    expect(layout.shaped).toBeTruthy()
    expect(layout.lines.length).toBe(1)
    const glyphs = layout.lines[0].glyphs!
    expect(glyphs.length).toBeGreaterThan(0)
    expect(glyphs.length % 3).toBe(0)
    // Positions are finite and x is non-decreasing (LTR single run).
    let lastX = -Infinity
    for (let i = 0; i + 3 <= glyphs.length; i += 3) {
      expect(Number.isFinite(glyphs[i + 1])).toBe(true)
      expect(Number.isFinite(glyphs[i + 2])).toBe(true)
      expect(glyphs[i + 1]).toBeGreaterThanOrEqual(lastX - 1e-6)
      lastX = glyphs[i + 1]
    }
  })

  it('is deterministic across calls', () => {
    if (!fontLoaded) return
    const node = textNode({ characters: 'The quick brown fox 0123456789', width: 220, autoResize: 'HEIGHT' })
    const a = layoutText(node)
    const b = layoutText(node)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('wraps within the box and applies kerning to measurements', () => {
    if (!fontLoaded) return
    const node = textNode({
      characters: 'The quick brown fox jumps over the lazy dog again and again',
      width: 150,
      autoResize: 'HEIGHT',
    })
    const layout = layoutText(node)
    expect(layout.shaped).toBeTruthy()
    expect(layout.lines.length).toBeGreaterThan(1)
    for (const line of layout.lines) {
      expect(line.width).toBeLessThanOrEqual(150 + 1e-6)
    }
    // Kerned pair no wider than the sum of its parts.
    const width = (chars: string) =>
      layoutText(textNode({ characters: chars, fontSize: 100, width: 4000 })).totalWidth
    expect(width('AV')).toBeLessThanOrEqual(width('A') + width('V') + 1e-6)
  })

  it('alignment offsets lines inside the box', () => {
    if (!fontLoaded) return
    const left = layoutText(textNode({ width: 300, autoResize: 'NONE', height: 100 }))
    const right = layoutText(
      textNode({ width: 300, autoResize: 'NONE', height: 100, textAlignH: 'RIGHT' }),
    )
    const center = layoutText(
      textNode({ width: 300, autoResize: 'NONE', height: 100, textAlignH: 'CENTER' }),
    )
    expect(left.lines[0].x).toBe(0)
    expect(right.lines[0].x).toBeCloseTo(300 - right.lines[0].width, 6)
    expect(center.lines[0].x).toBeCloseTo((300 - center.lines[0].width) / 2, 6)
  })

  it('glyph outlines decode to closed subpaths with y-down coordinates', () => {
    if (!fontLoaded) return
    const entry = fontEntryFor('TestFont', 400, false)!
    const layout = layoutText(textNode({ characters: 'A', width: 100 }))
    const gid = layout.lines[0].glyphs![0]
    const blob = wasmHandle().glyphSubPaths(entry.id, gid)
    const paths = decodeSubPaths(blob)
    expect(paths.length).toBeGreaterThan(0)
    let minY = Infinity
    for (const sp of paths) {
      expect(sp.closed).toBe(true)
      for (const a of sp.anchors) minY = Math.min(minY, a.p.y)
    }
    // Cap height above the baseline = negative y in the document convention.
    expect(minY).toBeLessThan(0)
  })

  it('falls back to the legacy path for unknown families', () => {
    const layout = layoutText(textNode({ fontFamily: 'NoSuchFontFamily12345' }))
    expect(layout.shaped).toBeUndefined()
    expect(layout.lines.length).toBeGreaterThan(0)
  })

  it('registers fonts under family|weight|italic keys', () => {
    if (!fontLoaded) return
    expect(loadedFontKeys()).toContain('TestFont|400|0')
  })
})
