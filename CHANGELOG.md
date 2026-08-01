# Changelog

All notable changes to Polyform. Versions follow the [Roadmap](docs/Roadmap.md) phases.

## Unreleased — 0.4.0 "Performance Core", Sprints A–B (2026-08-01)

### Sprint B (in progress)

- **Exact boolean geometry** (closes F-03): union/subtract/intersect/exclude now run exact bezier CSG in the Rust core (flo_curves) by default — intersections are computed on the curves, not on flattened polygons, and the result is **2.02x faster** than the polygon-clipping path on top of being correct at any zoom. The TS implementation stays as an automatic fallback: any WASM runtime failure poisons the engine back to TS for the session, so degenerate geometry can never blank a shape. Verified by a ground-truth fuzz gate (sampled membership vs op semantics — which also exposed that the old TS path silently returns the *first child whole* when polygon-clipping throws).
- **Journal replay contract fixture**: a deterministic journal touching every PatchOp kind replays to a frozen, committed document snapshot, undoes back to the exact initial state, redoes to the exact final state, and survives JSON round-trips — the acceptance test the Rust `commands.rs` port must pass unchanged.

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
