# Polyform Roadmap

**Status:** Living document — updated as milestones land.
**Last updated:** 2026-07-31 (v0.1 ship day)

Polyform is a local-first, open-source desktop vector design tool. This roadmap lays out the phased delivery plan from the v0.1 release shipping today through the v1.0 distribution milestone, with per-item effort estimates and dependencies.

Related documents:

- [Product-Overview.md](./Product-Overview.md) — vision and architectural principles
- [Technical-Specification.md](./Technical-Specification.md) — target architecture (including the Rust/WASM core and WebGPU renderer that later phases deliver)

## Effort scale

| Size | Rough meaning |
| :--- | :--- |
| **S** | Days. Contained change, one subsystem, low design risk. |
| **M** | 1–2 weeks. Touches a few subsystems or needs a small design pass. |
| **L** | 2–6 weeks. New subsystem or significant data-model change. |
| **XL** | 6+ weeks. Architectural work, staged landing, or heavy unknowns. |

Estimates assume the current small-team cadence and include tests and docs. Dependencies listed are *hard* dependencies (cannot start meaningfully before), not merely nice-to-haves.

---

## v0.1 — NOW (shipping today)

Everything below is **implemented and shipping** in v0.1. The engine is TypeScript behind clean interfaces (`IRenderer`, `SceneGraph`, the Command/PatchOp system), rendering to HTML5 Canvas (GPU-composited Canvas2D). Shapes are never DOM or SVG nodes.

### Shell & architecture

- Electron + electron-vite + React 19 + TypeScript + Tailwind CSS 4, dark Figma-like UI
- TypeScript engine behind `IRenderer` / `SceneGraph` / Command-PatchOp interfaces (designed for the phase-4 Rust/WASM swap — see [the incremental port plan](#how-the-rust-port-lands-incrementally-without-a-rewrite))
- Spatial index (rbush R-tree) for hit-testing and viewport culling

### File format (`.poly` directory bundle)

- `manifest.json` — project metadata, viewport state, thumbnail reference
- `scene.bin` — binary MessagePack envelope (`PFRM1` magic + `schemaVersion`). FlatBuffers is deferred until `flatc` codegen is integrated; `docs/schema.fbs` ships in the repo as the target schema.
- `history.sqlite` — a real SQLite file written via sql.js (WASM, zero native deps)
- `assets/` — SHA-256 content-addressed, deduplicated media

### Editing features

- **Tools:** Move (V), Frame (F), Rectangle (R), Ellipse (O), Line (L), Polygon, Star, Pen (P) vector paths, Text (T), Hand (H)
- **Selection:** click, shift-multi, marquee, double-click drill-down, deep-select
- **Transforms:** move with axis lock; 8 resize handles + aspect lock; rotation handles; arrow nudge 1px / 10px
- **Viewport:** pan (space / middle-mouse / wheel), zoom-to-cursor (Ctrl+wheel), zoom to fit / 100%, pixel grid at high zoom + grid toggle
- **Snapping:** sibling edges/centers with red smart-guide lines
- **Layers panel:** tree with expand/collapse, rename, hide, lock, drag reorder + reparent, type icons
- **Inspector:** x/y/w/h/rotation/opacity; blend modes (Canvas2D-supported subset); corner radius uniform + per-corner; multiple fills (solid, linear/radial gradients, image fills with FILL/FIT/TILE/STRETCH); strokes (color, weight, align center/inside/outside — inside/outside via clip-based approximation, dash); effects (drop shadow, layer blur)
- **Boolean groups:** non-destructive union/subtract/intersect/exclude via polygon-flattening approximation (polygon-clipping lib)
- **Auto-layout:** horizontal/vertical, gap, padding, counter-axis align, hug contents (no wrap; partial vs Figma)
- **Text:** system fonts via Chromium `queryLocalFonts`; size/weight/italic, line height, letter spacing, align H+V, auto-resize modes, on-canvas edit overlay (shaping via Canvas2D — no HarfBuzz yet)
- **Images:** placement with content-addressed, deduplicated assets
- **Organization:** group/ungroup, frame selection, clip content, z-order ops, align 6-way + distribute H/V
- **Clipboard:** copy/paste/duplicate/delete (app-internal clipboard)
- **History:** unlimited undo/redo backed by an on-disk SQLite journal that survives app restarts (session-spanning history)
- **Files:** New/Open/Save/Save As, autosave (30s), recents, viewport-state persistence, document thumbnail
- **Export:** PNG (1x–4x) and SVG export of selection or frames
- **Desktop polish:** native menus, context menu, Figma-compatible keyboard shortcut map, status bar

### Known v0.1 limitations (honest partials)

| Area | State in v0.1 |
| :--- | :--- |
| Vector networks | Spec-shaped data model + pen-tool paths; no dedicated vector-edit mode UI, no branching-edge editing |
| Stroke align | Inside/outside is a clip-based approximation |
| Gradients | Minimal stop-editing UI |
| Blend modes | Canvas2D-supported subset only |
| Boolean ops | Flatten beziers to polygons — not exact curve CSG |
| Text shaping | Canvas2D metrics; no ligature/OpenType feature control |
| Snapping | Edges/centers only; no spacing guides |

Deliberately **out of scope** for the whole roadmap (local-first, single-user by design): realtime multiplayer collaboration, comments/threads, cloud file browser, FigJam-style whiteboarding, slides, video fills, AI features, org/team libraries, billing/SSO.

---

## v0.2 — Editing Depth

Goal: close the biggest day-to-day editing gaps against Figma for a single designer. Everything here builds on the v0.1 TypeScript engine — no engine swap required.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 2.1 | **Dedicated vector-edit mode** | **XL** | v0.1 vector-network data model | Enter/exit edit mode, vertex/handle manipulation, branching-edge editing on the existing spec-shaped network model; upgrades the pen tool from path-only to true network editing. |
| 2.2 | **Rulers + user guides** | **M** | — | Viewport rulers, draggable guides, guide snapping; guides persist in `scene.bin`. |
| 2.3 | **Masks** | **L** | — | Mask flag on nodes, mask-group render pass in the Canvas2D renderer behind `IRenderer` (so the future WebGPU backend inherits the same semantics). |
| 2.4 | **Constraints (pin/scale)** | **L** | — | Left/right/top/bottom/center/scale constraints relative to parent frame; interacts with auto-layout resolution order. |
| 2.5 | **Shared styles (color/text/effect)** | **L** | — | Style objects stored in the document; applied-by-reference with detach. Prerequisite for v0.3 shared libraries. |
| 2.6 | **Multi-page documents** | **M** | — | Page list in `manifest.json` + per-page scene roots in `scene.bin`; per-page viewport state; page switcher UI. |
| 2.7 | **Inner shadow + background blur** | **M** | — | Extends the v0.1 effects pipeline (drop shadow, layer blur); background blur needs a backdrop-capture pass in the renderer. |
| 2.8 | **Image crop / adjust** | **M** | — | Crop rect on image fills + basic adjustments (exposure/contrast/saturation); non-destructive, original asset stays content-addressed. |
| 2.9 | **SVG import** | **L** | 2.1 (for editable path fidelity) | Parse SVG into native nodes (paths → vector networks, groups/frames, fills/strokes/gradients); unsupported features rasterize with a warning. |
| 2.10 | **Gradient stop-editing UI (upgrade)** | **S** | — | Full on-canvas gradient handles + stop editor, closing a v0.1 partial. |
| 2.11 | **Spacing-guide snapping (upgrade)** | **S** | — | Equal-spacing red guides, closing a v0.1 partial. |

**Exit criteria:** a designer can produce production-quality static screens (masked imagery, styled type, multi-page files, imported SVG icons) without leaving Polyform.

---

## v0.3 — Systems

Goal: design-systems features — reuse, libraries, and history you can see. Still on the TypeScript engine.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 3.1 | **Components / variants / instances** | **XL** | v0.2 styles (2.5), constraints (2.4) | Main components, instance override model (fills, text, swaps), variant property groups. The single largest data-model addition on the roadmap; PatchOp system must learn override-aware diffing. |
| 3.2 | **Shared libraries as local files** | **L** | 3.1, 2.5 | A library is just another `.poly` on disk; documents subscribe by path, components/styles resolve by stable IDs, with an update-review flow when the library file changes. No cloud, consistent with local-first. |
| 3.3 | **Version-history browsing UI** | **M** | v0.1 SQLite journal (already on disk) | Timeline over `history.sqlite`: browse checkpoints, preview, restore-as-copy. The journal already survives restarts; this adds the read/browse surface. |
| 3.4 | **Plugin API sketch** | **M** | — | Design doc + a minimal sandboxed execution proof-of-concept (manifest format, scene-read API, typed message bridge). Deliberately a *sketch*: the stable API ships post-1.0, after the Rust core settles the object model. |

**Exit criteria:** a component-driven design system can live entirely in local files and be shared across documents by copying directories.

---

## v0.4 — Performance Core

Goal: swap the hot paths of the TypeScript engine for Rust/WASM and upgrade rendering and text, without breaking a single document or feature. Rust 1.97 toolchain is already installed and the interfaces were designed for this from day one. See [the incremental port plan](#how-the-rust-port-lands-incrementally-without-a-rewrite) below.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 4.1 | **Rust/WASM: geometry module** | **L** | — | Bezier math, bounds, flattening, path offsetting (fixes the stroke inside/outside approximation for real). First WASM module; establishes the build (wasm-pack/wasm-bindgen), CI, and TS↔WASM FFI conventions. |
| 4.2 | **Rust/WASM: boolean engine** | **L** | 4.1 | Exact curve-aware CSG replacing the polygon-flattening approximation. Drops the `polygon-clipping` dependency; same non-destructive boolean-group semantics. |
| 4.3 | **Rust/WASM: scene graph + spatial index** | **XL** | 4.1, 4.2 | Scene graph memory, BVH/R-tree, and the Command/PatchOp engine move to Rust; TS `SceneGraph` interface becomes a thin binding. FlatBuffers (`docs/schema.fbs`) becomes the live `scene.bin` format via `flatc` codegen, with a MessagePack→FlatBuffers migration reader kept for old files. |
| 4.4 | **WebGPU renderer backend** | **XL** | — (parallel to 4.1–4.3, behind `IRenderer`) | CanvasKit/Vello-style GPU backend as a second `IRenderer` implementation; Canvas2D remains the fallback. Full blend-mode set, correct backdrop effects, 60/120 FPS on 100k-shape scenes per the spec. |
| 4.5 | **HarfBuzz-wasm text shaping** | **L** | 4.4 (glyph atlas path) | Real shaping: ligatures, kerning, OpenType features, groundwork for variable fonts. Replaces Canvas2D metrics; Canvas2D shaping kept as fallback for the Canvas2D backend. |
| 4.6 | **Workers + SharedArrayBuffer** | **L** | 4.3 | WASM core moves into a dedicated worker with SharedArrayBuffer zero-copy access to vertex/index buffers, matching the process model in the Technical Specification. Requires cross-origin-isolation headers in the Electron renderer. |

**Exit criteria:** the perf targets in the Technical Specification hold (sub-millisecond hit tests, 100k+ shape scenes at 60/120 FPS), with byte-compatible document round-tripping verified against v0.3 files.

---

## v1.0 — Distribution

Goal: an app you can confidently recommend to someone who has never heard of the repo. CI groundwork for releases ships with v0.1; this milestone finishes the pipeline.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 5.1 | **Auto-update from GitHub Actions release artifacts** | **M** | v0.1 CI groundwork | electron-updater against GitHub Releases; staged rollout channel (latest/beta); delta updates where the platform supports them. |
| 5.2 | **Code signing** | **M** | 5.1 | Windows Authenticode + macOS Developer ID with notarization; Linux artifact checksums/signatures. Mostly certificate logistics + CI secrets plumbing. |
| 5.3 | **Crash reporting (opt-in)** | **S** | — | Electron crashReporter + renderer error capture, strictly opt-in, local queue with explicit send — consistent with local-first principles. |
| 5.4 | **`.fig` import investigation** | **L** | v0.3 components (3.1) for fidelity | Research spike + best-effort importer for the reverse-engineered Figma file format; explicitly labeled experimental, with a written fidelity report of what maps and what cannot. |
| 5.5 | **PDF export** | **M** | v0.4 geometry (4.1) preferred for exact curves | Vector PDF export of frames/pages (single and multi-page), embedding fonts where licensing allows. |

**Exit criteria:** signed installers on all three platforms, one-click updates, and a documented import/export story.

### Post-1.0 candidates (not scheduled)

Stable plugin API (from the 3.4 sketch), variable fonts & full OpenType feature UI, image adjustments beyond crop/basic, dev-mode/code inspect, additional import/export formats. These are intentionally unscheduled until v1.0 feedback exists.

---

## How the Rust port lands incrementally without a rewrite

The v0.1 TypeScript engine is not throwaway code — it is the reference implementation and the contract. Three seams were designed in from the start so that v0.4 is a series of swaps, not a rewrite:

1. **`IRenderer`** — the UI and engine never touch a drawing API directly; they talk to `IRenderer`. The v0.1 Canvas2D backend and the v0.4 WebGPU backend are peer implementations behind the same interface, selectable at runtime. This is also why masks (2.3) and effects are specified at the `IRenderer` level: every backend inherits identical semantics.
2. **`SceneGraph`** — all reads and mutations go through the `SceneGraph` interface; nothing in the UI reaches into node objects' internals. In v0.4 step 4.3 the implementation behind that interface becomes a WASM binding over Rust-owned memory, and the React chrome does not change.
3. **Command/PatchOp system** — every mutation is a serializable PatchOp applied through the command engine (this is also what the SQLite journal stores). Because ops are data, not closures, the *applier* can move to Rust while op producers (tools, inspector) stay in TypeScript, and the on-disk journal format stays valid across the swap.

The port order is chosen so each module is independently swappable and testable:

```
geometry (4.1)  →  booleans (4.2)  →  scene graph + index + command engine (4.3)
     |                  |                          |
     └── pure functions └── pure functions         └── owns state; last, hardest,
         easiest to          with golden-file          lands behind the SceneGraph
         differential-test   tests vs TS output        interface + FlatBuffers I/O
```

Rules of engagement for every module swap:

- **Differential testing:** the TS implementation stays in-tree during the transition and CI runs both engines against the same golden inputs; a swap merges only when outputs match (or divergences are documented improvements, e.g. exact curve CSG vs polygon approximation).
- **Feature flag per module:** each WASM module ships dark behind a runtime flag before becoming the default, so a regression is a flag flip away from mitigation.
- **No format cliffs:** `scene.bin` migrates MessagePack (`PFRM1`) → FlatBuffers only at step 4.3, with a permanent read path for old envelopes; `history.sqlite` schema is unchanged by the port.
- **UI untouched:** React 19 chrome, panels, and tools code do not know which engine is running. If a swap requires UI changes, the interface — not the UI — is what gets fixed.

WebGPU (4.4) and HarfBuzz (4.5) follow the same pattern on the `IRenderer` seam and the text-measurement seam respectively, and the worker/SharedArrayBuffer move (4.6) is possible precisely because by then the engine state lives in Rust-owned linear memory rather than JS object graphs.
