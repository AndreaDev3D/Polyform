# Polyform Roadmap

**Status:** Living document — updated as milestones land.
**Last updated:** 2026-08-01 (v0.4 Sprints A–E shipped; v0.4.1 / v0.5 / v0.6 phases added)

Polyform is a local-first, open-source desktop vector design tool. This roadmap lays out the phased delivery plan with per-item effort estimates and dependencies: **v0.2 ✓ → v0.3 ✓ → v0.4 Performance Core (in progress) → v0.4.1 Background Removal → v0.5 3D Model Import → v0.6 Agent Connectivity (MCP + CLI) → v1.0 Distribution**. The three phases between v0.4 and v1.0 are committed in intent but deliberately unspecified — each opens with a research spike that picks the best implementation and records it as an ADR before code is written. (Item ids are stable labels, not phase order: v1.0 keeps its historical 5.x ids.)

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

> **Status: shipped in v0.2.0.** Notes: 2.3 masks are shape-clip based (no luminance masks); 2.9 SVG gradients fall back to solid fills; 2.10 shipped as the inspector stop editor (on-canvas gradient handles still pending); 2.11 shipped as equal-spacing snap (no measurement labels yet).

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

> **Status: shipped in v0.3.0.** Notes: 3.1 shipped as materialized instances with journaled overrides, swap and detach — variant property groups remain 📋 (instance swap is the interim mechanism); 3.2 libraries are import-on-use with a manual update pull (no file watching); 3.3 shipped as the journal timeline (fork via Save As rather than restore-as-copy); 3.4 shipped as the dev-preview runner + design doc.

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

> **Preparation:** the concrete execution plan — module inventory with port priorities, the three API contracts, WASM embedding rules, verification gates and sprint sequencing — lives in [V0.4-Porting-Plan.md](V0.4-Porting-Plan.md). The current object model the Rust core must implement is [schema.fbs](schema.fbs) (document schema v3).
>
> **Status — Sprints A–E shipped (2026-08-01):** The full engine surface (4.1 geometry incl. lyon tessellation, 4.2 exact CSG — 2.02x faster than polygon-clipping and default, plus scene/commands/constraints/hit-test/components/layout/serialization) has fuzz-proven Rust twins behind the per-module backend switch (ADR-015); spatial index, booleans and text shaping run on Rust by default. **4.4 (WebGPU) shipped as a beta, complete with the effects/blend compositor**: 11/11 pixel-parity fixtures incl. shadows, blurs, all 16 blend modes and shaped text (ADR-016/017), and the **100k-shapes-at-60fps exit test passing**. **4.5 (text stack) shipped**: rustybuzz shaping + engine layout + the WebGPU glyph atlas (ADR-018, closes F-02's core). **v0.4.0 closed 2026-08-02** with the `color.ts` parity port; the 4.3/4.6 worker/scene-memory flip is **deferred with a written trigger** (profiled edit stalls on real documents, or v0.5's 3D pipeline demanding renderer-side workers) and a precondition (op-coverage audit) — details in [V0.4-Porting-Plan.md](V0.4-Porting-Plan.md). Exit criteria met: 100k-shape scenes verified at 60fps, byte-compatible round-tripping proven by the serialization parity gates.

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

## v0.4.1 — Image Background Removal

> **Research-first, no spec yet (by design).** Nothing below is decided —
> item 4.7 is a comparison spike whose output is an ADR picking the best
> implementation, and only then does 4.8 get built. Same rule for v0.5 and
> v0.6: feature intent is committed here; the digging happens when the
> phase starts.

Goal: one-click "Remove background" on image fills — **fully offline** (a cloud API would break the local-first contract), non-destructive, and undoable like every other edit.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 4.7 | **Research spike: on-device segmentation/matting** | **S** | — | ✅ **Done (2026-08-02)** — comparison in [research/BG-Removal-Spike.md](research/BG-Removal-Spike.md), decision in ADR-019: bundled ISNet quint8 (~44 MB, Apache-2.0) on onnxruntime-web (WASM baseline, WebGPU EP opportunistic) in a Web Worker; RMBG disqualified on license, the AGPL wrapper library avoided, BiRefNet_lite (MIT) pre-approved as a consent-gated quality tier if needed. |
| 4.8 | **Remove background on image fills** | **M** | 4.7 | One click in the inspector. Non-destructive: the cutout is written as a NEW SHA-256 content-addressed asset, the original stays in `assets/`, and "Restore original" swaps back; single journal entry; composes with the existing crop/adjust controls. |
| 4.9 | Edge refinement brush (stretch) | **M** | 4.8 | Restore/erase strokes over the mask for hairlines and soft edges — only if 4.8's model quality proves it necessary. |

**Exit criteria:** subject cutout works with the network cable unplugged, on a license-clean model, and undo restores the original pixel-for-pixel.

---

## v0.5 — 3D Model Import (composition, not modeling)

Goal: place 3D models on the canvas as first-class nodes — orbit them into the right pose, light them, and use the render to make graphics. Polyform stays a 2D tool; this is **render-of-3D-in-2D**, not a 3D editor. Target formats: **GLB** (meshes/PBR) and **PLY / SPZ** (point clouds and gaussian splats, incl. Niantic's compressed SPZ).

> **Research-first.** 6.1 decides the rendering architecture before any
> node type is committed to the schema.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 6.1 | **Research spike: rendering approach** | **M** | v0.4 WebGPU backend | Candidates: an embedded 3D renderer (three.js/Babylon-class) rendering to texture, vs a bare WebGPU pipeline living beside ADR-016's texture segments; gaussian-splat renderers (the gsplat family) for PLY/SPZ. Decide: live texture in GPU mode with rasterized snapshots for the Canvas2D fallback and exports? Licensing + bundle size, memory ceilings for multi-million-splat captures, splat sort perf. Output: ADR + throwaway prototype. |
| 6.2 | **MODEL3D node type (schema v4)** | **L** | 6.1 | Node = content-addressed model asset (same `assets/` SHA-256 story as images) + camera orbit/FOV + lighting preset; v3→v4 migration; all edits journaled PatchOps like any node. |
| 6.3 | **GLB rendering + orbit interaction** | **L** | 6.2 | Double-click to orbit (enter/exit like vector-edit mode), PBR-lite lighting presets; PNG export bakes the render; SVG export embeds the raster. |
| 6.4 | **PLY / SPZ gaussian splats** | **L** | 6.3 | SPZ decode, splat sorting/perf gates on real captures; documented memory limits. |

**Exit criteria:** drop a GLB and an SPZ into a document, pose them, composite vector/text on top, export a PNG — and reopening the `.poly` bundle reproduces the exact render.

---

## v0.6 — Agent Connectivity (MCP + CLI)

Goal: let AI agents (Claude and others) connect to a **running** Polyform, watch the work happen in realtime, and make edits that land in the same undo journal as human edits. Plus a headless CLI for scripting and CI.

> **Research-first.** MCP (Model Context Protocol) is the leading
> candidate — it is what Claude-family tools speak natively, and Figma's
> Dev Mode MCP server is prior art — but 7.1 explicitly evaluates it
> against a plain local WebSocket/JSON-RPC bridge and a pure-CLI approach
> before anything is built. "Best tool" is the deliverable of the spike.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 7.1 | **Research spike: protocol & transport** | **M** | — | MCP server inside the Electron main process vs a sidecar `polyform` CLI bridging into the app over a local socket; stdio vs WebSocket/SSE transports; what Claude Code and other agent clients support best today. Security model up front: localhost-only, explicit in-app consent per agent session, visible "agent connected" indicator — the F-15/F-17 lessons say no silent remote control, ever. Output: ADR. |
| 7.2 | **Read surface: see the work** | **M** | 7.1 | Resources/tools: document JSON (scene graph, styles, components), selection state, viewport + per-node PNG snapshots (the render-to-canvas path exists), and **live change notifications** by subscribing to the op journal — an agent can literally watch edits stream in. |
| 7.3 | **Write surface: journaled agent edits** | **L** | 7.2 | Agent mutations go through the SAME PatchOp journal (ADR-008): undoable, labeled as agent actions in the history browser, rollback-able as one entry; per-capability consent prompts. |
| 7.4 | **Headless CLI** | **M** | 7.1 | `polyform` CLI: open/query/export (PNG/SVG/PDF) a `.poly` bundle without the GUI, sharing the engine — useful standalone, in CI, and as the agent bridge if 7.1 lands on the sidecar design. |

**Exit criteria:** an AI session connects with explicit consent, describes the open document, watches a human edit land live, and performs one edit that shows up attributed in the history browser and undoes cleanly.

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
