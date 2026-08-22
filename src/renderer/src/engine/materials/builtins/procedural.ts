// The remaining procedural built-ins: grain, dot grid, holographic, foil.
//
// Randomness discipline: every "noise" here is an INTEGER hash (xorshift-mul
// over u32 pixel coordinates), never fract(sin(...)) — u32 arithmetic wraps
// identically in WGSL and in JS (Math.imul + >>>), so the twin and the island
// stay bit-comparable, where a transcendental hash diverges between the GPU's
// f32 sin and V8's f64 sin by whole channel steps. sin/cos appear only with
// bounded arguments (angles), where the ulp gap cannot cross the harness's
// 24/255 pixel threshold.

import type { RegisteredShader } from '../registry'
import type { MaterialUniformValue, RGBA } from '../../types'

const num = (v: MaterialUniformValue, d: number): number => (typeof v === 'number' ? v : d)
const boolv = (v: MaterialUniformValue, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const col = (v: MaterialUniformValue, d: RGBA): RGBA =>
  typeof v === 'object' && v !== null && 'r' in v ? (v as RGBA) : d

/** u32 pixel hash → [0,1). The WGSL twin of this is in each shader body. */
function hash01(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 69069)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

const HASH_WGSL = `
fn hash01(x: u32, y: u32, seed: u32) -> f32 {
  var h = x * 374761393u + y * 668265263u + seed * 69069u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}
`

// --- Grain -------------------------------------------------------------------

export const noise: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'noise',
    name: 'Grain',
    class: 'procedural',
    uniforms: [
      { key: 'amount', label: 'Amount', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01 },
      { key: 'scale', label: 'Grain Size', type: 'float', default: 1, min: 1, max: 16, step: 1 },
      { key: 'monochrome', label: 'Monochrome', type: 'bool', default: true },
    ],
    fallback: { r: 0.5, g: 0.5, b: 0.5, a: 0.3 },
  },
  wgsl: /* wgsl */ `
${HASH_WGSL}
fn material(p: vec2f, size: vec2f) -> vec4f {
  let cell = max(scale, 1.0);
  let cx = u32(floor(p.x / cell));
  let cy = u32(floor(p.y / cell));
  let n = hash01(cx, cy, 1u);
  let g = hash01(cx, cy, 2u);
  let b = hash01(cx, cy, 3u);
  let mono = monochrome > 0.5;
  let rr = n;
  let gg = select(g, n, mono);
  let bb = select(b, n, mono);
  // Darkens dark speckles, lightens light ones: white or black per cell,
  // with coverage proportional to how far the sample is from mid-gray.
  let lum = select((rr + gg + bb) / 3.0, n, mono);
  let a = amount * abs(lum * 2.0 - 1.0);
  let white = step(0.5, lum);
  return vec4f(vec3f(rr, gg, bb) * 0.0 + vec3f(white), a);
}
`,
  twin: (x, y, _w, _h, uniforms) => {
    const amount = num(uniforms.amount, 0.35)
    const scale = Math.max(num(uniforms.scale, 1), 1)
    const monochrome = boolv(uniforms.monochrome, true)
    const cx = Math.floor(x / scale) >>> 0
    const cy = Math.floor(y / scale) >>> 0
    const n = hash01(cx, cy, 1)
    const g = hash01(cx, cy, 2)
    const b = hash01(cx, cy, 3)
    const rr = n
    const gg = monochrome ? n : g
    const bb = monochrome ? n : b
    const lum = monochrome ? n : (rr + gg + bb) / 3
    const a = amount * Math.abs(lum * 2 - 1)
    const white = lum >= 0.5 ? 1 : 0
    return { r: white, g: white, b: white, a }
  },
}

// --- Dot grid ------------------------------------------------------------------

export const dotgrid: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'dotgrid',
    name: 'Dot Grid',
    class: 'procedural',
    uniforms: [
      { key: 'cell', label: 'Cell Size', type: 'float', default: 14, min: 2, max: 200, step: 1 },
      { key: 'ratio', label: 'Dot Ratio', type: 'float', default: 0.55, min: 0.05, max: 1, step: 0.01 },
      { key: 'dotColor', label: 'Dot', type: 'color', default: { r: 0.95, g: 0.95, b: 0.97, a: 1 } },
      { key: 'bgColor', label: 'Background', type: 'color', default: { r: 0.07, g: 0.07, b: 0.09, a: 1 } },
      { key: 'stagger', label: 'Stagger', type: 'bool', default: false },
    ],
    fallback: { r: 0.4, g: 0.4, b: 0.45, a: 1 },
  },
  wgsl: /* wgsl */ `
fn material(p: vec2f, size: vec2f) -> vec4f {
  let c = max(cell * u.info.z, 2.0);
  var px = p.x;
  let row = floor(p.y / c);
  if (stagger > 0.5 && (row - 2.0 * floor(row / 2.0)) > 0.5) { px = px + c * 0.5; }
  let fx = px - (floor(px / c) + 0.5) * c;
  let fy = p.y - (floor(p.y / c) + 0.5) * c;
  let d = sqrt(fx * fx + fy * fy);
  let r = c * 0.5 * ratio;
  let m = 1.0 - smoothstep(r - 1.0, r + 1.0, d);
  return mix(bgColor, dotColor, m);
}
`,
  twin: (x, y, _w, _h, uniforms, inputs) => {
    const smoothstep = (a: number, b: number, v: number): number => {
      const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    const c = Math.max(num(uniforms.cell, 14) * inputs.pxScale, 2)
    const ratio = num(uniforms.ratio, 0.55)
    const dotColor = col(uniforms.dotColor, { r: 0.95, g: 0.95, b: 0.97, a: 1 })
    const bgColor = col(uniforms.bgColor, { r: 0.07, g: 0.07, b: 0.09, a: 1 })
    let px = x
    const row = Math.floor(y / c)
    if (boolv(uniforms.stagger, false) && row - 2 * Math.floor(row / 2) > 0.5) px = px + c * 0.5
    const fx = px - (Math.floor(px / c) + 0.5) * c
    const fy = y - (Math.floor(y / c) + 0.5) * c
    const d = Math.sqrt(fx * fx + fy * fy)
    const r = c * 0.5 * ratio
    const m = 1 - smoothstep(r - 1, r + 1, d)
    return {
      r: bgColor.r + (dotColor.r - bgColor.r) * m,
      g: bgColor.g + (dotColor.g - bgColor.g) * m,
      b: bgColor.b + (dotColor.b - bgColor.b) * m,
      a: bgColor.a + (dotColor.a - bgColor.a) * m,
    }
  },
}

// --- Holographic ---------------------------------------------------------------

export const iridescent: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'iridescent',
    name: 'Holographic',
    class: 'procedural',
    uniforms: [
      { key: 'hueOffset', label: 'Hue Offset', type: 'float', default: 0, min: -180, max: 180, step: 1 },
      { key: 'sweepAngle', label: 'Sweep Angle', type: 'float', default: 35, min: -180, max: 180, step: 1 },
      { key: 'banding', label: 'Banding', type: 'float', default: 1.6, min: 0.2, max: 8, step: 0.1 },
      { key: 'brightness', label: 'Brightness', type: 'float', default: 0.95, min: 0.2, max: 1, step: 0.01 },
    ],
    fallback: { r: 0.7, g: 0.6, b: 0.9, a: 1 },
  },
  wgsl: /* wgsl */ `
fn hue2rgb(h: f32) -> vec3f {
  let hh = h - 6.0 * floor(h / 6.0);
  let x = 1.0 - abs(hh - 2.0 * floor(hh / 2.0) - 1.0);
  if (hh < 1.0) { return vec3f(1.0, x, 0.0); }
  if (hh < 2.0) { return vec3f(x, 1.0, 0.0); }
  if (hh < 3.0) { return vec3f(0.0, 1.0, x); }
  if (hh < 4.0) { return vec3f(0.0, x, 1.0); }
  if (hh < 5.0) { return vec3f(x, 0.0, 1.0); }
  return vec3f(1.0, 0.0, x);
}
fn material(p: vec2f, size: vec2f) -> vec4f {
  let rad = sweepAngle * 0.017453292519943295;
  let t = (p.x * cos(rad) + p.y * sin(rad)) / max(size.x, size.y);
  let h = (hueOffset / 60.0) + t * 6.0 * banding;
  let rgb = hue2rgb(h);
  // Pastel it toward white so it reads as sheen rather than a rainbow flag.
  let soft = mix(rgb, vec3f(1.0), 0.35) * brightness;
  return vec4f(soft, 1.0);
}
`,
  twin: (x, y, w, h, uniforms) => {
    const hue2rgb = (hh0: number): [number, number, number] => {
      const hh = hh0 - 6 * Math.floor(hh0 / 6)
      const xv = 1 - Math.abs(hh - 2 * Math.floor(hh / 2) - 1)
      if (hh < 1) return [1, xv, 0]
      if (hh < 2) return [xv, 1, 0]
      if (hh < 3) return [0, 1, xv]
      if (hh < 4) return [0, xv, 1]
      if (hh < 5) return [xv, 0, 1]
      return [1, 0, xv]
    }
    const rad = num(uniforms.sweepAngle, 35) * 0.017453292519943295
    const t = (x * Math.cos(rad) + y * Math.sin(rad)) / Math.max(w, h)
    const hh = num(uniforms.hueOffset, 0) / 60 + t * 6 * num(uniforms.banding, 1.6)
    const [r, g, b] = hue2rgb(hh)
    const brightness = num(uniforms.brightness, 0.95)
    const soften = (c: number): number => (c + (1 - c) * 0.35) * brightness
    return { r: soften(r), g: soften(g), b: soften(b), a: 1 }
  },
}

// --- Metallic foil ---------------------------------------------------------------

export const foil: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'foil',
    name: 'Metallic Foil',
    class: 'procedural',
    uniforms: [
      { key: 'preset', label: 'Metal', type: 'enum', default: 0, options: ['Gold', 'Silver', 'Chrome', 'Custom'] },
      { key: 'customColor', label: 'Custom', type: 'color', default: { r: 0.72, g: 0.45, b: 0.85, a: 1 } },
      { key: 'sweepAngle', label: 'Sweep Angle', type: 'float', default: -30, min: -180, max: 180, step: 1 },
      { key: 'bands', label: 'Bands', type: 'float', default: 5, min: 1, max: 24, step: 0.5 },
      { key: 'roughness', label: 'Roughness', type: 'float', default: 0.12, min: 0, max: 1, step: 0.01 },
    ],
    fallback: { r: 0.75, g: 0.62, b: 0.3, a: 1 },
  },
  wgsl: /* wgsl */ `
${HASH_WGSL}
fn material(p: vec2f, size: vec2f) -> vec4f {
  var base = vec3f(0.85, 0.66, 0.25);
  if (preset > 0.5 && preset < 1.5) { base = vec3f(0.78, 0.8, 0.84); }
  else if (preset > 1.5 && preset < 2.5) { base = vec3f(0.62, 0.68, 0.78); }
  else if (preset > 2.5) { base = customColor.rgb; }
  let rad = sweepAngle * 0.017453292519943295;
  let t = (p.x * cos(rad) + p.y * sin(rad)) / max(size.x, size.y);
  let jitter = (hash01(u32(p.x), u32(p.y), 7u) - 0.5) * roughness * 0.6;
  let tt = t * bands + jitter;
  // Triangle wave, not sin: exact in both languages.
  let tri = abs(tt - 2.0 * floor(tt / 2.0) - 1.0);
  let v = 0.35 + 0.65 * tri;
  let sheen = smoothstep(0.82, 1.0, tri);
  let rgb = clamp(base * v + vec3f(sheen * 0.5), vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, 1.0);
}
`,
  twin: (x, y, w, h, uniforms) => {
    const smoothstep = (a: number, b: number, v: number): number => {
      const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    const preset = num(uniforms.preset, 0)
    const custom = col(uniforms.customColor, { r: 0.72, g: 0.45, b: 0.85, a: 1 })
    let base: [number, number, number] = [0.85, 0.66, 0.25]
    if (preset > 0.5 && preset < 1.5) base = [0.78, 0.8, 0.84]
    else if (preset > 1.5 && preset < 2.5) base = [0.62, 0.68, 0.78]
    else if (preset > 2.5) base = [custom.r, custom.g, custom.b]
    const rad = num(uniforms.sweepAngle, -30) * 0.017453292519943295
    const t = (x * Math.cos(rad) + y * Math.sin(rad)) / Math.max(w, h)
    const jitter = (hash01(x >>> 0, y >>> 0, 7) - 0.5) * num(uniforms.roughness, 0.12) * 0.6
    const tt = t * num(uniforms.bands, 5) + jitter
    const tri = Math.abs(tt - 2 * Math.floor(tt / 2) - 1)
    const v = 0.35 + 0.65 * tri
    const sheen = smoothstep(0.82, 1, tri)
    const clamp01 = (c: number): number => Math.min(1, Math.max(0, c))
    return { r: clamp01(base[0] * v + sheen * 0.5), g: clamp01(base[1] * v + sheen * 0.5), b: clamp01(base[2] * v + sheen * 0.5), a: 1 }
  },
}
