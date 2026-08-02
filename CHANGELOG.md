# Changelog

All notable changes to Polyform. Versions follow the [Roadmap](docs/Roadmap.md) phases.

## Unreleased — 0.6.0 "Agent Connectivity"

### Added

- **A headless `polyform` CLI** (item 7.4, ADR-023): `new` / `query` / `export` / `mcp serve` run the same app with no window — exports go through the exact same renderer as File → Export, so they are pixel-identical by construction. **`polyform mcp serve <bundle>` serves the full agent toolset over stdio for a file at rest**: no port, no token, nothing listening — the client spawns the process, and spawning it over your own file is the consent, so all capabilities (edits included) are on. Every CLI-mode edit saves the bundle before the call returns. Built for CI render-diffs, batch exports, and agent work that shouldn't require the app to be open.
- **Agents can now edit the document — safely** (item 7.3). One tool, `edit_document`: a batch of create/update/move/delete ops lands as **one undoable history entry**, marked with an AGENT chip — one Ctrl+Z removes the whole thing, and a batch with any invalid op lands nothing. Writes are their own capability and **default to off**: letting an agent read your document never implies letting it change one. Boundaries are enforced app-side — writable properties are whitelisted (solid and gradient fills included), agents parent into frames with explicit z-order, and instance internals are untouchable.
- **Agents can bring images in and cut their backgrounds.** `import_image` receives the image as bytes over the loopback connection — the app never reads the agent's filesystem — stores it content-addressed like any placed image, and `edit_document` fills accept `{image: assetHash}`. `remove_background` drives the same on-device BiRefNet pipeline as the context menu (v0.4.1) and commits its own attributed entry; if the model was never downloaded it refuses with instructions rather than popping a consent dialog — that download stays a decision made by a human, in the app.
- **Agents can see the design, not just its structure** (item 7.2). `get_document` reports shared styles with their resolved values and how many layers use each, main components with instance counts, and attached libraries; `get_node` returns fills, strokes, effects, corner radius, auto-layout, constraints, fonts, instance overrides and shared-style **names**; `get_view_image` and `get_node_image` return PNGs of what you are looking at, or of one layer.
- **Agent → Agent Connection**: the consent panel. Four capabilities — read the document, read the selection, see the canvas, watch edits — each listed in plain language beside the tools it enables, each granted and **revoked individually while an agent is connected**. Revoking removes the tools from the live session and refuses the call if a stale client makes it anyway. The panel also hands you a paste-ready client command with the token masked by default.
- **You can always tell when an agent is attached.** While the endpoint listens, the status bar shows a light that distinguishes *connected* from *reading right now*, and clicking it opens the panel to revoke. Status is pushed from the main process, not polled, so it is never stale about whether something is reading.
- Snapshots are budgeted honestly: the long edge is clamped to 1568 px and the applied scale is reported, so an agent measuring off the image is not misled by a silent downscale. A full viewport costs about 1,073 image tokens against a ~25k client budget. Detail reads cap at 400 nodes and say when they truncate.

### Fixed

- **The endpoint accepted exactly one connection, ever.** The MCP transport binds to one session for its lifetime, and the server was built around a single shared transport — so a second agent could never attach, and a client that reconnected after a blip (Claude Code does, with backoff) was refused until the endpoint was restarted. Each session now gets its own transport; the gates cover two concurrent agents, disconnect/reconnect, and departure accounting. Found the first time a real client connected twice — the suite only ever connected once per boot.
- **Stop now stops.** Closing the endpoint while an agent was attached would hang: `server.close()` waits for keep-alive sockets to drain and an attached client holds one open indefinitely. Sockets are destroyed instead — 58 ms measured, and the gate fails over 2 s and re-checks that the port itself refuses connections.
- **A plugin could have started the agent endpoint without asking you.** Plugin scripts run in the renderer's own realm, so they could reach the endpoint controls on `window.polyform` — no dialog, no indicator, no decision. The controls are now handed out once at startup, before any plugin can load, and the test suite runs a plugin-shaped script to prove it is blocked. Plugins still have full document access by design (F-15); this closes the *network listener* path only.
- The endpoint stops when the last window closes, rather than outliving the document it serves.

### Research


- **Protocol decided** (spike 7.1 → ADR-021): AI agents will connect to the **running** app over **MCP**, on a Streamable HTTP endpoint Polyform hosts on `127.0.0.1` — stdio can't attach to a GUI that is already open, so the app listens and the agent dials in (the shape Figma's desktop Dev Mode server uses). The server lives in the main process, the document stays in the renderer, and one IPC bridge connects them.
- **Realtime is a change feed, not a subscription.** MCP's resource-subscription mechanism is not supported by shipping clients today, so watching the work happen is a `poll_changes(cursor)` tool over the existing PatchOp journal — ordered, gap-free, resumable after a disconnect, and it works on every client. Full reasoning and the client-support matrix in [docs/research/Agent-Connectivity-Spike.md](docs/research/Agent-Connectivity-Spike.md).
- **Security settled before the write surface exists**: off by default, loopback-only, an ephemeral OS-assigned port, a per-session bearer token, and `Origin`/`Host` validation so a web page can't drive the app by DNS rebinding.
- **Prototype gate** `npm run test:mcp`: boots the built app and connects with the official MCP SDK client — 401 without a token, 403 cross-origin, tools discovered, the live document and selection read back, and **an edit made in the app appears in the agent's change feed**.

## Unreleased — 0.5.0 "3D Model Import"

### Fixed

- **Double-click works again — everywhere** (F-19): the canvas read its click count from `PointerEvent.detail`, which the spec defines as always 0, so `isDouble` was never true. Every double-click gesture in the app had been silently dead since v0.1: drilling into groups and frames, opening an existing text layer for editing, entering vector-edit mode (masked by the Enter shortcut), and 3D orbit mode. Click counts are now timed (400 ms / 6 px), which also makes the gestures work for pen and touch input, which never report a click count at all.
- **Layers inside frames are selectable on canvas** (F-19): clicking anything in a frame used to select the whole frame, and with drill-down broken the contents were reachable only from the layers panel. Frames and components are now transparent to clicks the way Figma treats them — you click the layer you see — while groups, booleans and instances stay atomic and open with a double-click.
- **Inspector values apply live while you drag them**: scrubbing X/Y/W/H, rotation, opacity, corner radius, font size, effect and 3D pose fields now updates the canvas continuously instead of jumping only on release. The whole drag still collapses into exactly one undo entry — the coalescing moved to the commit sink, so every inspector control inherits it.

### Added

- **Place 3D models on the canvas** (File → Place 3D Model…, ADR-020): **GLB/glTF meshes** with real PBR lighting and **gaussian splats** (`.ply`, `.spz`, `.splat`, `.ksplat`, `.sog`) become first-class `MODEL3D` nodes — content-addressed in the bundle like images, journaled and undoable like every other edit. Polyform stays a 2D tool: this is render-of-3D-in-2D for composition, not a 3D editor.
- **Double-click a model to orbit it.** Drag spins, Alt+drag dollies, Escape leaves; the whole gesture lands as one undo entry. The Inspector exposes yaw/pitch/distance/FOV numerically, a Reset view button, four procedural lighting presets for meshes (Studio / Neutral / Dramatic / Flat — no HDRI assets ship), and an Upright toggle for splat captures.
- **Framing is automatic**: the model's bounding sphere is fitted to the node box, so distance is a multiplier of that fit and a pose survives resizing the node or swapping the asset.
- **Renders in both backends and both exporters**: one offscreen WebGL2 island (three.js r185 + Spark 2.1, both MIT) renders each posed model and hands a snapshot to Canvas2D (`drawImage`) or WebGPU (textured quad). PNG export bakes the finished render; SVG embeds it as a raster.
- **Measured** (`POLYFORM_3D_TEST=1`, NVIDIA Ampere, built app, driving the real document path): first render 135 ms mesh / 117 ms splat; re-posing a cached model costs 0.3 ms of main-thread time for a mesh and one frame (16.6 ms) for splats — both clear the 30 fps orbit gate. The 11/11 GPU pixel-parity fixtures and the 100k-shapes-at-60 fps gate are unchanged, and the three+Spark chunk stays **lazy** (main bundle +25 kB).
- **Document schema v4**: purely additive — v3 files open unchanged and gain nothing but a version stamp. `docs/schema.fbs` tracks the new node, formats, and pose struct.
- Renderer CSP now allows self-contained `data:`/`blob:` content (`connect-src`, explicit `worker-src`) — required by Spark's inlined WASM and blob-spawned sort worker; no network surface widened.
- Known gaps, tracked for 6.4: Spark reads SPZ **v3** (v4 shipped upstream May 2026), multi-million-splat captures have no measured memory ceiling yet, and model import is menu-only (no drag-and-drop — images have none either).
- Research: full landscape survey (Babylon, PlayCanvas, bare-WebGPU pipeline; SPZ v4; Khronos KHR_gaussian_splatting) in [docs/research/3D-Model-Spike.md](docs/research/3D-Model-Spike.md).

## 0.4.1 — Image Background Removal (2026-08-02)

- **Remove background on image fills** (ADR-019): one click in the inspector cuts out the subject with an on-device AI model — **fully offline**; the model downloads once (SHA-256-verified, explicit consent dialog) and lives in local app data. No cloud APIs, ever.
- **Model: BiRefNet (MIT, 512² input, ~473 MB fp16)** — upgraded from ISNet after real-image acceptance showed its mattes too aggressive/imprecise. BiRefNet is the architecture RMBG-2.0 is built on, without RMBG's non-commercial weight license; superseded model files are cleaned from app data automatically. (The 1024-input lite variant is unrunnable in onnxruntime-web on Windows today — WebGPU storage-buffer limit + wasm32 memory ceiling, both measured and documented in ADR-019.)
- **Runs on the GPU**: ~5 s per image on the WebGPU execution provider (ort 1.27 requires the asyncify runtime pair — the jsep files are pre-1.2x), with a run-time degradation ladder down to WASM, an allocation-failure retry, and a watchdog. Never blocks the canvas.
- **Non-destructive**: the cutout is written as a new content-addressed asset; the original stays in the bundle; "Restore original" swaps back; both directions are single, undoable journal entries.
- New harness: `POLYFORM_BG_TEST=1` runs real inference on a synthetic scene and gates the matte (subject kept, background dropped — passing).

## 0.4.0 — Performance Core (2026-08-02)

Sprints A–E below, plus the closeout: the `color.ts` Rust twin landed (exact parity, bit-identical string output under fuzz), completing the module inventory — **every portable engine module now has a fuzz-proven Rust twin**. The worker/scene-memory flip (Roadmap 4.3/4.6) is deferred out of v0.4 with a written re-entry trigger and precondition (op-coverage audit) in [docs/V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md); the SVG import/export port stays unported by the plan's own "only if profiling demands" rule. Exit criteria verified: **100,000-shape scenes pan at 60fps** (in-app harness), byte-compatible document round-tripping against v0.3 files (serialization parity gates).

### Fixed

- **Adding text works again** (F-18): freshly placed text nodes were instantly deleted by a spurious Chromium focus bounce off the just-mounted edit textarea (present since at least v0.3 in built apps; user-reported). The overlay now re-arms focus on a blur that lands nowhere while the window is focused, and only commits on real exits. New `npm run test:e2e` gate drives the built app through the actual gesture (T, click, type, Escape) over the DevTools protocol.

### Sprint E — the HarfBuzz text stack (ADR-018)

- **Text now shapes in the engine**: rustybuzz (the pure-Rust HarfBuzz port) runs in the WASM core behind the `text` backend flag (default on) — real kerning and ligatures from the font's own tables, letter-spacing applied per shaped cluster, and **deterministic layout** that no longer re-flows across Electron upgrades (closes F-02's fidelity/stability core). Font bytes come straight from Chromium's Local Font Access API (`queryLocalFonts().blob()`) — no native module; missing families resolve through sensible installed fallbacks, and every text node falls back to the legacy Canvas2D path until its font's bytes arrive.
- **One layout, both renderers**: `layoutText` stays the single seam — auto-resize, Canvas2D (fills the actual glyph outlines), the WebGPU backend, overlays and SVG export all consume the same positioned-glyph runs.
- **GPU glyph atlas**: the WebGPU backend replaces per-node text rasters with a shelf-packed glyph atlas — each (font, glyph, zoom-bucket) rasterizes once, text draws collapse into batched quads sharing one texture.
- **Verified**: 6 Rust unit tests + 7 vitest contract tests through the WASM boundary, plus three harness fixtures — shaped-vs-shaped parity 0.59% differing pixels, a kerning/ligature/alignment/rotation fixture at 1.22%, and the legacy raster path still pixel-exact. Known limits (documented): single-run shaping (no bidi/RTL itemization), no OpenType feature-toggle UI yet. WASM binary grows 1.16 → 1.97 MB.

### Sprint D follow-up — GPU effects & blend compositor (ADR-017)

- **Effects now composite in GPU mode**: drop shadows, inner shadows, layer blur and background blur render through the WebGPU pipeline. View-independent effects pre-render at bake time into world-anchored per-node textures (replay of the node's baked geometry through a layer-local camera + separable gaussian, σ matching Canvas2D semantics) — so panning remains a pure camera-uniform update, effect nodes included.
- **All 16 blend modes render in GPU mode**: MULTIPLY and SCREEN as exact fixed-function pipeline variants (batched and inherited per-primitive, mirroring Canvas2D); the other thirteen (OVERLAY…LUMINOSITY, incl. the HSL four) through backdrop-sampling composite shaders implementing the W3C formulas.
- **Frame graph**: the scene pass now resolves to an intermediate texture with a final canvas blit; background blur and backdrop-dependent blends split the pass (snapshot → blur → resume). Scenes without backdrop effects keep the old single-pass cost — the 100k gate is unchanged (0.18ms CPU/frame, one draw call).
- **Verified**: three new pixel-parity fixtures — shadows 0.10% differing pixels, blurs 2.69%, twelve blend modes **0.00%** — bringing the harness to **9/9 PASS**. Closes F-16's cost concern in GPU mode (scoped backdrop sampling).
- Remaining GPU beta gap: text uses cached Canvas2D rasters until the Sprint E glyph atlas; Canvas2D stays the default renderer pending real-document soak time.

### Sprint D — WebGPU renderer (beta): the 100k-shape claim is real

- **WebGPU scene backend** behind View → GPU Rendering (Beta), ADR-016: Rust/lyon tessellation (fills, strokes with all three aligns, dash splitting), world-space geometry arenas baked per scene version, one stencil stack for masks/rotated clips/stroke aligns, scissor fast path, gradient/image/text draws from a uniform arena, dual-canvas viewport (editor overlays stay Canvas2D). Canvas2D remains the default renderer; GPU failures fall back automatically.
- **Verified performance**: panning a **100,000-shape document runs at 60fps** — 0.18ms CPU per frame, a single draw call — with a 121ms full rebake after an edit (in-app harness, NVIDIA Ampere). The Product-Overview headline claim is no longer aspirational.
- **Verified fidelity**: six pixel-diff parity fixtures against the Canvas2D reference all pass (worst case 2.63% differing pixels, confined to anti-aliased edges; text rasters are pixel-identical). Run it yourself: `POLYFORM_RENDER_TEST=1 npm start`.
- Beta gaps (documented): effects (shadows/blurs) and non-NORMAL blend modes are not composited in GPU mode yet; text uses cached Canvas2D rasters until the Sprint E glyph atlas.

### Sprint C — the engine-port track is complete

- **Every P1–P3 engine module now has a fuzz-proven Rust twin**: constraints (bit-exact, 500-case matrix), serialization (**byte-identical** PFRM/msgpack output vs @msgpack/msgpack, cross-decoding interop, v1→v3 migration), hit-testing (`hitTestAll`/`nodesInRect`/`findDropFrame` agree exactly incl. z-order; BOOLEAN nodes evaluate through exact CSG fully inside Rust), and the derived-pass fixpoint (instance sync → auto-layout → group/boolean normalize → orphan GC) reaching identical fixpoints with identical materialized ids.
- **Cross-engine determinism hardening** (permanent contract improvements): the instance sync hash now uses canonical JSON (sorted keys — existing documents resync once, no visual change); materialized-node ids come from an injectable host-side factory; `encodeScene` accepts an injectable `savedAt` timestamp.
- Text auto-resize remains host-side by design until the HarfBuzz stack (Sprint E). Remaining v0.4 work is the renderer track: WebGPU backend (Sprint D), text + 100k-shape exit test (Sprint E), and the engine flip onto the Rust SceneGraph (worker + msgpack boundary).

### Sprint B

- **Exact boolean geometry** (closes F-03): union/subtract/intersect/exclude now run exact bezier CSG in the Rust core (flo_curves) by default — intersections are computed on the curves, not on flattened polygons, and the result is **2.02x faster** than the polygon-clipping path on top of being correct at any zoom. The TS implementation stays as an automatic fallback: any WASM runtime failure poisons the engine back to TS for the session, so degenerate geometry can never blank a shape. Verified by a ground-truth fuzz gate (sampled membership vs op semantics — which also exposed that the old TS path silently returns the *first child whole* when polygon-clipping throws).
- **Journal replay contract fixture**: a deterministic journal touching every PatchOp kind replays to a frozen, committed document snapshot, undoes back to the exact initial state, redoes to the exact final state, and survives JSON round-trips — the acceptance test the Rust `commands.rs` port must pass unchanged.
- **SceneGraph + PatchOp engine ported to Rust** (`scene.rs`): the full scene/commands surface — add/remove/update/move/page ops/styles, parent tracking, world matrices, padded world AABBs (strokes/effects/VECTOR outlines), render order — proven equivalent by the journal fixture replaying to the identical frozen snapshot through the WASM `SceneHandle`, plus a randomized op fuzz (180 entries) holding documents byte-equal through apply and undo-all. Runs as the test-proven substrate for the Sprint C/D scene-engine flip; the app still runs the TS SceneGraph.

### Sprint A

- **Rust engine core lands** (`crates/polyform-core`, ADR-015): `geometry`, `shapes` (outline generation + vector-network chain walking + SVG path data), and the spatial index ported to Rust and compiled to WASM (163 KB), per [docs/V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md).
- **Per-module backend switch** (`engine/backend.ts`): TS and WASM implementations live behind unchanged function signatures; flags flip per module, persist in `localStorage`, and are console-tweakable via `__polyformEngine`. If WASM fails to load, everything stays on TS.
- **Spatial index runs on Rust by default**: rstar bulk-load measured **2.23x faster** than rbush at 10k nodes (the rebuild runs on every edit; queries are µs-scale either way). `shapes` stays TS by default — per-call boundary crossing costs 3–5x more than the math until Sprint B moves its consumers (booleans, hit-test) into Rust too.
- **Differential parity gate**: 13-test fuzz suite (1,000 seeded cases per function) holds TS and WASM byte-identical on all pure-IEEE arithmetic and within 1e-12 on libm transcendentals; runs in `npm test` and in CI against a freshly built WASM binary. `npm run bench` reproduces the perf gate.
- CSP now includes `'wasm-unsafe-eval'` (WASM compilation only — JS eval stays blocked). New scripts: `build:wasm`, `test:rust`, `bench`. CI builds and tests the Rust crate on every push; installer builds use the committed WASM pkg and need no Rust toolchain.

## 0.3.0 — Systems (2026-08-01)

- **Components & instances** (schema v3, auto-migrates): create components with `Ctrl+Alt+K` (or convert a frame in place); instances are materialized subtrees kept in sync by the engine, with stable child ids, a cycle guard, and orphan GC. Property edits inside instances are journaled as per-instance **overrides** that survive component edits, undo, and restarts. Swap, reset overrides, and detach (`Ctrl+Alt+B`) in the inspector. Structural edits inside instances are locked.
- **Local-file libraries**: attach any `.poly` bundle in the new Assets tab; insert its components (imported with provenance) and color styles; pull updates on demand — instances re-sync automatically.
- **Version history browser** (`Ctrl+Alt+H`): timestamped timeline over `history.sqlite`, click to time-travel, Save As to fork.
- **Plugin API dev preview**: Plugins → Run Plugin Script… executes a script against a minimal `polyform` API as one undoable entry; design doc at [docs/Plugin-API.md](docs/Plugin-API.md).

## 0.2.0 — Editing Depth (2026-08-01)

- **Multi-page documents** (schema v2, auto-migrates) with per-page guides and viewports; undoable page management.
- **Vector edit mode**: double-click/Enter on a vector — move vertices and bezier handles, click an edge to insert a point, Delete removes points.
- **Rulers & user guides** (`Shift+R`): drag guides from rulers, persisted per page, snap targets; **equal-spacing snapping**.
- **Masks** (`Ctrl+Alt+M`): shape-clip siblings above; **constraints** (pin/center/stretch/scale per axis) cascading through nested frames.
- **Effects**: inner shadow and background blur join drop shadow and layer blur.
- **Image crop & adjust**: non-destructive crop rect plus exposure/contrast/saturation on image fills.
- **Gradient stop editor**: drag/add/remove/recolor stops in the inspector.
- **Shared styles**: color/text/effect styles applied by reference with detach; edits propagate to referencing layers.
- **SVG import**: full path grammar (including arcs), shapes, groups, text, transforms baked in.

## 0.1.1 — Review fixes (2026-07-31)

- Fixed 19 bugs found in an adversarial review, including: redo recreating drawn shapes as 0.01px stubs; text editing broken in dev by StrictMode; File→Open/New discarding unsaved work and desyncing the journal; multi-select resize flinging frame children; drop-shadow collapse under rotation; journal cursor corruption past 500 entries; per-pixel undo spam from label scrubbing; z-order front/back inverting multi-selections.

## 0.1.0 — Local-first vector design tool (2026-07-31)

- Initial release: Electron + React + TypeScript editor with a dependency-light engine — scene graph, patch-based undo/redo journaled to SQLite (session-spanning), R-tree spatial index, Canvas2D renderer behind a swappable interface.
- `.poly` directory bundles: `manifest.json`, binary `scene.bin` (PFRM/MessagePack envelope), `history.sqlite`, SHA-256 content-addressed `assets/`.
- Tools: frame, rectangle, ellipse, line, polygon, star, pen (vector networks), text (system fonts via `queryLocalFonts`), hand; selection, resize/rotate handles, snapping with smart guides.
- Boolean operations (non-destructive groups), auto layout with hug sizing, align/distribute, blend modes, drop shadow + layer blur, gradients and image fills.
- PNG/SVG export, autosave, recents, per-project thumbnails; native menus; 231-row Figma parity matrix and full docs set.
