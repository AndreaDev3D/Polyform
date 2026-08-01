// WGSL shaders for the WebGPU scene backend (Sprint D).
// Coordinate flow: world-space vertex -> camera uniform (translate+zoom+dpr)
// -> NDC. Colors are premultiplied alpha throughout.

/** Camera uniform shared by every pipeline (size 32 bytes). */
export const CAMERA_WGSL = /* wgsl */ `
struct Camera {
  // x, y: world coord at viewport top-left; z: zoom * dpr
  origin_zoom: vec3<f32>,
  _pad0: f32,
  // viewport size in device px
  viewport: vec2<f32>,
  _pad1: vec2<f32>,
}
@group(0) @binding(0) var<uniform> camera: Camera;

fn world_to_ndc(world: vec2<f32>) -> vec4<f32> {
  let device = (world - camera.origin_zoom.xy) * camera.origin_zoom.z;
  let ndc = vec2<f32>(
    device.x / camera.viewport.x * 2.0 - 1.0,
    1.0 - device.y / camera.viewport.y * 2.0,
  );
  return vec4<f32>(ndc, 0.0, 1.0);
}
`

/** Batched solid geometry: world-space positions + premultiplied vertex color. */
export const SOLID_WGSL = /* wgsl */ `
${CAMERA_WGSL}

struct VsIn {
  @location(0) pos: vec2<f32>,
  @location(1) color: vec4<f32>, // unorm8x4, premultiplied
}
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vs(in: VsIn) -> VsOut {
  var out: VsOut;
  out.pos = world_to_ndc(in.pos);
  out.color = in.color;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return in.color;
}
`

/**
 * Stencil geometry: writes/clears clip regions (color writes disabled by the
 * pipeline). Vertices are world-space.
 */
export const STENCIL_WGSL = /* wgsl */ `
${CAMERA_WGSL}

@vertex
fn vs(@location(0) pos: vec2<f32>) -> @builtin(position) vec4<f32> {
  return world_to_ndc(pos);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}
`

/**
 * Per-node draws in LOCAL space with a world matrix uniform: gradients.
 * Gradient params mirror the Canvas2D backend: start/end in normalized node
 * space, stops clamped 0..1, colors multiplied by paint+node opacity.
 */
export const GRADIENT_WGSL = /* wgsl */ `
${CAMERA_WGSL}

struct GradientUniform {
  mat0: vec4<f32>,   // a, b, c, d of the world matrix
  mat1: vec4<f32>,   // e, f, node width, node height
  start_end: vec4<f32>, // start.xy, end.xy in node space (already * w/h)
  // kind: 0 linear, 1 radial; count; opacity; radial radius
  params: vec4<f32>,
  offsets0: vec4<f32>,
  offsets1: vec4<f32>,
  colors: array<vec4<f32>, 8>,
}
@group(1) @binding(0) var<uniform> grad: GradientUniform;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
}

@vertex
fn vs(@location(0) pos: vec2<f32>) -> VsOut {
  let world = vec2<f32>(
    grad.mat0.x * pos.x + grad.mat0.z * pos.y + grad.mat1.x,
    grad.mat0.y * pos.x + grad.mat0.w * pos.y + grad.mat1.y,
  );
  var out: VsOut;
  out.pos = world_to_ndc(world);
  out.local = pos;
  return out;
}

fn stop_offset(i: u32) -> f32 {
  if (i < 4u) { return grad.offsets0[i]; }
  return grad.offsets1[i - 4u];
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  var t: f32;
  let s = grad.start_end.xy;
  let e = grad.start_end.zw;
  if (grad.params.x < 0.5) {
    let d = e - s;
    let len2 = max(dot(d, d), 1e-6);
    t = dot(in.local - s, d) / len2;
  } else {
    t = distance(in.local, s) / max(grad.params.w, 1e-3);
  }
  t = clamp(t, 0.0, 1.0);
  let count = u32(grad.params.y);
  var color = grad.colors[0];
  if (count > 0u) {
    color = grad.colors[0];
    for (var i = 1u; i < 8u; i = i + 1u) {
      if (i >= count) { break; }
      let o0 = stop_offset(i - 1u);
      let o1 = stop_offset(i);
      let f = clamp((t - o0) / max(o1 - o0, 1e-6), 0.0, 1.0);
      color = mix(color, grad.colors[i], f);
    }
  }
  // straight alpha in the uniform -> premultiply, then node/paint opacity
  let a = color.a * grad.params.z;
  return vec4<f32>(color.rgb * a, a);
}
`

/**
 * Textured quad draws in LOCAL space: image fills and text rasters.
 * uv_transform maps local px -> uv; adjust = (exposure, contrast, saturation)
 * as brightness/contrast/saturate filter equivalents.
 */
export const TEXTURE_WGSL = /* wgsl */ `
${CAMERA_WGSL}

struct TexUniform {
  mat0: vec4<f32>,      // a, b, c, d
  mat1: vec4<f32>,      // e, f, opacity, unused
  uv_scale_off: vec4<f32>, // uv = local * scale + offset
  adjust: vec4<f32>,    // brightness, contrast, saturation, tile(0/1)
}
@group(1) @binding(0) var<uniform> tex_u: TexUniform;
@group(1) @binding(1) var samp: sampler;
@group(1) @binding(2) var tex: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@location(0) pos: vec2<f32>) -> VsOut {
  let world = vec2<f32>(
    tex_u.mat0.x * pos.x + tex_u.mat0.z * pos.y + tex_u.mat1.x,
    tex_u.mat0.y * pos.x + tex_u.mat0.w * pos.y + tex_u.mat1.y,
  );
  var out: VsOut;
  out.pos = world_to_ndc(world);
  out.uv = pos * tex_u.uv_scale_off.xy + tex_u.uv_scale_off.zw;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  var uv = in.uv;
  var mask = 1.0;
  if (tex_u.adjust.w > 0.5) {
    uv = fract(uv);
  } else if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    // No early return: textureSample requires uniform control flow.
    mask = 0.0;
  }
  var c = textureSample(tex, samp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0))) * mask;
  // un-premultiply for filter math (textures upload premultiplied)
  let alpha = max(c.a, 1e-5);
  var rgb = c.rgb / alpha;
  // brightness (exposure)
  rgb = rgb * tex_u.adjust.x;
  // contrast about 0.5
  rgb = (rgb - vec3<f32>(0.5)) * tex_u.adjust.y + vec3<f32>(0.5);
  // saturation via luma
  let luma = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3<f32>(luma), rgb, tex_u.adjust.z);
  rgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let a = c.a * tex_u.mat1.z;
  return vec4<f32>(rgb * a, a);
}
`

/**
 * Batched glyph quads from the shared atlas (Sprint E): world-space
 * positions + uv + premultiplied per-node color; the atlas holds white
 * glyphs, so alpha carries the coverage.
 */
export const GLYPH_WGSL = /* wgsl */ `
${CAMERA_WGSL}

struct VsIn {
  @location(0) pos: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>, // unorm8x4, premultiplied
}
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
}
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var atlas: texture_2d<f32>;

@vertex
fn vs(in: VsIn) -> VsOut {
  var out: VsOut;
  out.pos = world_to_ndc(in.pos);
  out.uv = in.uv;
  out.color = in.color;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let coverage = textureSample(atlas, samp, in.uv).a;
  return in.color * coverage;
}
`

/**
 * Fullscreen blur pass (separable gaussian, direction in params0.xy, radius
 * in texture px). σ = radius/2 to match Canvas2D shadowBlur / CSS blur().
 * Flag bits: 1 = read (1 − alpha) instead of alpha (inner shadows),
 * 2 = replace color with tint × blurred alpha (shadow passes),
 * 4 = multiply the result by the mask texture's alpha (inner shadows).
 * params1.xy shifts every source sample (shadow offset, in texture px).
 */
export const BLUR_WGSL = /* wgsl */ `
struct BlurUniform {
  // direction.xy (unit), radius in px, flags
  params0: vec4<f32>,
  // sample offset in px, unused
  params1: vec4<f32>,
  // tint color (premultiplied) for shadow passes
  tint: vec4<f32>,
}
@group(0) @binding(0) var<uniform> blur_u: BlurUniform;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var mask: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  var out: VsOut;
  out.pos = vec4<f32>(corners[vi], 0.0, 1.0);
  out.uv = corners[vi] * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let radius = blur_u.params0.z;
  let flags = u32(blur_u.params0.w);
  let dims = vec2<f32>(textureDimensions(src));
  let base = in.uv + blur_u.params1.xy / dims;
  let texel = blur_u.params0.xy / dims;
  var sum = vec4<f32>(0.0);
  var weight_sum = 0.0;
  let sigma = max(radius / 2.0, 0.5);
  let taps = i32(clamp(radius * 1.5, 1.0, 64.0));
  let invert = (flags & 1u) != 0u;
  for (var i = -taps; i <= taps; i = i + 1) {
    let w = exp(-f32(i * i) / (2.0 * sigma * sigma));
    var s = textureSample(src, samp, base + texel * f32(i));
    if (invert) { s = vec4<f32>(0.0, 0.0, 0.0, 1.0 - s.a); }
    sum = sum + s * w;
    weight_sum = weight_sum + w;
  }
  var c = sum / weight_sum;
  if ((flags & 2u) != 0u) {
    // shadow pass: replace color with tint scaled by blurred alpha
    c = blur_u.tint * c.a;
  }
  // The mask sample must stay in uniform control flow.
  let m = textureSample(mask, samp, in.uv);
  if ((flags & 4u) != 0u) {
    c = c * m.a;
  }
  return c;
}
`

/** Blit a texture onto the target 1:1 (final resolve -> canvas pass). */
export const COMPOSITE_WGSL = /* wgsl */ `
struct CompositeUniform {
  // offset in device px, opacity, unused
  params: vec4<f32>,
}
@group(0) @binding(0) var<uniform> comp_u: CompositeUniform;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  var out: VsOut;
  out.pos = vec4<f32>(corners[vi], 0.0, 1.0);
  out.uv = corners[vi] * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(src));
  let uv = in.uv - comp_u.params.xy / dims;
  // No early return: textureSample requires uniform control flow.
  var mask = 1.0;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { mask = 0.0; }
  let c = textureSample(src, samp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)));
  return c * comp_u.params.z * mask;
}
`

/**
 * Effect composites drawn INSIDE the scene pass (MSAA, stencil-tested):
 * pre-rendered fx layer textures (shadows, layer blurs, isolated blends) as
 * world-anchored quads, plus the background-blur mask-mesh draw.
 *
 * mode = 0: plain premultiplied source-over of the layer texture.
 * mode = 1: sample the blurred BACKDROP at the fragment's screen position and
 *           write it opaque (background blur — geometry supplies coverage).
 * mode >= 2: W3C blend modes against the (opaque) backdrop:
 *           2 OVERLAY 3 DARKEN 4 LIGHTEN 5 COLOR_DODGE 6 COLOR_BURN
 *           7 HARD_LIGHT 8 SOFT_LIGHT 9 DIFFERENCE 10 EXCLUSION
 *           11 HUE 12 SATURATION 13 COLOR 14 LUMINOSITY
 * (NORMAL/MULTIPLY/SCREEN never route here — they are fixed-function.)
 */
export const FX_WGSL = /* wgsl */ `
${CAMERA_WGSL}

struct FxUniform {
  mat0: vec4<f32>,   // a, b, c, d (identity for world-space quads)
  mat1: vec4<f32>,   // e, f, opacity, mode
  // layer-texture mapping: uv = (world - origin) * uv_scale
  origin_scale: vec4<f32>,
  _pad: vec4<f32>,
}
@group(1) @binding(0) var<uniform> fx_u: FxUniform;
@group(1) @binding(1) var samp: sampler;
@group(1) @binding(2) var layer: texture_2d<f32>;
@group(1) @binding(3) var backdrop: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@location(0) pos: vec2<f32>) -> VsOut {
  let world = vec2<f32>(
    fx_u.mat0.x * pos.x + fx_u.mat0.z * pos.y + fx_u.mat1.x,
    fx_u.mat0.y * pos.x + fx_u.mat0.w * pos.y + fx_u.mat1.y,
  );
  var out: VsOut;
  out.pos = world_to_ndc(world);
  out.uv = (world - fx_u.origin_scale.xy) * fx_u.origin_scale.zw;
  return out;
}

fn lum(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.3, 0.59, 0.11));
}

fn clip_color(c_in: vec3<f32>) -> vec3<f32> {
  var c = c_in;
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  if (n < 0.0) { c = l + (c - l) * l / max(l - n, 1e-6); }
  if (x > 1.0) { c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6); }
  return c;
}

fn set_lum(c: vec3<f32>, l: f32) -> vec3<f32> {
  return clip_color(c + (l - lum(c)));
}

fn sat(c: vec3<f32>) -> f32 {
  return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
}

fn set_sat(c_in: vec3<f32>, s: f32) -> vec3<f32> {
  let mn = min(c_in.r, min(c_in.g, c_in.b));
  let mx = max(c_in.r, max(c_in.g, c_in.b));
  if (mx <= mn + 1e-6) { return vec3<f32>(0.0); }
  return (c_in - mn) * s / (mx - mn);
}

fn hard_light(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
  let lo = 2.0 * cs * cb;
  let hi = vec3<f32>(1.0) - 2.0 * (1.0 - cs) * (1.0 - cb);
  return select(hi, lo, cs <= vec3<f32>(0.5));
}

fn soft_light(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
  let d = select(sqrt(cb), ((16.0 * cb - 12.0) * cb + 4.0) * cb, cb <= vec3<f32>(0.25));
  let lo = cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
  let hi = cb + (2.0 * cs - 1.0) * (d - cb);
  return select(hi, lo, cs <= vec3<f32>(0.5));
}

fn blend_rgb(mode: u32, cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
  switch (mode) {
    case 2u: { return hard_light(cs, cb); } // overlay = hardlight swapped
    case 3u: { return min(cb, cs); }
    case 4u: { return max(cb, cs); }
    case 5u: { // color-dodge
      let r = select(min(vec3<f32>(1.0), cb / max(1.0 - cs, vec3<f32>(1e-6))), vec3<f32>(1.0), cs >= vec3<f32>(1.0));
      return select(r, vec3<f32>(0.0), cb <= vec3<f32>(0.0));
    }
    case 6u: { // color-burn
      let r = select(1.0 - min(vec3<f32>(1.0), (1.0 - cb) / max(cs, vec3<f32>(1e-6))), vec3<f32>(0.0), cs <= vec3<f32>(0.0));
      return select(r, vec3<f32>(1.0), cb >= vec3<f32>(1.0));
    }
    case 7u: { return hard_light(cb, cs); }
    case 8u: { return soft_light(cb, cs); }
    case 9u: { return abs(cb - cs); }
    case 10u: { return cb + cs - 2.0 * cb * cs; }
    case 11u: { return set_lum(set_sat(cs, sat(cb)), lum(cb)); }
    case 12u: { return set_lum(set_sat(cb, sat(cs)), lum(cb)); }
    case 13u: { return set_lum(cs, lum(cb)); }
    case 14u: { return set_lum(cb, lum(cs)); }
    default: { return cs; }
  }
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  // Both samples unconditional: textureSample needs uniform control flow.
  let lc = textureSample(layer, samp, clamp(in.uv, vec2<f32>(0.0), vec2<f32>(1.0)));
  let screen_uv = in.pos.xy / camera.viewport;
  let bd = textureSample(backdrop, samp, screen_uv);
  let opacity = fx_u.mat1.z;
  let mode = u32(fx_u.mat1.w);
  // Outside the layer texture there is nothing to composite (modes 0 and 2+).
  var edge = 1.0;
  if (in.uv.x < 0.0 || in.uv.x > 1.0 || in.uv.y < 0.0 || in.uv.y > 1.0) { edge = 0.0; }
  if (mode == 0u) {
    return lc * edge * opacity;
  }
  if (mode == 1u) {
    // Blurred backdrop, opaque inside the mask geometry.
    return vec4<f32>(bd.rgb, 1.0);
  }
  let as_ = lc.a * edge * opacity;
  let cs = lc.rgb / max(lc.a, 1e-5);
  // The scene target is opaque, so backdrop rgb is already straight color.
  let b = blend_rgb(mode, clamp(bd.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(cs, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(b * as_, as_);
}
`
