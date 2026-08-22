// Pixelate / mosaic — the base-class exemplar: the node's own fills arrive as
// the src input, and every pixel takes the colour sampled at its cell's
// centre. Cell size is in document units (multiplied by pxScale so zooming
// re-rasters crisply instead of scaling stale mosaic pixels).

import type { RegisteredShader } from '../registry'
import type { MaterialUniformValue } from '../../types'

const num = (v: MaterialUniformValue, d: number): number => (typeof v === 'number' ? v : d)

export const pixelate: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'pixelate',
    name: 'Pixelate',
    class: 'base',
    uniforms: [{ key: 'cell', label: 'Cell Size', type: 'float', default: 12, min: 1, max: 200, step: 1 }],
    fallback: { r: 0.55, g: 0.55, b: 0.58, a: 1 },
  },

  wgsl: /* wgsl */ `
fn material(p: vec2f, size: vec2f, src: vec4f) -> vec4f {
  let cellPx = max(cell * u.info.z, 1.0);
  let cx = clamp((floor(p.x / cellPx) + 0.5) * cellPx, 0.0, size.x - 1.0);
  let cy = clamp((floor(p.y / cellPx) + 0.5) * cellPx, 0.0, size.y - 1.0);
  return textureLoad(src_tex, vec2i(i32(cx), i32(cy)), 0);
}
`,

  twin: (x, y, width, height, uniforms, inputs) => {
    const src = inputs.src
    if (!src) return { r: 0, g: 0, b: 0, a: 0 }
    const cellPx = Math.max(num(uniforms.cell, 12) * inputs.pxScale, 1)
    const cx = Math.min(width - 1, Math.max(0, (Math.floor(x / cellPx) + 0.5) * cellPx))
    const cy = Math.min(height - 1, Math.max(0, (Math.floor(y / cellPx) + 0.5) * cellPx))
    const i = (Math.trunc(cy) * width + Math.trunc(cx)) * 4
    return { r: src[i] / 255, g: src[i + 1] / 255, b: src[i + 2] / 255, a: src[i + 3] / 255 }
  },
}
