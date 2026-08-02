// Differential gate: engine/color.ts vs the Rust twin (P4). Pure IEEE 754
// arithmetic throughout — string outputs compared exactly, numeric outputs
// compared with Object.is per component (same rules as wasm-parity.test.ts).

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { hexToRgba, hsvToRgb, rgbaToCss, rgbaToHex, rgbToHsv } from './color'
import { initWasmEngine, wasmHandle } from './backend'

const N = Number(process.env.FUZZ_N ?? 1000)

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('./wasm/pkg/polyform_core_bg.wasm', import.meta.url))
  const ok = await initWasmEngine(readFileSync(wasmPath))
  expect(ok).toBe(true)
})

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('color parity (TS <-> Rust)', () => {
  it('rgbaToCss strings are identical', () => {
    const rnd = mulberry32(0xc0104)
    for (let i = 0; i < N; i++) {
      const [r, g, b, a, extra] = [rnd(), rnd(), rnd(), rnd(), rnd() * 1.5]
      expect(wasmHandle().colorRgbaToCss(r, g, b, a, extra)).toBe(
        rgbaToCss({ r, g, b, a }, extra),
      )
    }
  })

  it('rgbaToHex strings are identical (incl. out-of-range clamps)', () => {
    const rnd = mulberry32(0xc0105)
    for (let i = 0; i < N; i++) {
      const [r, g, b] = [rnd() * 1.4 - 0.2, rnd() * 1.4 - 0.2, rnd() * 1.4 - 0.2]
      expect(wasmHandle().colorRgbaToHex(r, g, b)).toBe(rgbaToHex({ r, g, b, a: 1 }))
    }
  })

  it('hexToRgba agrees on valid and invalid inputs', () => {
    const rnd = mulberry32(0xc0106)
    const digits = '0123456789abcdefABCDEF'
    const cases: string[] = ['', '#', 'zzz', '#12', '12345', '#1234567', ' fff ', '#ABC']
    for (let i = 0; i < N; i++) {
      const len = [3, 5, 6, 7][Math.floor(rnd() * 4)]
      let s = rnd() < 0.5 ? '#' : ''
      for (let k = 0; k < len; k++) s += digits[Math.floor(rnd() * digits.length)]
      cases.push(s)
    }
    for (const s of cases) {
      const ts = hexToRgba(s, 0.7)
      const rust = wasmHandle().colorHexToRgba(s, 0.7)
      if (ts === null) {
        expect(rust.length).toBe(0)
      } else {
        expect(rust.length).toBe(4)
        expect(Object.is(rust[0], ts.r) && Object.is(rust[1], ts.g) && Object.is(rust[2], ts.b) && Object.is(rust[3], ts.a)).toBe(true)
      }
    }
  })

  it('hsv<->rgb conversions are bit-identical', () => {
    const rnd = mulberry32(0xc0107)
    for (let i = 0; i < N; i++) {
      const [h, s, v] = [rnd() * 360, rnd(), rnd()]
      const ts = hsvToRgb(h, s, v)
      const ru = wasmHandle().colorHsvToRgb(h, s, v)
      expect(Object.is(ru[0], ts.r) && Object.is(ru[1], ts.g) && Object.is(ru[2], ts.b)).toBe(true)

      const [r, g, b] = [rnd(), rnd(), rnd()]
      const ts2 = rgbToHsv(r, g, b)
      const ru2 = wasmHandle().colorRgbToHsv(r, g, b)
      expect(Object.is(ru2[0], ts2.h) && Object.is(ru2[1], ts2.s) && Object.is(ru2[2], ts2.v)).toBe(true)
    }
  })
})
