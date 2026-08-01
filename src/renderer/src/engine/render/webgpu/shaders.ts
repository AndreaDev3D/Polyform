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
 * Fullscreen blur pass (separable gaussian, direction in params). Used by
 * drop/inner shadows, layer blur and background blur.
 */
export const BLUR_WGSL = /* wgsl */ `
struct BlurUniform {
  // direction.xy (unit), radius in px, unused
  params: vec4<f32>,
  // tint color (premultiplied) for shadow passes; a=0 disables tinting
  tint: vec4<f32>,
}
@group(0) @binding(0) var<uniform> blur_u: BlurUniform;
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
  let radius = blur_u.params.z;
  let dims = vec2<f32>(textureDimensions(src));
  let texel = blur_u.params.xy / dims;
  var sum = vec4<f32>(0.0);
  var weight_sum = 0.0;
  let sigma = max(radius / 2.0, 0.5);
  let taps = i32(min(radius, 64.0));
  for (var i = -taps; i <= taps; i = i + 1) {
    let w = exp(-f32(i * i) / (2.0 * sigma * sigma));
    sum = sum + textureSample(src, samp, in.uv + texel * f32(i)) * w;
    weight_sum = weight_sum + w;
  }
  var c = sum / weight_sum;
  if (blur_u.tint.a > 0.0) {
    // shadow pass: replace color with tint scaled by blurred alpha
    c = blur_u.tint * c.a;
  }
  return c;
}
`

/** Composite a texture onto the target 1:1 (premultiplied source-over). */
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
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4<f32>(0.0);
  }
  return textureSample(src, samp, uv) * comp_u.params.z;
}
`
