# Polyform Roadmap

**Status:** Living document — updated as milestones land.
**Last updated:** 2026-08-02 (v0.4.1 released; v0.5 6.1–6.3 shipped — ADR-020; v0.6 spike 7.1 decided — ADR-021)

Polyform is a local-first, open-source desktop vector design tool. This roadmap lays out the phased delivery plan with per-item effort estimates and dependencies: **v0.2 ✓ → v0.3 ✓ → v0.4 Performance Core ✓ → v0.4.1 Background Removal ✓ → v0.5 3D Model Import (in progress) → v0.6 Agent Connectivity (spike done) → v1.0 Distribution**. The three phases between v0.4 and v1.0 are committed in intent but deliberately unspecified — each opens with a research spike that picks the best implementation and records it as an ADR before code is written. (Item ids are stable labels, not phase order: v1.0 keeps its historical 5.x ids.)

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

## v0.1 — shipped

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

> **Preparation:** the concrete execution plan — module inventory with port priorities, the three API contracts, WASM embedding rules, verification gates and sprint sequencing — lives in [V0.4-Porting-Plan.md](V0.4-Porting-Plan.md). The current object model the Rust core must implement is [schema.fbs](schema.fbs) (document schema v3 at the time; v4 added MODEL3D nodes in v0.5).
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
| 4.7 | **Research spike: on-device segmentation/matting** | **S** | — | ✅ **Done (2026-08-02)** — comparison in [research/BG-Removal-Spike.md](research/BG-Removal-Spike.md), decision in ADR-019. The spike picked ISNet; **real-image acceptance rejected it** (mattes too aggressive) and the decision was amended to **BiRefNet-512 fp16 (MIT)**, downloaded once on consent and run on the WebGPU EP. RMBG disqualified on license, the AGPL wrapper library avoided, `onnxruntime-node` avoided (native module). |
| 4.8 | **Remove background on image fills** | **M** | 4.7 | ✅ **Shipped in v0.4.1 (2026-08-02)** — inspector button, consent-gated model download (user's call over bundling), worker-hosted BiRefNet inference on the WebGPU EP (~5 s), non-destructive asset swap + Restore original, `POLYFORM_BG_TEST=1` matte gate passing, **accepted on real images**. Open follow-up in ADR-019: the 1024-input quality tier, blocked on an ONNX Runtime storage-buffer limit. |
| 4.9 | Edge refinement brush (stretch) | **M** | 4.8 | Restore/erase strokes over the mask for hairlines and soft edges — only if 4.8's model quality proves it necessary. |

**Exit criteria:** subject cutout works with the network cable unplugged, on a license-clean model, and undo restores the original pixel-for-pixel. **Met — shipped as v0.4.1**; 4.9 (edge-refinement brush) stays unbuilt by its own "only if quality demands it" rule.

---

## v0.5 — 3D Model Import (composition, not modeling)

Goal: place 3D models on the canvas as first-class nodes — orbit them into the right pose, light them, and use the render to make graphics. Polyform stays a 2D tool; this is **render-of-3D-in-2D**, not a 3D editor. Target formats: **GLB** (meshes/PBR) and **PLY / SPZ** (point clouds and gaussian splats, incl. Niantic's compressed SPZ).

> **Status — 6.1–6.3 shipped (2026-08-02), unreleased.** The rendering
> approach is decided and built (ADR-020): GLB meshes and gaussian splats
> place as MODEL3D nodes at **document schema v4**, double-click orbits
> them, and both `IRenderer` backends plus PNG/SVG export composite the
> offscreen render. Measured on Ampere: first render 135 ms mesh / 117 ms
> splat, re-pose 0.3 ms mesh / 16.6 ms splat (30 fps orbit gate cleared);
> three.js + Spark stay a lazy chunk, so the main bundle grew 25 kB.
> **6.4 is the open item** — SPZ v4 and a measured memory ceiling on real
> multi-million-splat captures.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 6.1 | **Research spike: rendering approach** | **M** | v0.4 WebGPU backend | ✅ **Done (2026-08-02)** — comparison in [research/3D-Model-Spike.md](research/3D-Model-Spike.md), decision in ADR-020: one offscreen WebGL2 island (three.js r185 for GLB + Spark 2.1 for PLY/SPZ, both MIT) rendering on demand; both `IRenderer` backends composite snapshot textures through the existing image path. Prototype committed as the `POLYFORM_3D_TEST=1` harness — all pixel gates pass in the built app; bare-WebGPU-pipeline and Babylon/PlayCanvas alternatives recorded with rationale. |
| 6.2 | **MODEL3D node type (schema v4)** | **L** | 6.1 | ✅ **Shipped (2026-08-02)** — node carries the content-addressed asset hash, container format, orbit pose (framing automatic, distance a multiplier of the fit), lighting preset and splat `upright` flag; v3→v4 migration is doc-level only (additive); edits journal as ordinary PatchOps. |
| 6.3 | **GLB rendering + orbit interaction** | **L** | 6.2 | ✅ **Shipped (2026-08-02)** — double-click to orbit (drag spins, Alt+drag dollies, Escape exits, one undo entry per gesture), four procedural lighting presets, Inspector pose fields; PNG export bakes the render, SVG embeds the raster. Measured: 0.3 ms per mesh re-pose, 16.6 ms per splat re-pose (30 fps gate cleared). |
| 6.4 | **PLY / SPZ gaussian splats** | **L** | 6.3 | 🟡 **Partial** — all Spark formats (`.ply`, `.spz`, `.splat`, `.ksplat`, `.sog`) load, render and orbit today, gated on a synthetic capture. Remaining: **SPZ v4** (Spark reads v3; upstream shipped v4 in May 2026 — fallbacks are Niantic's MIT `spz` or Spark's own `transcodeSpz`), perf/memory gates on real multi-million-splat captures, and a documented ceiling with graceful degradation. |

**Exit criteria:** drop a GLB and an SPZ into a document, pose them, composite vector/text on top, export a PNG — and reopening the `.poly` bundle reproduces the exact render. **Met for meshes and synthetic splats; the remaining gate is 6.4's real-capture perf/memory work.**

---

## v0.6 — Agent Connectivity (MCP + CLI)

Goal: let AI agents (Claude and others) connect to a **running** Polyform, watch the work happen in realtime, and make edits that land in the same undo journal as human edits. Plus a headless CLI for scripting and CI.

> **Status — 7.1 decided and 7.2 shipped (2026-08-02), unreleased.** The
> spike evaluated MCP against a bespoke local WebSocket bridge and a
> pure-CLI design and chose MCP, hosted by the app itself on loopback
> (ADR-021) — stdio cannot attach to a GUI that is already open. It also
> established that **realtime cannot be built on MCP resource
> subscriptions**: shipping clients don't implement them, so the live view
> is a cursor over the PatchOp journal instead. 7.2 then built the read
> surface an agent actually needs — styles, components, per-layer
> appearance, and PNG views of the canvas — behind four individually
> revocable capabilities with a visible indicator (ADR-022). 7.3 then
> shipped the write surface: one batch = one attributed, undoable journal
> entry, behind an `edit` capability that defaults off. Defects the gates
> caught along the way: plugin-realm code could reach the endpoint
> controls; `Stop` hung while an agent was attached; and the endpoint
> accepted exactly **one connection ever** (single shared transport) —
> found the first time a real client connected twice. All fixed, all
> gated. **Released as 0.6.0 on 2026-08-04**, together with the editor
> UX and vector-depth work listed after the exit criteria (ADR-024,
> ADR-025).

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 7.1 | **Research spike: protocol & transport** | **M** | — | ✅ **Done (2026-08-02)** — survey in [research/Agent-Connectivity-Spike.md](research/Agent-Connectivity-Spike.md), decision in ADR-021: **MCP over a loopback Streamable HTTP endpoint hosted inside the app** (stdio can't attach to a running GUI); server in main, document in the renderer, one IPC bridge. **Realtime is a `poll_changes(cursor)` feed over the PatchOp journal, not resource subscriptions** — those are not supported by shipping clients. Security fixed up front (off by default, loopback, per-session bearer token, Origin validation). Prototype gate `npm run test:mcp` passes against the official MCP SDK client. |
| 7.2 | **Read surface: see the work** | **M** | 7.1 | ✅ **Shipped (2026-08-02)** — six read tools across four individually revocable capabilities (ADR-022). `get_document` now inventories shared styles (resolved values + usage counts), components (with instance counts) and libraries; `get_node` returns everything that decides how a layer looks; `get_view_image`/`get_node_image` return real PNGs of the user's current view or one layer, clamped to 1568 px and reporting the applied scale (~1,073 image tokens for a viewport, against a ~25k client budget). Consent panel under Agent → Agent Connection, plus a status-bar light that distinguishes *attached* from *reading now* and is pushed, not polled. `npm run test:mcp` grew to **26 checks**, including a decoded-pixel assertion on both images. |
| 7.3 | **Write surface: journaled agent edits** | **L** | 7.2 | ✅ **Shipped (2026-08-02)** — `edit_document`: a batch of create/update/move/delete ops commits through the same OpRecorder as editor commands, so one batch = **one journal entry**, labelled `Agent: <label>` with an AGENT chip in the history browser, one Ctrl+Z, atomic on failure. Gated on the `edit` capability, which **defaults off** (ADR-022). Whitelisted props incl. solid + gradient + **imported-image** fills, parenting into frames with explicit z-index; instance internals off-limits. Companion tools: `import_image` (bytes in, content-addressed asset out — never a file path) and `remove_background` (on-device BiRefNet, own attributed entry, refuses without the model rather than prompting). Gates: hidden+refused ungranted, one-entry commit, undo/redo, atomicity, feed visibility, revoke back to read-only. |
| 7.4 | **Headless CLI** | **M** | 7.1 | ✅ **Shipped (2026-08-02, ADR-023)** — `polyform new | query | export | mcp serve`: the same binary boots headless (hidden window, same renderer → pixel-identical exports) and drives the same bridge as the MCP server. **`mcp serve <bundle>` = stdio MCP over a file at rest with ALL capabilities on** — spawning a process over your own file is the consent; no port, no token, no restart ceremony. CLI-mode writes save the bundle before the call returns. Gate `npm run test:cli`: new → stdio edit → fresh-process query proves disk persistence → export @2x decodes with the written fills. |

**Exit criteria:** an AI session connects with explicit consent, describes the open document, watches a human edit land live, and performs one edit that shows up attributed in the history browser and undoes cleanly. **Met (2026-08-02)** — every clause is a standing `npm run test:mcp` gate (42 checks).

### Shipped alongside 7.x — editor UX and vector depth (2026-08-04)

Not roadmap items: work that came out of using the app while building the agent surface, released in the same version.

| Area | What shipped | Notes |
| :--- | :--- | :--- |
| **Window & chrome** | Frameless window with the app's own title bar and menu; one **bottom bar** — agent (left), tools (centre), focus + zoom (right) — replacing the floating tool pill | ADR-024. The native `Menu` stays installed (it owns every accelerator and OS role); `shared/menu-def.ts` is the single definition both it and the custom bar are built from |
| **Saving** | **Autosave**, no Save button: 1.2 s quiet debounce, 15 s bound, 30 s backstop, gestures and text edits waited out; the title bar carries the state, incl. a persistent red *Not saved* | ADR-024. Honest because a `.poly` project exists on disk before the document does |
| **Inspector** | Every field group named; the glyph moved inside the field it names; units against their number; per-corner radius toggle; **export as a list of targets** (several sizes/formats in one go, one folder dialog) | The panel used to depend on decoding `⌒`, `◐`, `B`, `R` |
| **Vector editing** | **Move / Bend / Delete** modes; **per-point handle mirroring** (none / angle / angle+length, Alt to break for one drag); round anchor handles; **Carve** — enclosed shapes become holes in one editable path | ADR-025. Rules live in `engine/vector-edit.ts` as pure functions over a network |
| **Effects** | An effect on a **group** now applies to its composite in both renderers (one shadow around the union silhouette, no seam) — it used to be silently dropped | New `group-effects` pixel-parity fixture; `worldAABB` also stopped cropping a group's shadow out of exports |
| **Layers panel** | Drag feedback (what you are carrying, where it will land, why a drop is refused), auto-scroll near either end, right-click parity with the canvas, caret/rename fix | |
| **Gates** | `npm run test:e2e` grew to 5 checks; render parity to 12 fixtures; 157 vitest, 44 Rust at release | F-21/F-22 in the findings register are the two lessons this phase produced |



---

## v1.0 — Distribution

Goal: an app you can confidently recommend to someone who has never heard of the repo. CI groundwork for releases ships with v0.1; this milestone finishes the pipeline.

| # | Item | Effort | Depends on | Notes |
| :-- | :--- | :---: | :--- | :--- |
| 5.1 | **Auto-update from GitHub Actions release artifacts** | **M** | v0.1 CI groundwork | **Check + notify shipped in v0.7** (ADR-028): electron-updater against this repo's Releases, launch check opt-in, and it does **not install** — that waits on 5.2, because signature verification is the only integrity check an updater has. Remaining: turn on downloads once signed, then staged channels and deltas. |
| 5.2 | **Code signing** | **M** | — *(reordered: 5.1's install path depends on THIS, not the other way round)* | Windows Authenticode + macOS Developer ID with notarization. **Free path exists for Windows only**: the SignPath Foundation signs open-source projects on the strength of a public repo and a CI-only build (an application, not a purchase). macOS has no free path — notarization needs the paid Apple Developer Programme. Shipped in the meantime: SHA-256 checksums + Sigstore build-provenance attestations, which are not signing but do prove where the bytes came from. |
| 5.3 | **Crash reporting (opt-in)** | **S** | — | Electron crashReporter + renderer error capture, strictly opt-in, local queue with explicit send — consistent with local-first principles. |
| 5.4 | **`.fig` import investigation** | **L** | — | **Shipped in v0.7 (experimental).** File → Import .fig…: self-describing schema, shape from the file's own flattened geometry, tree rebuilt from GUIDs + fractional indices, images into content-addressed assets, one undoable entry, and a report of everything approximated or dropped. Placement verified corner-for-corner against Figma's matrix on three real exports — 350 nodes, 0 misplaced (F-28, which is also where the six defects the first version shipped with are recorded). Remaining: gradient transform decomposition, auto layout recreated, components as components, and one Polyform page per Figma page rather than pages moved aside ([fidelity report](research/Fig-Import-Spike.md), ADR-029). |
| 5.5 | **PDF export** | **M** | v0.4 geometry (4.1) preferred for exact curves | Vector PDF export of frames/pages (single and multi-page), embedding fonts where licensing allows. |

**Exit criteria:** signed installers on all three platforms, one-click updates, and a documented import/export story.

**v0.7.0 "Distribution & .fig Import" (2026-08-05)** cut the first release through this pipeline, and **5.4's importer shipped** — experimental, with the fidelity report the item asked for ([Fig-Import-Spike.md](research/Fig-Import-Spike.md), ADR-029). Releases are now triggered by the version itself: bump `package.json` on `main` and CI builds, smoke-tests, checksums, attests and opens a draft.

**Groundwork shipped 2026-08-05 (not any of 5.1–5.5, but everything under them).** A tag now runs the whole suite, builds and **smoke-tests the packaged app** on all three platforms, publishes **SHA-256 checksums**, and opens a **draft** release ([docs/Releasing.md](Releasing.md)); every Action is pinned to a commit SHA; the e2e / agent / CLI gates run in CI; and the third-party licences are generated into the installer with a CI freshness check. What remains for 5.1/5.2 is genuinely the certificates and the updater — in that order, because electron-updater verifies signatures and an unsigned package gives it nothing to verify.

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
