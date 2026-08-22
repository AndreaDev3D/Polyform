// Glassmorphism — the backdrop-class exemplar, and the one shader that does
// NOT go through the island: it needs the live pixels behind the shape, so
// each renderer implements it against its own backdrop machinery (the ONE
// pass split on the GPU, the device-space self-draw on Canvas2D), both fed
// by the same resolved parameters (materials/plan.ts glassParamsFor).
//
// The wgsl field is empty by design — mode 15 of FX_WGSL is the GPU
// implementation. Class 'backdrop' is refused for project shaders, so no
// user content ever depends on this exception.
//
// Noise is GPU-only and its amplitude is CAPPED at 0.08: mean-zero grain of
// ±0.04 is at most ±10/255 per channel, under the parity harness's 24/255
// pixel threshold — which is what lets Canvas2D omit it honestly rather than
// fake a matching noise field (documented in the Feature Matrix).

import type { RegisteredShader } from '../registry'

export const glass: Omit<RegisteredShader, 'builtin'> = {
  manifest: {
    id: 'glass',
    name: 'Glassmorphism',
    class: 'backdrop',
    uniforms: [
      { key: 'blur', label: 'Blur', type: 'float', default: 14, min: 0, max: 64, step: 0.5 },
      { key: 'tint', label: 'Tint', type: 'color', default: { r: 1, g: 1, b: 1, a: 0.12 } },
      { key: 'saturation', label: 'Saturation', type: 'float', default: 1.15, min: 0, max: 2, step: 0.01 },
      { key: 'edgeWidth', label: 'Edge Width', type: 'float', default: 1.5, min: 0, max: 8, step: 0.25 },
      { key: 'edgeColor', label: 'Edge Color', type: 'color', default: { r: 1, g: 1, b: 1, a: 1 } },
      { key: 'edgeIntensity', label: 'Edge Intensity', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01 },
      { key: 'noise', label: 'Noise', type: 'float', default: 0.02, min: 0, max: 0.08, step: 0.005 },
    ],
    fallback: { r: 0.85, g: 0.87, b: 0.9, a: 0.35 },
  },
  wgsl: '',
}
