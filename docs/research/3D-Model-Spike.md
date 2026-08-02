# v0.5 Research Spike — 3D Model Rendering in a 2D Canvas (Roadmap 6.1)

**Date:** 2026-08-02 · **Status:** complete — decision recorded in ADR-020,
validated by a committed prototype harness (`POLYFORM_3D_TEST=1`).
**Question:** how does Polyform render GLB models and PLY/SPZ gaussian
splats as posable canvas nodes — *render-of-3D-in-2D*, not a 3D editor —
without breaking the local-first, MIT-clean, zero-native-modules contract?

## Ground rules (from the roadmap)

1. **Composition, not modeling.** A MODEL3D node is posed (orbit/FOV/light
   preset) and composited under vectors and text. No mesh editing, ever.
2. **License-clean.** Every engine, loader, and runtime must be
   MIT-compatible. Same bar as ADR-019.
3. **Both renderers, identical semantics.** Canvas2D is the default
   backend, WebGPU the beta — whatever renders 3D must composite the same
   through `IRenderer` on both.
4. **Deterministic documents.** Reopening a `.poly` reproduces the render:
   pose/lighting are scene data; pixels re-derive from the same bytes.
5. **Zero native modules; no network.** Engines ship in the bundle.

## The architectural question: embedded engine vs bare WebGPU pipeline

| Approach | Verdict |
| :-- | :-- |
| **Embedded 3D engine rendering offscreen, composited as a texture** | **Chosen.** The document treats a MODEL3D node like an image whose pixels come from a hidden 3D canvas. Both `IRenderer` backends inherit identical semantics for free (Canvas2D `drawImage`, WebGPU `copyExternalImageToTexture` — the image-fill path that already exists). The 3D engine's own backend (WebGL2 vs WebGPU) becomes an invisible implementation detail. |
| Bare WebGPU pipeline beside ADR-016's segment stream | Rejected: means reimplementing glTF PBR + IBL, splat radix-sorting, and spherical-harmonics evaluation from scratch — XL effort duplicating mature MIT engines — and it couples the scene pass to 3D while leaving the default Canvas2D backend with nothing. |
| Live texture sharing (3D engine draws directly into the scene pass) | Rejected for v0.5: WebGL2↔WebGPU contexts can't share GPU textures in Chromium today; ImageBitmap snapshots measured fast enough (76 ms worst-case first snapshot at 512², cacheable to zero for static frames). Revisit if orbit interaction profiling demands. |

## Engine candidates (landscape as of 2026-08)

### GLB / meshes

| Engine | License | Verdict |
| :-- | :-- | :-- |
| **three.js r185** | **MIT** ✓ | **Chosen.** The industry-default web GLB path: `GLTFLoader.parseAsync(ArrayBuffer)` loads straight from content-addressed bytes; `RoomEnvironment` + PMREM gives studio-style PBR lighting **procedurally** (no HDRI assets to ship). WebGPURenderer has been production-ready since r171, but we deliberately run the WebGL2 `WebGLRenderer` — it's what the splat renderer requires (below), and inside the offscreen island the backend is invisible. |
| Babylon.js | Apache-2.0 ✓ | Runner-up. One engine covers GLB **and** splats (incl. SPZ v4 in recent releases) — but it's substantially heavier, its splat renderer trails Spark's, and splitting formats across two best-of-breed MIT libraries costs us nothing (they share the three.js scene graph). |
| PlayCanvas | MIT ✓ | Splat-first engine, but oriented to its own SOG format; SPZ is handled by CLI conversion (`splat-transform`), not an engine loader. Weaker GLB ecosystem than three. |
| `<model-viewer>` | Apache-2.0 ✓ | A DOM component, not an offscreen renderer — wrong shape (shapes must never be DOM nodes). |

### PLY / SPZ gaussian splats

| Renderer | License | Verdict |
| :-- | :-- | :-- |
| **Spark 2.1 (`@sparkjsdev/spark`, World Labs)** | **MIT** ✓ | **Chosen.** The current state-of-the-art web splat renderer: loads **.ply (INRIA + compressed), .spz, .splat, .ksplat, .sog**; `SplatMesh({ fileBytes })` is bytes-first; `initialized` promise; splats and meshes fuse in one three.js scene with correct sorting; Spark 2.0's LoD/paging system (`PagedSplats`) answers the roadmap's multi-million-splat memory-ceiling question directly. Rust/WASM internals are **inlined in the bundle** (workers spawn from blobs, WASM loads as a data: URL) — self-contained, packaging-safe. Requires three.js ≥ 0.180 with `WebGLRenderer` (WebGL2). |
| Babylon `GaussianSplattingMesh` | Apache-2.0 ✓ | Good and first-party, but pulls in all of Babylon; see above. |
| mkkellogg/GaussianSplats3D | MIT ✓ | The 2023-era default; functionally superseded by Spark (its .ksplat format is one of Spark's inputs). |
| Custom splat pipeline | — | Rejected with the bare-WebGPU option. |

### Format landscape notes (recorded for 6.4)

- **SPZ v4** (Niantic Spatial, May 2026): six zstd streams, no more 10M-point
  cap. Spark supports **SPZ v3** today; v4 is expected upstream. Escape
  hatches if user files outpace Spark: Spark exports its own `SpzReader` /
  `transcodeSpz`, and Niantic's reference `spz` library is MIT.
- **KHR_gaussian_splatting** (Khronos, release candidate 2026-02,
  ratification expected mid-2026): splats inside glTF/GLB, with SPZ as a
  compression option. When it lands in loaders, the GLB and splat paths
  converge — our one-island architecture already covers that future.

## Prototype (committed as the `POLYFORM_3D_TEST=1` harness)

`src/renderer/src/dev/model3d-test.ts` proves the full architecture inside
the **built** app (file:// renderer — the strictest packaging environment):
a GLB is authored → exported → re-parsed **from bytes** (no fixture
binary), rendered with RoomEnvironment PBR; a synthetic INRIA-format splat
PLY (4,000 gaussians, fibonacci shell) loads through Spark **from bytes**;
both frames composite through the exact ImageBitmap → Canvas2D path a
MODEL3D node will use, and pixel gates assert subject coverage, correct
color, and transparent background.

Measured (Ampere, 512² island):

| Step | Time |
| :-- | :-- |
| GLB parse (187 KB knot) | 5 ms |
| First GLB render (incl. PMREM bake) | 26 ms |
| Snapshot (ImageBitmap → 2D → pixels) | 76 ms first, cacheable |
| SplatMesh init from bytes (4k splats) | 113 ms |
| First sorted splat frame (worker spin-up incl.) | ~830 ms, then per-frame |
| Bundle cost (three + Spark + inlined WASM) | +6.5 MB **lazy** chunk — zero until a 3D feature loads |

**Two CSP lessons** (the ADR-015 class, new instance — both fixed in
`index.html`): Spark fetches its inlined WASM as a `data:` URL →
`connect-src` needs `data: blob:`; Spark's sort worker spawns from a blob →
`worker-src 'self' blob:` (script-src was the implicit fallback and blocked
it). Both are self-contained content; no network surface is widened.

## Decision (ADR-020)

**One hidden offscreen WebGL2 island — three.js r185 (`WebGLRenderer`) +
Spark 2.1 — renders every MODEL3D node on demand; the document and both
`IRenderer` backends see only snapshot textures.** GLB via
`GLTFLoader.parseAsync` bytes + procedural PMREM lighting presets; PLY/SPZ
via `SplatMesh({ fileBytes })`. Node schema (6.2) carries the asset hash,
orbit camera, and lighting preset; snapshots cache by (asset, pose,
preset, size) so static documents pay zero per frame.

## Acceptance gates for 6.2–6.4 (written now, tested then)

1. Drop a GLB and an SPZ into a document offline; both render.
2. Orbit interaction ≥ 30 fps at typical node sizes on mid hardware.
3. PNG export bakes the exact on-canvas render; SVG embeds the raster.
4. Reopen the `.poly`: pixel-parity with the pre-close render (fixture
   thresholds as in ADR-016).
5. License audit passes with three + Spark in the bundle.
6. A multi-million-splat capture either renders within a documented memory
   budget or degrades with a visible notice — never a crash.

## Sources

- [three.js releases](https://github.com/mrdoob/three.js/releases) · [WebGPURenderer production status (r171+, universal browser support late 2025)](https://www.utsubo.com/blog/threejs-2026-what-changed)
- [Spark repo (MIT)](https://github.com/sparkjsdev/spark) · [Spark 2.0 LoD/streaming announcement (World Labs)](https://www.worldlabs.ai/blog/spark-2.0) · [supported formats](https://sparkjs.dev/docs/loading-splats/)
- [Babylon.js gaussian splatting docs](https://doc.babylonjs.com/features/featuresDeepDive/mesh/gaussianSplatting) · [SPZ v4 + updates tracker](https://github.com/BabylonJS/Babylon.js/issues/16671)
- [PlayCanvas SOG format](https://blog.playcanvas.com/playcanvas-open-sources-sog-format-for-gaussian-splatting/) · [splat-transform CLI](https://github.com/playcanvas/splat-transform)
- [SPZ 4 announcement (Niantic Spatial)](https://www.nianticspatial.com/blog/spz4) · [spz reference library (MIT)](https://github.com/nianticlabs/spz)
- [KHR_gaussian_splatting release candidate (Khronos)](https://www.khronos.org/news/press/gltf-gaussian-splatting-press-release) · [extension spec](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_gaussian_splatting/README.md)
