// 3D Bevel — the sdf-class exemplar. The shader reads the node's signed
// distance field (negative inside, raster pixels; see edt.ts) and shades an
// edge band as a lit slope: faces toward the light take the highlight colour,
// faces away take the shadow, the interior stays untouched so the node's own
// fills show through.
//
// The surface normal comes from a central-difference gradient of the SDF —
// two taps per axis, clamped at the raster border — which both languages
// compute identically over the SAME field. No trig beyond the light angle,
// no derivatives, same arithmetic line for line (the stripes rule).

import type { RegisteredShader } from '../registry'
import type { MaterialUniformValue, RGBA } from '../../types'

const num = (v: MaterialUniformValue, d: number): number => (typeof v === 'number' ? v : d)
const col = (v: MaterialUniformValue, d: RGBA): RGBA =>
  typeof v === 'object' && v !== null && 'r' in v ? (v as RGBA) : d

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

export const bevel3d: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'bevel3d',
    name: '3D Bevel',
    class: 'sdf',
    uniforms: [
      { key: 'depth', label: 'Depth', type: 'float', default: 12, min: 0.5, max: 200, step: 0.5 },
      { key: 'lightAngle', label: 'Light Angle', type: 'float', default: -45, min: -180, max: 180, step: 1 },
      { key: 'intensity', label: 'Intensity', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01 },
      { key: 'highlight', label: 'Highlight', type: 'color', default: { r: 1, g: 1, b: 1, a: 0.9 } },
      { key: 'shadow', label: 'Shadow', type: 'color', default: { r: 0, g: 0, b: 0, a: 0.65 } },
      { key: 'profile', label: 'Profile', type: 'enum', default: 0, options: ['Round', 'Chisel', 'Slope'] },
    ],
    fallback: { r: 0.6, g: 0.6, b: 0.62, a: 1 },
  },

  wgsl: /* wgsl */ `
fn sdf_at(p: vec2f, size: vec2f) -> f32 {
  let x = clamp(p.x, 0.0, size.x - 1.0);
  let y = clamp(p.y, 0.0, size.y - 1.0);
  return textureLoad(sdf_tex, vec2i(i32(x), i32(y)), 0).r;
}

fn material(p: vec2f, size: vec2f, dist: f32) -> vec4f {
  let depthPx = max(depth * u.info.z, 0.01);
  if (dist >= 0.0) {
    return vec4f(0.0);
  }
  let t = clamp(-dist / depthPx, 0.0, 1.0);
  var band = 1.0 - t;
  if (profile < 0.5) {
    band = sin(band * 1.5707963267948966);
  } else if (profile > 1.5) {
    band = band * band;
  }
  let gx = sdf_at(p + vec2f(1.0, 0.0), size) - sdf_at(p - vec2f(1.0, 0.0), size);
  let gy = sdf_at(p + vec2f(0.0, 1.0), size) - sdf_at(p - vec2f(0.0, 1.0), size);
  let glen = sqrt(gx * gx + gy * gy);
  if (glen < 0.0001) {
    return vec4f(0.0);
  }
  let rad = lightAngle * 0.017453292519943295;
  let shade = -(gx / glen * cos(rad) + gy / glen * sin(rad));
  let hi = clamp(shade, 0.0, 1.0) * band * intensity * highlight.a;
  let lo = clamp(-shade, 0.0, 1.0) * band * intensity * shadow.a;
  let a = clamp(hi + lo, 0.0, 1.0);
  if (a < 0.0001) {
    return vec4f(0.0);
  }
  let rgb = (highlight.rgb * hi + shadow.rgb * lo) / (hi + lo);
  return vec4f(rgb, a);
}
`,

  twin: (x, y, width, height, uniforms, inputs) => {
    const none = { r: 0, g: 0, b: 0, a: 0 }
    const sdf = inputs.sdf
    if (!sdf) return none
    const depth = num(uniforms.depth, 12)
    const lightAngle = num(uniforms.lightAngle, -45)
    const intensity = num(uniforms.intensity, 0.85)
    const highlight = col(uniforms.highlight, { r: 1, g: 1, b: 1, a: 0.9 })
    const shadow = col(uniforms.shadow, { r: 0, g: 0, b: 0, a: 0.65 })
    const profile = num(uniforms.profile, 0)

    const at = (px: number, py: number): number => {
      const cx = Math.min(width - 1, Math.max(0, px))
      const cy = Math.min(height - 1, Math.max(0, py))
      return sdf[Math.trunc(cy) * width + Math.trunc(cx)]
    }
    const dist = sdf[y * width + x]
    const depthPx = Math.max(depth * inputs.pxScale, 0.01)
    if (dist >= 0) return none
    const t = clamp01(-dist / depthPx)
    let band = 1 - t
    if (profile < 0.5) band = Math.sin(band * 1.5707963267948966)
    else if (profile > 1.5) band = band * band
    const gx = at(x + 1, y) - at(x - 1, y)
    const gy = at(x, y + 1) - at(x, y - 1)
    const glen = Math.sqrt(gx * gx + gy * gy)
    if (glen < 0.0001) return none
    const rad = lightAngle * 0.017453292519943295
    const shade = -((gx / glen) * Math.cos(rad) + (gy / glen) * Math.sin(rad))
    const hi = clamp01(shade) * band * intensity * highlight.a
    const lo = clamp01(-shade) * band * intensity * shadow.a
    const a = clamp01(hi + lo)
    if (a < 0.0001) return none
    return {
      r: (highlight.r * hi + shadow.r * lo) / (hi + lo),
      g: (highlight.g * hi + shadow.g * lo) / (hi + lo),
      b: (highlight.b * hi + shadow.b * lo) / (hi + lo),
      a,
    }
  },
}
