// The remaining sdf-class built-ins: neon glow and neumorphism. Like bevel3d
// they read the node's signed distance field (negative inside, raster px);
// falloffs are polynomials, not exp(), so both languages agree exactly.

import type { RegisteredShader } from '../registry'
import type { MaterialUniformValue, RGBA } from '../../types'

const num = (v: MaterialUniformValue, d: number): number => (typeof v === 'number' ? v : d)
const boolv = (v: MaterialUniformValue, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const col = (v: MaterialUniformValue, d: RGBA): RGBA =>
  typeof v === 'object' && v !== null && 'r' in v ? (v as RGBA) : d
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

export const neon: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'neon',
    name: 'Neon Glow',
    class: 'sdf',
    uniforms: [
      { key: 'coreColor', label: 'Core', type: 'color', default: { r: 1, g: 1, b: 1, a: 1 } },
      { key: 'glowColor', label: 'Glow', type: 'color', default: { r: 0.25, g: 0.9, b: 1, a: 1 } },
      { key: 'radius', label: 'Radius', type: 'float', default: 14, min: 1, max: 120, step: 0.5 },
      { key: 'intensity', label: 'Intensity', type: 'float', default: 0.9, min: 0, max: 1, step: 0.01 },
      { key: 'inside', label: 'Glow Inward', type: 'bool', default: false },
    ],
    fallback: { r: 0.3, g: 0.85, b: 1, a: 0.6 },
  },
  wgsl: /* wgsl */ `
fn material(p: vec2f, size: vec2f, dist: f32) -> vec4f {
  let rPx = max(radius * u.info.z, 0.5);
  // Distance from the EDGE, signed per the direction we glow in.
  var d = dist;
  if (inside > 0.5) { d = -dist; }
  if (d < 0.0) { return vec4f(0.0); }
  let t = clamp(1.0 - d / rPx, 0.0, 1.0);
  let fall = t * t; // quadratic falloff, exact in both languages
  // The tube: a bright core hugging the edge.
  let core = clamp(1.0 - abs(dist) / (1.5 * max(u.info.z, 0.5)), 0.0, 1.0);
  let a = clamp(fall * intensity * glowColor.a + core * coreColor.a, 0.0, 1.0);
  if (a < 0.0001) { return vec4f(0.0); }
  let rgb = (glowColor.rgb * (fall * intensity * glowColor.a) + coreColor.rgb * (core * coreColor.a))
    / max(fall * intensity * glowColor.a + core * coreColor.a, 0.0001);
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), a);
}
`,
  twin: (x, y, width, _h, uniforms, inputs) => {
    const none = { r: 0, g: 0, b: 0, a: 0 }
    const sdf = inputs.sdf
    if (!sdf) return none
    const dist = sdf[y * width + x]
    const rPx = Math.max(num(uniforms.radius, 14) * inputs.pxScale, 0.5)
    const inside = boolv(uniforms.inside, false)
    const d = inside ? -dist : dist
    if (d < 0) return none
    const t = clamp01(1 - d / rPx)
    const fall = t * t
    const core = clamp01(1 - Math.abs(dist) / (1.5 * Math.max(inputs.pxScale, 0.5)))
    const glowColor = col(uniforms.glowColor, { r: 0.25, g: 0.9, b: 1, a: 1 })
    const coreColor = col(uniforms.coreColor, { r: 1, g: 1, b: 1, a: 1 })
    const intensity = num(uniforms.intensity, 0.9)
    const ga = fall * intensity * glowColor.a
    const ca = core * coreColor.a
    const a = clamp01(ga + ca)
    if (a < 0.0001) return none
    const wsum = Math.max(ga + ca, 0.0001)
    return {
      r: clamp01((glowColor.r * ga + coreColor.r * ca) / wsum),
      g: clamp01((glowColor.g * ga + coreColor.g * ca) / wsum),
      b: clamp01((glowColor.b * ga + coreColor.b * ca) / wsum),
      a,
    }
  },
}

export const neumorph: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'neumorph',
    name: 'Neumorphism',
    class: 'sdf',
    uniforms: [
      { key: 'elevation', label: 'Elevation', type: 'float', default: 10, min: 1, max: 80, step: 0.5 },
      { key: 'lightAngle', label: 'Light Angle', type: 'float', default: -135, min: -180, max: 180, step: 1 },
      { key: 'intensity', label: 'Intensity', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'inset', label: 'Inset', type: 'bool', default: false },
    ],
    fallback: { r: 0.85, g: 0.86, b: 0.9, a: 1 },
  },
  wgsl: /* wgsl */ `
fn nm_at(p: vec2f, size: vec2f) -> f32 {
  let x = clamp(p.x, 0.0, size.x - 1.0);
  let y = clamp(p.y, 0.0, size.y - 1.0);
  return textureLoad(sdf_tex, vec2i(i32(x), i32(y)), 0).r;
}
fn material(p: vec2f, size: vec2f, dist: f32) -> vec4f {
  if (dist >= 0.0) { return vec4f(0.0); }
  let ePx = max(elevation * u.info.z, 0.5);
  let t = clamp(-dist / ePx, 0.0, 1.0);
  let band = 1.0 - t;
  let soft = band * band * (3.0 - 2.0 * band); // smoothstep-shaped falloff
  let gx = nm_at(p + vec2f(1.0, 0.0), size) - nm_at(p - vec2f(1.0, 0.0), size);
  let gy = nm_at(p + vec2f(0.0, 1.0), size) - nm_at(p - vec2f(0.0, 1.0), size);
  let glen = sqrt(gx * gx + gy * gy);
  if (glen < 0.0001) { return vec4f(0.0); }
  let rad = lightAngle * 0.017453292519943295;
  var shade = -(gx / glen * cos(rad) + gy / glen * sin(rad));
  if (inset > 0.5) { shade = -shade; }
  let hi = clamp(shade, 0.0, 1.0) * soft * intensity;
  let lo = clamp(-shade, 0.0, 1.0) * soft * intensity;
  let a = clamp(hi + lo, 0.0, 1.0);
  if (a < 0.0001) { return vec4f(0.0); }
  let rgb = (vec3f(1.0) * hi + vec3f(0.0) * lo) / (hi + lo);
  return vec4f(rgb, a * 0.85);
}
`,
  twin: (x, y, width, height, uniforms, inputs) => {
    const none = { r: 0, g: 0, b: 0, a: 0 }
    const sdf = inputs.sdf
    if (!sdf) return none
    const at = (px: number, py: number): number => {
      const cx = Math.min(width - 1, Math.max(0, px))
      const cy = Math.min(height - 1, Math.max(0, py))
      return sdf[Math.trunc(cy) * width + Math.trunc(cx)]
    }
    const dist = sdf[y * width + x]
    if (dist >= 0) return none
    const ePx = Math.max(num(uniforms.elevation, 10) * inputs.pxScale, 0.5)
    const t = clamp01(-dist / ePx)
    const band = 1 - t
    const soft = band * band * (3 - 2 * band)
    const gx = at(x + 1, y) - at(x - 1, y)
    const gy = at(x, y + 1) - at(x, y - 1)
    const glen = Math.sqrt(gx * gx + gy * gy)
    if (glen < 0.0001) return none
    const rad = num(uniforms.lightAngle, -135) * 0.017453292519943295
    let shade = -((gx / glen) * Math.cos(rad) + (gy / glen) * Math.sin(rad))
    if (boolv(uniforms.inset, false)) shade = -shade
    const intensity = num(uniforms.intensity, 0.5)
    const hi = clamp01(shade) * soft * intensity
    const lo = clamp01(-shade) * soft * intensity
    const a = clamp01(hi + lo)
    if (a < 0.0001) return none
    const v = hi / (hi + lo)
    return { r: v, g: v, b: v, a: a * 0.85 }
  },
}
