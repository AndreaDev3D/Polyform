# Shaders & Materials

A **material** is a shader plus its uniform values, worn by a shape (Unity's vocabulary). Polyform
ships twelve built-in shaders, and a project can carry its own in the bundle:

```
MyPoster/
  MyPoster.poly
  scene.bin
  assets/…
  shaders/
    brushed-gold/
      shader.json      the manifest
      shader.wgsl      the body
```

Project shaders travel with the folder like everything else — copy the project, the shader comes
along. They load when the project opens and on **Plugins → Reload Project Shaders** (nothing is
watched; the same import-on-use rule libraries follow). Ids are namespaced: the folder above is
`project:brushed-gold` in documents and in `edit_document`.

## The architecture in one paragraph

Shader output is rasterized once, on a dedicated GPU device (the *material island*), into a
content-addressed bitmap cache that **both** renderers composite — Canvas2D as a clipped
`drawImage`, WebGPU as an ordinary texture on the shape's own mesh. That is why materials appear
identically on both backends, in PNG exports, thumbnails and agent snapshots. Built-in shaders
also carry a per-pixel TypeScript twin (held to the WGSL by a machine gate) so they render with no
GPU at all; project shaders are WGSL-only and fall back to their declared `fallback` colour on a
machine with no WebGPU — labelled in the Inspector, never silent. A broken shader is a per-shader
error carrying the compiler's message; it cannot take the renderer down. (ADR-030 has the full
reasoning.)

## shader.json

```json
{
  "id": "brushed-gold",
  "name": "Brushed Gold",
  "class": "procedural",
  "uniforms": [
    { "key": "angle",  "label": "Angle",  "type": "float", "default": 35, "min": -180, "max": 180, "step": 1 },
    { "key": "tint",   "label": "Tint",   "type": "color", "default": { "r": 0.9, "g": 0.7, "b": 0.3, "a": 1 } },
    { "key": "flip",   "label": "Flip",   "type": "bool",  "default": false },
    { "key": "mode",   "label": "Mode",   "type": "enum",  "default": 0, "options": ["Soft", "Hard"] }
  ],
  "fallback": { "r": 0.75, "g": 0.62, "b": 0.3, "a": 1 }
}
```

- **class** — `procedural` (a pure function of position) or `base` (transforms the shape's own
  fills, which arrive as an input). `sdf` and `backdrop` are reserved for built-ins in this
  release: they impose renderer obligations (distance fields, a render-pass split) that project
  content does not get to demand yet.
- **uniforms** — at most **12**, one vec4 slot each. Types: `float`, `color`, `vec2`, `bool`,
  `enum` (stored as the option index). `min`/`max` clamp, `step` drives the Inspector scrub and
  the raster cache's quantization. A manifest with 13 uniforms is a *refusal naming the shader*,
  not a shader with 12.
- **fallback** — what draws (clipped to the shape) when the shader cannot run.
- Caps: ≤32 shaders per project, `shader.wgsl` ≤64 KiB, `shader.json` ≤8 KiB. The folder name is
  the id: lowercase letters, digits, `-`, `_`.

## shader.wgsl

Write **one function** — the wrapper generates the rest of the module (uniform block, bindings,
entry points):

```wgsl
fn material(p: vec2f, size: vec2f) -> vec4f {          // procedural
fn material(p: vec2f, size: vec2f, src: vec4f) -> vec4f {  // base
```

- `p` — the pixel, `(0,0)` top-left of the shape's raster; `size` — the raster in pixels.
- Uniforms are in scope as **bare names** — write `angle`, not an accessor. `float`/`bool`/`enum`
  arrive as `f32` (bool is 0/1, enum is the option index), `color` as `vec4f`, `vec2` as `vec2f`.
- `u.info.z` is **pxScale** — device pixels per document unit. Multiply lengths the user thinks of
  in document units by it, or your pattern will change size with zoom.
- Return **straight alpha**. Blending is off; what you return is what is stored.
- `base` shaders may also read `src_tex` directly (`textureLoad(src_tex, vec2i(...), 0)`) to
  sample somewhere other than the current pixel — that is how pixelate works.
- Helper functions above `fn material` are fine; they cannot see uniforms (WGSL has no
  module-scope view of them) — pass values in.

**Determinism rule worth stealing from the built-ins:** if you want noise, hash *integer pixel
coordinates* with u32 arithmetic. `fract(sin(x) * 43758…)` gives a different field on every
GPU/driver; an integer hash gives the same field everywhere, which is what makes output cacheable
and comparable.

## What a material costs

One texture draw — the cost class of an image fill. Output is cached by content (shader id +
source hash + quantized uniforms + size bucket ≤1024px + class inputs) with a 64 MiB LRU budget,
so panning and re-baking never re-run a shader; only edits to the material (or, for `base`, to the
fills under it) do. While a raster produces, the previous one draws (stale-until-swap), which is
what keeps uniform scrubbing smooth.

## Failure states (what you will see)

| State | Canvas | Inspector |
| --- | --- | --- |
| Folder missing / bad manifest / WGSL error | fills only | the error, verbatim (compiler line for WGSL) |
| Referenced shader not in the project | fills only | the id + "not found in shaders/" |
| No GPU + project shader | the `fallback` colour, clipped | "GPU unavailable — showing fallback colour" |

## Agents

`edit_document` accepts `material: { shader, uniforms? }` (null clears). The shader id is checked
against the registry — a typo lists the known ids — and uniforms are validated against the
manifest. Node reads carry `material` and `materialStatus`, so an agent can tell applied from
broken.
