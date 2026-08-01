# Architecture Decision Records

**Project:** Polyform — local-first, open-source desktop vector design tool
**Scope:** v0.1 implementation decisions
**Companion documents:** [Product-Overview.md](./Product-Overview.md), [Technical-Specification.md](./Technical-Specification.md), [Findings-and-Concerns.md](./Findings-and-Concerns.md)

Each record follows the same shape: **Context** (the forces at play), **Decision** (what we chose), **Consequences** (what we gained and what we pay for it), and **Revisit when** (the concrete trigger that reopens the decision). Decisions are numbered in the order they were made and are never renumbered.

Status legend: **Accepted** — in force for v0.1. **Accepted (transitional)** — in force now, with a documented replacement already planned.

---

## ADR-001: Electron over Tauri for the v0.1 shell

**Status:** Accepted (transitional)

### Context

The Product Overview names both Electron and Tauri 2.0 as candidate desktop shells. Tauri offers smaller binaries, lower memory overhead, and a Rust-native main process that would align with the planned Rust core. However, Tauri builds require the full Rust toolchain in every contributor and CI environment, its webview is the *platform* webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) rather than a pinned Chromium — meaning renderer behavior (Canvas2D rasterization details, `queryLocalFonts` availability, clipboard and font APIs) varies per OS and per user's installed webview version. v0.1 depends specifically on Chromium features: `queryLocalFonts` for system font enumeration (ADR-006), consistent Canvas2D compositing across all three platforms (ADR-003), and a single known-good runtime to debug against.

The team's priority for v0.1 is shipping a working editor fast, with `electron-vite` giving instant HMR for the React 19 + TypeScript + Tailwind CSS 4 chrome and zero native compilation anywhere in the toolchain (reinforced by ADR-005's rejection of native Node modules).

### Decision

Ship v0.1 on **Electron** with `electron-vite`, React 19, TypeScript, and Tailwind CSS 4. Keep the shell surface deliberately thin — file dialogs, native menus, window lifecycle, disk persistence over a narrow IPC bridge — so the shell is a replaceable adapter, not a load-bearing wall.

### Consequences

* One pinned Chromium version on Windows, macOS, and Linux: font enumeration, Canvas2D output, and keyboard/clipboard behavior are identical everywhere and testable on one machine.
* `queryLocalFonts` works out of the box; no per-platform webview capability matrix.
* Zero Rust/toolchain requirement for contributors in v0.1 — `npm install && npm run dev` is the entire setup.
* Cost: larger download (~100 MB+ installed), higher baseline memory than Tauri, and Electron-specific packaging concerns (asar unpacking for `sql-wasm.wasm` — see Findings F-06).
* The narrow main-process surface means a later Tauri port touches the IPC adapter layer only, not the engine or UI.

### Revisit when

* The Rust/WASM core port (phase 2 of the Technical Specification) lands and Rust is already a hard build dependency — at that point Tauri's toolchain cost is already paid.
* Tauri's webview matrix demonstrably supports everything Polyform needs (`queryLocalFonts` or an equivalent font-enumeration plugin, stable WebGPU across WebView2/WKWebView/WebKitGTK).
* Installer size or idle memory becomes a top-3 user complaint in issue tracking.
* All three conditions holding together is the strong signal; the first alone is the earliest reasonable trigger.

---

## ADR-002: TypeScript engine first, with an interface contract that keeps the Rust/WASM port possible

**Status:** Accepted (transitional)

### Context

The Technical Specification targets a Rust core compiled to WASM for the scene graph, vector networks, geometry, and serialization. Rust 1.97 is installed and the port is the committed phase-2 plan. But writing the engine in Rust first would put every gnarly product question (how does auto-layout hug interact with text auto-resize? what does deep-select mean inside a boolean group?) behind a slow compile-and-bind loop, before we even know the right shape of the answer. v0.1's real risk is product risk, not throughput risk: a TypeScript engine comfortably handles the scene sizes v0.1 users will produce.

The danger of "TypeScript first" is accidentally writing an engine that *can't* be ported — leaking mutable object references, closures, and DOM types across the boundary that a WASM module could never satisfy.

### Decision

Implement the v0.1 engine in **TypeScript**, but structure it behind the same clean seams a WASM module would sit behind:

* **`SceneGraph`** — the document model is owned by a single store and mutated only through its API; UI code never holds long-lived references into node internals (see ADR-010).
* **Command / `PatchOp` system** — every mutation is expressed as serializable patch operations (before/after property sets keyed by node id + property path), the exact shape that can cross a WASM boundary as flat data (see ADR-008).
* **`IRenderer`** — the renderer consumes a display-list-style view of the scene, not the TypeScript object graph directly (see ADR-003).
* **Hit-test API** — spatial queries (`hitTest(point)`, `queryRect(rect)`) go through one interface backed by the rbush R-tree, returning node ids, never node objects.

The `docs/schema.fbs` FlatBuffers schema ships in the repo as the language-neutral definition of the scene model (see ADR-004), doubling as the contract the Rust port must satisfy.

### Consequences

* Fast iteration: engine changes hot-reload with the UI; no build pipeline beyond `tsc`/vite.
* Every boundary the WASM module will need already exists and is exercised daily — the port becomes "reimplement behind existing interfaces," not "untangle then rewrite."
* Because commands are id + serializable-data (not closures), and hit-testing returns ids (not references), no API depends on shared-memory object identity.
* Cost: two implementations over the project's life; the TypeScript engine sets a performance ceiling (single-threaded JS geometry, GC pauses on large operations) documented in Findings F-01.
* Discipline is required in review: any PR that hands raw node object references across an interface boundary erodes the port path.

### Revisit when

* Profiling shows scene-graph traversal, layout, or geometry (not rendering) as the frame-budget bottleneck on realistic documents (~10k+ nodes).
* Boolean operations need exact bezier CSG (ADR-007's revisit), which is dramatically easier with Rust crates (`kurbo`) than JS.
* HarfBuzz-WASM text shaping lands and a Rust core would unify shaping + geometry in one module.

---

## ADR-003: Canvas2D rendering backend now, WebGPU later, both behind `IRenderer`

**Status:** Accepted (transitional)

### Context

The specification's end-state is a WebGPU renderer (CanvasKit/Vello-style) for 60–120 FPS on 100k-shape scenes. Building that first means glyph atlases, path tessellation or compute rasterization, and a driver-bug support burden — months of work before the first rectangle draws. Chromium's Canvas2D is itself GPU-composited (Skia-backed, hardware raster in the compositor) and natively provides almost everything v0.1 draws: bezier paths, gradients (linear/radial), pattern fills for image TILE mode, dashed strokes, a usable subset of blend modes, shadow and blur filters, and text drawing.

One principle is non-negotiable regardless of backend: **shapes are never DOM nodes or SVG elements.** The DOM is editor chrome only; the document renders exclusively into `<canvas>`.

### Decision

v0.1 renders through **HTML5 Canvas (GPU-composited Canvas2D)** behind the **`IRenderer`** interface. `IRenderer` accepts scene/viewport state and is the only code that touches a `CanvasRenderingContext2D`. Fills, strokes, effects, and text all render through it. A WebGPU backend is the planned second implementer of `IRenderer`.

### Consequences

* Full-fidelity rendering shipped in weeks: gradients, image fills (FILL/FIT/TILE/STRETCH), drop shadow, layer blur, dashed strokes, and text came nearly free from Skia-via-Canvas2D.
* Visual output matches Chromium's own text and path rasterization, so on-canvas text editing overlays (DOM input over canvas) line up naturally.
* Constraints inherited: only Canvas2D's blend-mode subset is supported (inspector exposes exactly that subset); stroke align inside/outside is a clip-based approximation (ADR-007 adjacent; Findings F-04); large scenes at high zoom eventually hit fill-rate and per-draw-call JS overhead (Findings F-01).
* Because `IRenderer` consumes scene state rather than the renderer walking arbitrary app objects, the WebGPU backend can be developed and A/B-toggled against Canvas2D without touching tools, panels, or the engine.

### Revisit when

* Frame time exceeds ~16 ms on target documents (see Findings F-01 for the measured triggers: node count, effect-heavy scenes, 4k+ displays).
* Features arrive that Canvas2D cannot express correctly: inner shadow, background blur, full blend-mode set, subpixel-positioned glyph runs from HarfBuzz shaping.
* WebGPU ships stable across the pinned Electron Chromium on all three platforms *and* a chosen path-rendering approach (CanvasKit-WASM vs Vello-style compute) is validated by a spike.

---

## ADR-004: `scene.bin` as a MessagePack envelope now; FlatBuffers when `flatc` codegen is integrated; `schema.fbs` stays the source of truth

**Status:** Accepted (transitional)

### Context

The specification calls for FlatBuffers (`scene.bin`) for zero-copy deserialization of large scene graphs. FlatBuffers requires the `flatc` compiler in the build pipeline to generate TypeScript accessors — a codegen step not yet integrated, and writing FlatBuffers by hand without codegen is error-prone busywork. Meanwhile v0.1 needs a real binary format on disk *today*, and needs the file to be recognizable and versioned so that a future format migration is mechanical rather than forensic.

### Decision

`scene.bin` v0.1 is a **binary envelope**: the ASCII magic **`PFRM1`**, followed by a **`schemaVersion`** integer, followed by the scene graph serialized as **MessagePack**. Readers must check the magic and refuse or migrate on version mismatch. **`docs/schema.fbs` ships in the repository as the authoritative schema** — the MessagePack payload's structure mirrors it, and any scene-model change must update `schema.fbs` in the same commit. FlatBuffers becomes the payload encoding once `flatc` codegen is integrated into the build.

### Consequences

* Binary, compact, and fast enough for v0.1 scene sizes with zero build-pipeline additions (MessagePack is a plain library dependency).
* The `PFRM1` + `schemaVersion` envelope means the FlatBuffers switch is a new payload encoding under the same detection logic — old files remain identifiable and migratable forever.
* `schema.fbs` living in-repo keeps the TypeScript model, the file format, and the future Rust port aligned on one declared structure instead of three drifting ones.
* Cost: MessagePack is parse-on-load (allocates the whole object graph), not zero-copy — load time on very large documents will scale linearly until FlatBuffers lands. Schema/payload drift is a review-discipline risk since nothing yet machine-checks the payload against `schema.fbs`.

### Revisit when

* `flatc` codegen is wired into the build (the planned trigger — bump the envelope `schemaVersion`, write a migration reader, switch the payload).
* Document load time exceeds ~1 s on representative files, which would accelerate the FlatBuffers integration.
* The Rust core port begins — Rust-side FlatBuffers support makes the switch strictly easier at that point, so it should land first.

---

## ADR-005: sql.js (WASM SQLite) over better-sqlite3 native module for `history.sqlite`

**Status:** Accepted

### Context

The undo/redo journal is a real SQLite database on disk (`history.sqlite`) so history survives app restarts and stays portable inside the `.poly` bundle. The obvious Node choice, `better-sqlite3`, is a native module: it must be compiled per Electron ABI via node-gyp/`electron-rebuild`, breaks on every Electron major upgrade until prebuilds catch up, complicates contributor setup on Windows (MSVC build tools), and is a recurring source of "works on my machine" CI failures. `sql.js` is SQLite compiled to WASM — no native dependency chain at all — at the cost of holding the database in WASM memory and requiring explicit export-to-disk.

### Decision

Use **sql.js** (SQLite-as-WASM). The database lives in memory during a session and is written to `history.sqlite` via the export API using atomic write-temp-then-rename. The on-disk artifact is a **standard SQLite file**, byte-compatible with any SQLite tooling.

### Consequences

* Zero native dependencies anywhere in the dependency tree: `npm install` never invokes node-gyp, Electron upgrades never break the build, CI needs no compiler toolchain. This preserves the ADR-001 "no toolchain friction" property end to end.
* `history.sqlite` remains a genuine `.sqlite` file — inspectable with the `sqlite3` CLI, portable with the bundle, and forward-compatible with a future native or Rust SQLite driver reading the same file.
* Costs accepted and tracked: the journal is memory-resident (Findings F-05 covers size and corruption strategy), persistence is snapshot-on-write rather than transactional page-level I/O, and `sql-wasm.wasm` must be excluded from asar packing (Findings F-06).

### Revisit when

* Journal size in memory becomes a measurable RSS problem on long-lived documents (see Findings F-05 and F-08 for thresholds and the compaction strategy that should be exhausted first).
* Electron's ecosystem makes native SQLite friction-free (e.g., reliable prebuilds guaranteed same-day for new Electron majors), or the Rust core port brings `rusqlite` natively.
* Write durability requirements tighten to the point that snapshot-export granularity is provably losing user history (has not occurred; autosave design in Findings F-07 bounds the window).

---

## ADR-006: `queryLocalFonts` over font-kit native scanning

**Status:** Accepted

### Context

The specification sketches system font discovery via native bindings (`font-kit` in Rust, or C++ Node modules) scanning OS font directories. That approach means another native/toolchain dependency (contradicting ADR-001/ADR-005), plus hand-maintained per-OS directory lists and font-table parsing to get family/style metadata. Chromium ships the [Local Font Access API] (`window.queryLocalFonts`), which enumerates installed system fonts with family, style, and full name — and because Electron pins Chromium, its availability is guaranteed rather than webview-dependent.

### Decision

Enumerate system fonts with **`queryLocalFonts`** in the renderer process. Font *rendering* uses Chromium's own text stack via Canvas2D (ADR-003), so enumeration and rasterization agree by construction — every font the picker lists is a font the canvas can draw.

### Consequences

* No native module, no per-OS scan paths, no font-file parsing; the font picker (family/weight/italic) is built entirely on web APIs.
* Enumeration and rendering can never disagree (a font-kit list could include faces Chromium's renderer resolves differently).
* Costs: `queryLocalFonts` requires a permission grant (handled once via Electron's permission handler); it exposes metadata and (optionally) SFNT bytes but Polyform does not yet read raw tables, so OpenType feature inspection and font embedding are deferred (Findings F-02, F-09); Chromium API deprecation risk is low but real for a pinned-Chromium app that controls its own upgrade cadence.

### Revisit when

* Font embedding in `.poly` bundles is implemented — reading font bytes may prefer direct file access via a native or Rust path for licensing metadata (`fsType` embedding flags).
* HarfBuzz shaping lands and needs raw font binaries; `queryLocalFonts`' blob access may suffice, but if it doesn't, native scanning returns to the table.
* A Tauri port (ADR-001 revisit) removes guaranteed Chromium, taking guaranteed `queryLocalFonts` with it.

---

## ADR-007: Boolean operations via polygon flattening + `polygon-clipping`, not exact bezier CSG

**Status:** Accepted (transitional)

### Context

Non-destructive boolean groups (union/subtract/intersect/exclude) are a headline feature. *Exact* CSG on bezier curves — curve/curve intersection, winding resolution, and reconstruction of result curves — is one of the hardest problems in 2D geometry; robust implementations (Skia's PathOps, Paper.js's boolean code, Rust's `kurbo`-based efforts) each represent years of numerical hardening. A JS-from-scratch exact implementation would dominate the v0.1 schedule and still ship with edge-case failures. The `polygon-clipping` library (Martinez–Rueda algorithm) is a mature, well-tested polygon boolean engine — for *polygons*, not curves.

### Decision

Boolean groups remain **non-destructive** (children are preserved; the result is computed on evaluation), but geometry evaluation **flattens bezier curves to polylines** at a zoom-aware tolerance and runs the boolean through **`polygon-clipping`**. The output is polygonal.

### Consequences

* All four operations shipped in v0.1, non-destructively — editing a child re-evaluates the boolean, matching Figma's mental model.
* Correctness is robust for the polygon domain (Martinez–Rueda handles self-intersection, holes, and degenerate overlaps well).
* Costs: curved inputs produce faceted output visible at high zoom (mitigated by flattening tolerance; Findings F-03); result geometry has high point counts that inflate SVG export size and downstream processing; flattening is recomputed on edit, which is fine at v0.1 scene sizes but is CPU-bound JS.
* The non-destructive structure means upgrading the evaluator to exact curve CSG later changes *output quality only* — documents, files, and UI are untouched.

### Revisit when

* Users report visible faceting on exported assets or high-zoom editing (the practical quality bar).
* The Rust core port (ADR-002) starts — exact bezier boolean via Rust geometry crates (or Skia PathOps via WASM) becomes the natural implementation, and this evaluator should be among the first Rust modules.
* Vector-edit mode ships and users start applying booleans to pen-drawn curve-heavy paths as a primary workflow.

---

## ADR-008: Patch-based (before/after) command journal, not event-sourcing replay

**Status:** Accepted

### Context

Two classic architectures for persistent undo: (a) **event sourcing** — log semantic events ("moved node 42 by (10,3)") and reconstruct any state by replaying from the beginning or a snapshot; (b) **patch-based commands** — each journal entry stores explicit *before* and *after* values (`PatchOp`s) for every property it touched. Event sourcing gives elegant audit trails but makes every historical event a forever-API: any change to a tool's semantics, layout algorithm, or rounding behavior silently corrupts replay of old journals. It also makes undo of entry *N* depend on correctly replaying (or inverting the semantics of) everything around it. Polyform's journal must survive app restarts and app *upgrades* across versions of a rapidly evolving v0.x codebase.

### Decision

The journal is **patch-based**. Every command records symmetric before/after `PatchOp` sets (node id + property path + old value + new value, plus structural ops for insert/remove/reparent with full serialized subtrees on the "before" side of deletions). **Undo applies the before-set; redo applies the after-set.** No entry's applicability depends on any other entry or on re-executing tool logic. Entries are appended to `history.sqlite` (ADR-005) as they commit.

### Consequences

* Undo/redo is O(size of the patch), never O(history length); session-spanning undo after restart is just "load journal, apply patches" with zero semantic re-execution.
* Journal entries survive app upgrades: a patch of raw property values has no dependency on the tool code that produced it.
* `PatchOp`s are flat, serializable data — the same shape crosses the future WASM boundary unmodified (ADR-002) and diffs cleanly for debugging.
* Costs: entries are larger than semantic events (both values stored; deletions store whole subtrees), so the journal grows faster — growth and compaction strategy is tracked in Findings F-08. Semantic information ("this was an align-left") is kept only as a display label, not as replayable structure.
* Collaborative/OT-style merging is *not* a goal (out of scope: multiplayer), so event sourcing's main residual advantage is irrelevant here.

### Revisit when

* Journal size growth outpaces the compaction strategy in Findings F-08 (patch coalescing + checkpointing) on real usage data.
* A version-history *browsing* UI (planned) needs richer semantics than display labels — which would argue for adding metadata to patch entries, not for switching to replay.

---

## ADR-009: Images are rectangles with image fills (Figma semantics), not a distinct node type

**Status:** Accepted

### Context

Two ways to model a placed image: an `Image` node type (Illustrator/SVG `<image>` semantics), or Figma's model — an image is just a **fill paint** on an ordinary shape. A distinct node type forks every downstream system: the inspector needs an image-properties panel separate from fills, corner radius/stroke/effects need image-node special cases, and "replace this rectangle's color with a photo" becomes a node-type conversion. Polyform explicitly targets Figma-compatible mental models and shortcuts.

### Decision

Placing an image creates a **rectangle whose fill list contains an image fill** (asset referenced by SHA-256 content hash into `assets/`, with FILL/FIT/TILE/STRETCH scale modes). There is no image node type in the scene model or in `schema.fbs`.

### Consequences

* Everything that works on a rectangle works on an image for free: corner radius, strokes, effects, opacity, blend modes, multiple fills (image over gradient over solid), auto-layout participation, boolean-group membership.
* One inspector: image fills appear in the same fills list as solids and gradients, exactly as Figma users expect.
* Content-addressed assets dedupe naturally — ten rectangles sharing one photo store one file, because the fill holds a hash, not bytes.
* Costs: "the image itself" has no identity — aspect-ratio-aware behaviors (e.g., re-crop, intrinsic-size restore) must read the referenced asset's dimensions through the fill; future image crop/adjust (planned) becomes fill-level properties, which is more design work than a dedicated node but matches Figma's own solution.

### Revisit when

* Practically never — this matches the file format, the UI, and the target mental model. The only plausible trigger is video fills, which are explicitly out of scope.

---

## ADR-010: Single mutable SceneGraph store outside React with version subscriptions, not React state/immer

**Status:** Accepted

### Context

The scene graph mutates at pointer-move frequency: a drag emits a mutation per mousemove event, and the canvas must repaint within the same frame. Holding the document in React state (or an immer/Redux-style immutable store) means every drag tick allocates new node objects up the parent chain, invalidates memoization, and schedules React reconciliation — none of which the canvas needs, since it repaints from the scene graph directly (ADR-003), not from the DOM. React 19's rendering model is excellent for panels and inspectors; it is the wrong owner for a 60 fps mutable document.

### Decision

The **SceneGraph lives in a single mutable store outside React**, owned by the engine layer. Mutations go exclusively through the command/`PatchOp` system (ADR-008), which bumps **version counters** (per-node and per-scene monotonic integers) as patches apply. Consumers subscribe:

* The **render loop** checks the scene version each rAF tick and repaints the canvas when it changed — no React involvement.
* **React panels** (layers tree, inspector) subscribe to the versions they care about via `useSyncExternalStore`, re-rendering only when a relevant version bumps.
* The spatial index (rbush) updates incrementally from the same patch stream.

React state is reserved for pure UI concerns (panel open/closed, active tool, input focus).

### Consequences

* Drag/resize/rotate repaint at frame rate with zero per-tick allocation churn and zero React render work; panels update once per committed change rather than per mousemove.
* One writer path (commands → patches → version bump) means undo/redo, autosave dirty-tracking, spatial-index maintenance, and UI invalidation all hang off the same stream — no second source of truth to desynchronize.
* The store-behind-an-API discipline is exactly the WASM-portable seam from ADR-002: a Rust-owned scene graph with version counters read across the boundary is a drop-in replacement for the TypeScript store.
* Costs: no immutability safety net — a rogue direct mutation bypassing the command system corrupts undo silently, so the node-object-reference hygiene from ADR-002 must be enforced in review; `useSyncExternalStore` subscriptions need correct version-selector granularity or panels over- or under-render.

### Revisit when

* React Compiler / concurrent-rendering advances make fine-grained external-store subscription obsolete (unlikely to change the core judgment: the canvas never needed React).
* The Rust core port replaces the store's internals — the subscription surface should survive that port unchanged; if it can't, revisit the surface *before* the port, not during.

---

## ADR-011: Pages are root containers addressed by page id in the op log (v0.2)

**Context.** Multi-page documents (roadmap 2.6) had to coexist with a patch-op journal written before pages existed. Ops that add/move root nodes need a parent reference that stays correct even when the user switches pages between an edit and its undo.

**Decision.** A page is a lightweight container (`{ id, name, rootIds, guides, viewport }`), not a node. `SceneGraph.childListOf` accepts a node id, a page id, or `null`; `null` resolves to the *active* page (v0.1 journal compatibility), while every newly recorded op normalizes root parents to a concrete page id. `parentOf(root)` returns the page id; ancestor walks stop at pages.

**Consequences.** Undo/redo lands on the correct page regardless of the currently active page. Old journals replay unchanged. Page create/rename/delete are ops (`page-add`/`page-remove`/`page-rename`), so page management is undoable; guides and per-page viewports are deliberately view-state (persisted, not journaled).

**Revisit when.** Cross-page node moves or page reordering land — both need explicit ops.

---

## ADR-012: Instances are materialized subtrees with journaled overrides (v0.3)

**Context.** Components/instances (roadmap 3.1) are the largest data-model addition. The alternatives were render-time expansion (instances resolved during painting, like Figma's internal model) or materialization (instance children exist as real nodes, kept in sync).

**Decision.** Materialize. An `INSTANCE` is a frame-like container whose children are real copies of the component subtree, each tagged `sourceId`. A derived sync pass (`syncInstances`, run with layout) regenerates stale instances — staleness detected by hashing the component subtree + overrides + instance size; materialized ids are **reused across regenerations** so selection and journal references stay valid. User edits inside an instance are ordinary patch ops; `DocumentStore.commit` additionally captures the changed props into the instance's `overrides` map **within the same history entry**, so an override and the edit that caused it undo together and survive restarts. Structural edits inside instances are locked at the interaction layer. A cycle guard refuses self-referential expansion; a GC pass removes materialized orphans after undo.

**Consequences.** Rendering, hit-testing, constraints, auto-layout, serialization, export and undo needed **zero** instance-specific changes — the engine sees ordinary nodes. Files remain readable by tools that know nothing about components. Costs: `scene.bin` stores expanded copies (size), the sync hash is recomputed per scene change (CPU, see F-12), and deep-nested override capture is nearest-instance only (F-13).

**Revisit when.** The Rust core lands (dirty-tracking replaces hashing) or variant property groups arrive (which need richer override addressing).

---

## ADR-013: Libraries are import-on-use local files, not live-linked registries (v0.3)

**Context.** Roadmap 3.2 wants design systems shared across documents by copying directories — no cloud, no daemon watching files.

**Decision.** Attaching a library records `{ path, name }` in the document. Inserting a library component **copies** it into the document as a local component (with `origin` provenance) and instantiates the local copy; styles import the same way. "Update" is an explicit pull that re-reads the library file and replaces imported components' contents, letting instance sync propagate the changes.

**Consequences.** Documents remain fully self-contained (a `.poly` opens correctly with its libraries missing). No file watchers, no cross-document id coupling — origin ids are provenance, not live references. Cost: updates are manual, and overrides keyed to replaced children can be dropped when the library's structure diverges (F-14).

**Revisit when.** v1.0 distribution work adds an update-review UI; consider content hashing for smarter override re-keying.

---

## ADR-014: Plugin dev-preview runs unsandboxed behind a consent dialog (v0.3)

**Context.** Roadmap 3.4 calls for a *sketch*: prove the scene API shape without committing to a plugin runtime before the Rust core stabilizes the object model.

**Decision.** Ship a script runner (`Plugins → Run Plugin Script…`) that executes a user-picked `.js` file in the renderer against a minimal `polyform` API. All mutations flow through one `OpRecorder`, committing a single undoable entry with rollback on throw. A confirmation dialog states the trust model plainly. The sandboxed worker + typed-bridge design is documented in `docs/Plugin-API.md` and deferred to post-1.0.

**Consequences.** Real automation is possible today (the API mirrors the engine's public surface, so the WASM core can serve it unchanged), and we learn the API shape cheaply. The renderer is context-isolated and sandboxed from Node, but a malicious script can still trash the open document — hence consent dialog, no auto-run, no plugin directory scanning.

**Revisit when.** Post-1.0, per the Plugin-API design doc. Any plugin distribution story requires the worker sandbox first.

---

## ADR-015: WASM engine embedding — inlined binary, committed pkg, per-module flags with measured defaults (v0.4)

**Context.** Sprint A of the [porting plan](V0.4-Porting-Plan.md) delivers the first Rust engine modules (`crates/polyform-core`: geometry, shapes, spatial index). Three embedding questions had to be settled: how the renderer loads the binary, whether generated artifacts are committed, and who decides TS-vs-WASM per call site.

**Decision.**
1. **Loading**: the `.wasm` is bundled as a base64 `?inline` asset and instantiated asynchronously at app start. Rationale: packaged Electron renderers run on `file://`, where `fetch()` of bundled assets is blocked, and Chromium forbids synchronous compilation of modules > 4 KB on the main thread — inline-plus-async sidesteps both, in dev, prod, and vitest alike. The CSP gains `'wasm-unsafe-eval'` (WASM compilation only; JS `eval` stays blocked). If init fails, every module stays on its TS implementation — WASM is an upgrade, never a dependency.
2. **Artifacts**: the wasm-pack output (`engine/wasm/pkg/`, ~163 KB binary + glue) is **committed**. Contributors without a Rust toolchain can dev/build/test the app; CI still compiles the crate fresh and runs the parity suite against it, so the committed copy can never drift silently in behavior.
3. **Dispatch**: a per-module flag in `engine/backend.ts` (persisted in `localStorage`, console-tweakable) decides TS vs WASM behind unchanged function signatures. Defaults are set by measurement, not ideology: `spatial: 'wasm'` (rstar bulk-load 2.23x faster; rebuilds run on every edit), `shapes: 'ts'` (per-call boundary encode/decode costs 3–5x the math), geometry has **no runtime flag** (9.5x against; its Rust port is the substrate Sprint B consumes internally). The boundary itself is batch-only Float64Array codecs — no per-node getter chatter (see `wasm.rs` / `codec.ts` for the wire formats).

**Consequences.** The app works identically with or without WASM, flag flips are reversible at runtime, and the parity fuzz suite (1,000 seeded cases per function; exact equality on pure IEEE arithmetic, 1e-12 on libm transcendentals) is the gate that lets a default flip. The committed-pkg policy trades repo hygiene for contributor accessibility — revisited once a release pipeline builds artifacts anyway.

**Revisit when.** Sprint B moves outline consumers (booleans, hit-test) into Rust — `shapes` flips to `wasm` and the flag design gets its first real migration test. The inline-base64 loading gives way to a Worker + SharedArrayBuffer once the renderer reads vertex buffers directly (Technical-Specification §1.1).

---

## ADR-016: WebGPU renderer bakes world-space geometry arenas per scene version (v0.4)

**Context.** Sprint D delivers the WebGPU backend (ADR-003's replacement track). The design question: how to organize GPU work so a 100k-shape document pans at 60fps while staying pixel-compatible with the Canvas2D reference.

**Decision.** The scene is **baked** once per scene version (+ zoom bucket, dpr, text-editing state) into world-space vertex/index arenas plus an ordered segment list; per frame only a 32-byte camera uniform changes. Solid fills/strokes with normal blending collapse into large batched draws (the 100k-rect exit scene is ONE draw call); gradients, images and text rasters draw individually from a 256-aligned uniform arena with local-space meshes and per-draw world matrices. Geometry comes from the Rust lyon tessellator (fill + stroke + dash splitting), cached **content-addressed** — identical geometry shares one mesh, so 100k copies of a component tessellate once — with a sharp-rectangle fast path that skips the WASM boundary entirely. Masks, rotated/rounded frame clips and INSIDE/OUTSIDE stroke aligns share one stencil stack (INSIDE strokes test `ref=depth+1` after pushing the fill mesh, OUTSIDE test `ref=depth`); unrotated sharp frames use the scissor fast path. Text renders as cached Canvas2D rasters on quads until the Sprint E glyph atlas. The overlay chrome stays Canvas2D on a stacked transparent canvas; the GPU toggle is a beta View-menu option, Canvas2D remains the default, and any GPU failure falls back automatically.

**Consequences.** Verified by the in-app harness (`POLYFORM_RENDER_TEST=1`): six pixel-diff parity fixtures pass against Canvas2D (worst case 2.63% differing pixels, all along anti-aliased edges; text pixel-identical), and the Product-Overview headline claim holds — **100k shapes pan at 60fps** (0.18ms CPU/frame, 121ms bake) on an NVIDIA Ampere adapter. Known beta gaps, documented in the matrix: effects (shadows/blurs) and non-NORMAL blend modes are not composited yet (they need offscreen/backdrop passes — the blur/composite shaders are staged), and edits rebake the arena (fine at 121ms/100k; incremental bake is the escape hatch if profiling ever demands it).

**Revisit when.** The effects/blend compositor lands (closes F-16 properly via scoped backdrop sampling), or the glyph atlas replaces text rasters (Sprint E), or profiling justifies incremental arena updates.

---

## Cross-cutting summary

| ADR | Decision | Transitional? | Replacement trigger |
| :-- | :-- | :-- | :-- |
| 001 | Electron shell | Yes | Rust toolchain already required + Tauri webview parity |
| 002 | TypeScript engine | Yes | Engine-side perf ceiling; exact CSG; HarfBuzz unification |
| 003 | Canvas2D behind `IRenderer` | Yes | Frame budget misses; inner shadow/background blur; stable WebGPU |
| 004 | MessagePack `PFRM1` envelope | Yes | `flatc` codegen integrated |
| 005 | sql.js WASM SQLite | No (stable) | Only if memory residency provably fails |
| 006 | `queryLocalFonts` | No (stable) | Font embedding / non-Chromium shell |
| 007 | Polygon-flattened booleans | Yes | Rust core lands; faceting complaints |
| 008 | Patch-based journal | No (stable) | — |
| 009 | Image = rectangle + image fill | No (stable) | — |
| 010 | Mutable store + version subscriptions | No (stable) | — |
| 011 | Pages as op-addressable root containers | No (stable) | — |
| 012 | Materialized instances + journaled overrides | Partially | Rust core replaces hash-based staleness with dirty tracking |
| 013 | Import-on-use local libraries | No (stable) | Update-review UI in v1.0 |
| 014 | Unsandboxed plugin preview + consent | Yes | Worker sandbox + typed bridge post-1.0 |
| 015 | WASM inlined + committed pkg + measured per-module flags | Partially | Worker embedding; pkg decommitted once release pipeline builds it |
| 016 | WebGPU: baked world-space arenas + segment stream + stencil stack | Partially | Effects/blend compositor; glyph atlas (Sprint E); incremental bake if profiling demands |

The transitional decisions (001–004, 007) share one design rule: **each hides its temporary implementation behind an interface that its replacement can also implement** — the shell behind a thin IPC adapter, the engine behind SceneGraph/PatchOp/hit-test APIs, the renderer behind `IRenderer`, the file payload behind the `PFRM1` envelope, and the boolean evaluator behind non-destructive group evaluation. Replacing any of them is planned work, not archaeology.
