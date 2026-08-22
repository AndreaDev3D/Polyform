// Stripes & checker — the canonical built-in, and the reference for how a
// shader is written twice without drifting: the WGSL body and the TS twin
// below are the SAME arithmetic, line for line, in two languages. No fwidth,
// no derivatives — antialiasing comes from softness plus the raster's own
// resolution, so both producers can agree to the pixel. The render harness
// diffs them; keep them boring and keep them identical.
//
// Authoring contract (both languages):
//   input   p     pixel position in the shape's raster, (0,0) top-left
//           size  raster size in pixels
//   output  straight-alpha RGBA
//
// The WGSL references uniforms by their manifest keys; the island's wrapper
// (materials/wrap-wgsl.ts) generates `let <key> = ...slot...` bindings above
// this body, so the names here ARE the manifest keys.

import type { RegisteredShader } from '../registry'
import type { MaterialUniformValue, RGBA } from '../../types'

const num = (v: MaterialUniformValue, d: number): number => (typeof v === 'number' ? v : d)
const col = (v: MaterialUniformValue, d: RGBA): RGBA =>
  typeof v === 'object' && v !== null && 'r' in v ? (v as RGBA) : d

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export const stripes: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'stripes',
    name: 'Stripes & Checker',
    class: 'procedural',
    uniforms: [
      { key: 'mode', label: 'Pattern', type: 'enum', default: 0, options: ['Stripes', 'Checker'] },
      { key: 'colorA', label: 'Color A', type: 'color', default: { r: 0.09, g: 0.09, b: 0.11, a: 1 } },
      { key: 'colorB', label: 'Color B', type: 'color', default: { r: 0.92, g: 0.92, b: 0.94, a: 1 } },
      { key: 'width', label: 'Width', type: 'float', default: 24, min: 1, max: 400, step: 1 },
      { key: 'angle', label: 'Angle', type: 'float', default: 45, min: -180, max: 180, step: 1 },
      { key: 'softness', label: 'Softness', type: 'float', default: 0.08, min: 0, max: 1, step: 0.01 },
    ],
    fallback: { r: 0.5, g: 0.5, b: 0.55, a: 1 },
  },

  wgsl: /* wgsl */ `
fn material(p: vec2f, size: vec2f) -> vec4f {
  let rad = angle * 0.017453292519943295;
  let dirc = cos(rad);
  let dirs = sin(rad);
  let w = max(width, 0.5);
  let t = (p.x * dirc + p.y * dirs) / w;
  let u = (-p.x * dirs + p.y * dirc) / w;
  let e = max(softness * 0.5, 0.02);
  let mt = smoothstep(-e, e, sin(t * 3.141592653589793));
  let mu = smoothstep(-e, e, sin(u * 3.141592653589793));
  // mode 0: stripes follow t alone; mode 1: soft XOR of both axes = checker.
  let m = select(mt, mt * (1.0 - mu) + (1.0 - mt) * mu, mode > 0.5);
  return mix(colorA, colorB, m);
}
`,

  twin: (x, y, _width, _height, uniforms, _inputs) => {
    const mode = num(uniforms.mode, 0)
    const colorA = col(uniforms.colorA, { r: 0.09, g: 0.09, b: 0.11, a: 1 })
    const colorB = col(uniforms.colorB, { r: 0.92, g: 0.92, b: 0.94, a: 1 })
    const width = num(uniforms.width, 24)
    const angle = num(uniforms.angle, 45)
    const softness = num(uniforms.softness, 0.08)

    const rad = angle * 0.017453292519943295
    const dirc = Math.cos(rad)
    const dirs = Math.sin(rad)
    const w = Math.max(width, 0.5)
    const t = (x * dirc + y * dirs) / w
    const u = (-x * dirs + y * dirc) / w
    const e = Math.max(softness * 0.5, 0.02)
    const mt = smoothstep(-e, e, Math.sin(t * 3.141592653589793))
    const mu = smoothstep(-e, e, Math.sin(u * 3.141592653589793))
    const m = mode > 0.5 ? mt * (1 - mu) + (1 - mt) * mu : mt
    return {
      r: colorA.r + (colorB.r - colorA.r) * m,
      g: colorA.g + (colorB.g - colorA.g) * m,
      b: colorA.b + (colorB.b - colorA.b) * m,
      a: colorA.a + (colorB.a - colorA.a) * m,
    }
  },
}
