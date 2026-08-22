// The remaining base-class built-ins: halftone and retro dither. Both
// transform the node's own fills (the src input) — sampled with textureLoad /
// direct indexing at computed integer coordinates, identical in both
// languages, no filtering anywhere.

import type { RegisteredShader } from '../registry'
import type { MaterialUniformValue, RGBA } from '../../types'

const num = (v: MaterialUniformValue, d: number): number => (typeof v === 'number' ? v : d)
const boolv = (v: MaterialUniformValue, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const col = (v: MaterialUniformValue, d: RGBA): RGBA =>
  typeof v === 'object' && v !== null && 'r' in v ? (v as RGBA) : d

export const halftone: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'halftone',
    name: 'Halftone',
    class: 'base',
    uniforms: [
      { key: 'pattern', label: 'Pattern', type: 'enum', default: 0, options: ['Dots', 'Lines'] },
      { key: 'cell', label: 'Cell Size', type: 'float', default: 8, min: 2, max: 64, step: 0.5 },
      { key: 'angle', label: 'Angle', type: 'float', default: 45, min: -180, max: 180, step: 1 },
      { key: 'ink', label: 'Ink', type: 'color', default: { r: 0.06, g: 0.06, b: 0.08, a: 1 } },
      { key: 'paper', label: 'Paper', type: 'color', default: { r: 0.97, g: 0.96, b: 0.93, a: 1 } },
      { key: 'invert', label: 'Invert', type: 'bool', default: false },
    ],
    fallback: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
  },
  wgsl: /* wgsl */ `
fn material(p: vec2f, size: vec2f, src: vec4f) -> vec4f {
  let c = max(cell * u.info.z, 2.0);
  let rad = angle * 0.017453292519943295;
  let rc = cos(rad);
  let rs = sin(rad);
  // Rotated grid coordinates.
  let rx = p.x * rc + p.y * rs;
  let ry = -p.x * rs + p.y * rc;
  // Sample luminance at the CELL CENTRE mapped back to raster space.
  let gx = (floor(rx / c) + 0.5) * c;
  let gy = (floor(ry / c) + 0.5) * c;
  let sxf = gx * rc - gy * rs;
  let syf = gx * rs + gy * rc;
  let sx = clamp(sxf, 0.0, size.x - 1.0);
  let sy = clamp(syf, 0.0, size.y - 1.0);
  let s = textureLoad(src_tex, vec2i(i32(sx), i32(sy)), 0);
  var lum = dot(s.rgb, vec3f(0.2126, 0.7152, 0.0722));
  if (invert > 0.5) { lum = 1.0 - lum; }
  // Ink coverage: dark cells grow dots (area-true: radius ~ sqrt of darkness).
  let coverage = 1.0 - lum;
  var m = 0.0;
  if (pattern < 0.5) {
    let fx = rx - gx;
    let fy = ry - gy;
    let d = sqrt(fx * fx + fy * fy);
    let r = c * 0.7071067811865476 * sqrt(coverage);
    m = 1.0 - smoothstep(r - 0.75, r + 0.75, d);
  } else {
    let fy2 = abs(ry - gy);
    let hw = c * 0.5 * coverage;
    m = 1.0 - smoothstep(hw - 0.75, hw + 0.75, fy2);
  }
  let out = mix(paper, ink, m);
  // Keep the source's own coverage so transparent fills stay transparent.
  return vec4f(out.rgb, out.a * s.a);
}
`,
  twin: (x, y, width, height, uniforms, inputs) => {
    const src = inputs.src
    if (!src) return { r: 0, g: 0, b: 0, a: 0 }
    const smoothstep = (a: number, b: number, v: number): number => {
      const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    const c = Math.max(num(uniforms.cell, 8) * inputs.pxScale, 2)
    const rad = num(uniforms.angle, 45) * 0.017453292519943295
    const rc = Math.cos(rad)
    const rs = Math.sin(rad)
    const rx = x * rc + y * rs
    const ry = -x * rs + y * rc
    const gx = (Math.floor(rx / c) + 0.5) * c
    const gy = (Math.floor(ry / c) + 0.5) * c
    const sx = Math.min(width - 1, Math.max(0, gx * rc - gy * rs))
    const sy = Math.min(height - 1, Math.max(0, gx * rs + gy * rc))
    const si = (Math.trunc(sy) * width + Math.trunc(sx)) * 4
    const sr = src[si] / 255
    const sg = src[si + 1] / 255
    const sb = src[si + 2] / 255
    const sa = src[si + 3] / 255
    let lum = sr * 0.2126 + sg * 0.7152 + sb * 0.0722
    if (boolv(uniforms.invert, false)) lum = 1 - lum
    const coverage = 1 - lum
    let m = 0
    if (num(uniforms.pattern, 0) < 0.5) {
      const fx = rx - gx
      const fy = ry - gy
      const d = Math.sqrt(fx * fx + fy * fy)
      const r = c * 0.7071067811865476 * Math.sqrt(coverage)
      m = 1 - smoothstep(r - 0.75, r + 0.75, d)
    } else {
      const fy2 = Math.abs(ry - gy)
      const hw = c * 0.5 * coverage
      m = 1 - smoothstep(hw - 0.75, hw + 0.75, fy2)
    }
    const ink = col(uniforms.ink, { r: 0.06, g: 0.06, b: 0.08, a: 1 })
    const paper = col(uniforms.paper, { r: 0.97, g: 0.96, b: 0.93, a: 1 })
    return {
      r: paper.r + (ink.r - paper.r) * m,
      g: paper.g + (ink.g - paper.g) * m,
      b: paper.b + (ink.b - paper.b) * m,
      a: (paper.a + (ink.a - paper.a) * m) * sa,
    }
  },
}

// Bayer 4×4, the classic ordered-dither matrix, thresholds in 0..1.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

export const dither: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'dither',
    name: 'Retro Dither',
    class: 'base',
    uniforms: [
      { key: 'levels', label: 'Levels', type: 'float', default: 2, min: 2, max: 8, step: 1 },
      { key: 'pixelSize', label: 'Pixel Size', type: 'float', default: 1, min: 1, max: 8, step: 1 },
    ],
    fallback: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
  },
  wgsl: /* wgsl */ `
fn bayer4(x: u32, y: u32) -> f32 {
  var m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[(y % 4u) * 4u + (x % 4u)] + 0.5) / 16.0;
}
fn material(p: vec2f, size: vec2f, src: vec4f) -> vec4f {
  let cell = max(pixelSize, 1.0);
  let sx = clamp((floor(p.x / cell) + 0.5) * cell, 0.0, size.x - 1.0);
  let sy = clamp((floor(p.y / cell) + 0.5) * cell, 0.0, size.y - 1.0);
  let s = textureLoad(src_tex, vec2i(i32(sx), i32(sy)), 0);
  let n = max(levels, 2.0) - 1.0;
  let t = bayer4(u32(floor(p.x / cell)), u32(floor(p.y / cell))) - 0.5;
  let q = clamp(floor((s.rgb + vec3f(t / n)) * n + vec3f(0.5)) / n, vec3f(0.0), vec3f(1.0));
  return vec4f(q, s.a);
}
`,
  twin: (x, y, width, height, uniforms, inputs) => {
    const src = inputs.src
    if (!src) return { r: 0, g: 0, b: 0, a: 0 }
    const cell = Math.max(num(uniforms.pixelSize, 1), 1)
    const sx = Math.min(width - 1, Math.max(0, (Math.floor(x / cell) + 0.5) * cell))
    const sy = Math.min(height - 1, Math.max(0, (Math.floor(y / cell) + 0.5) * cell))
    const si = (Math.trunc(sy) * width + Math.trunc(sx)) * 4
    const n = Math.max(num(uniforms.levels, 2), 2) - 1
    const bx = Math.floor(x / cell) >>> 0
    const by = Math.floor(y / cell) >>> 0
    const t = (BAYER4[(by % 4) * 4 + (bx % 4)] + 0.5) / 16 - 0.5
    const q = (c: number): number => Math.min(1, Math.max(0, Math.floor((c + t / n) * n + 0.5) / n))
    return { r: q(src[si] / 255), g: q(src[si + 1] / 255), b: q(src[si + 2] / 255), a: src[si + 3] / 255 }
  },
}
