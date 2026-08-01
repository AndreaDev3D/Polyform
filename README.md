# Polyform

**A local-first, open-source vector design tool for the desktop.**

Polyform is a Figma-style design editor that runs entirely on your machine. No cloud, no account, no server — every project is a plain folder on disk that you can copy, zip, sync, or version-control like any other file.

> Status: **v0.3.0 shipped; v0.4 "Performance Core" Sprints A–D landed** — every engine module now has a fuzz-proven Rust/WASM twin (the spatial index and exact-CSG booleans run on Rust by default), and a WebGPU renderer beta (View → GPU Rendering) pans **100,000 shapes at 60fps** with pixel-parity fixtures against the Canvas2D reference ([docs/V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md)). v0.3 "Systems" shipped components & instances, local-file libraries, a version-history browser, and a plugin-API dev preview, on top of v0.2's multi-page documents, vector-edit mode, rulers/guides, masks, constraints, shared styles and SVG import. See [docs/Feature-Matrix.md](docs/Feature-Matrix.md) for exactly what's implemented, partial, and planned.

## Highlights

- **100% local-first** — projects are self-contained `.poly` directory bundles: `manifest.json`, binary `scene.bin`, a real SQLite `history.sqlite` journal, and SHA-256 content-addressed `assets/`. Design-system libraries are just other `.poly` folders you attach.
- **Session-spanning undo/redo + version history** — every edit is journaled to SQLite on disk; reopen a project and keep undoing, or browse the timeline (`Ctrl+Alt+H`) and jump anywhere.
- **Components & instances** — materialized instances with journaled overrides, swap, and detach; a design system can live entirely in local files.
- **Real design tools** — multi-page documents, frames with auto layout + constraints, shapes, pen paths with a vector-edit mode, text with system fonts, image fills (crop/adjust), gradients with a stop editor, effects (drop/inner shadow, layer/background blur), masks, boolean operations, rulers + guides, snapping with smart + spacing guides, align/distribute, SVG import, PNG/SVG export.
- **Canvas-rendered scene** — shapes are never DOM or SVG nodes; everything paints through a GPU-composited canvas pipeline behind a renderer interface (WebGPU backend is the v0.4 track).
- **Rust/WASM engine core** — the full engine surface (geometry, outlines, spatial index, exact-CSG booleans, scene graph + command engine, constraints, hit-testing, components/layout passes, serialization) has Rust twins in `crates/polyform-core`, held equivalent to the TypeScript engine by differential fuzz suites; the spatial index and boolean CSG run on Rust by default. The TS engine remains the reference implementation and automatic fallback.
- **WebGPU rendering (beta)** — View → GPU Rendering switches the scene onto a lyon-tessellated, batched WebGPU pipeline: **100,000 shapes pan at 60fps** (verified by the in-app harness), with 6/6 pixel-parity fixtures against the Canvas2D reference. Effects compositing is still Canvas2D-only, which stays the default renderer.
- **R-tree spatial indexing** for fast hit-testing and viewport culling.
- **Open format** — the scene schema is documented ([docs/schema.fbs](docs/schema.fbs)); the `.poly` bundle is inspectable with standard tools. A plugin-API dev preview ships behind the Plugins menu.

## Getting started

Requirements: Node.js 20+ (22 recommended) and npm. A Rust toolchain is **optional** — the compiled WASM engine pkg is committed, so you only need Rust (stable + `wasm32-unknown-unknown` + [wasm-pack](https://github.com/rustwasm/wasm-pack)) if you change `crates/`.

```bash
git clone https://github.com/polyform/polyform
cd polyform
npm install
npm run dev        # launches the Electron app with hot reload
```

Then: **New Project…**, pick where to save the `.poly` folder, and draw. Press `R` for rectangle, `F` for frame, `T` for text, `V` to select. `Ctrl+wheel` zooms, `Space` pans, `Ctrl+Z` undoes — the full shortcut map is in the Help section of the feature matrix.

### Scripts

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Run the app in development with hot reload      |
| `npm test`          | Engine unit tests + TS↔WASM parity fuzz (vitest)|
| `npm run typecheck` | Strict TypeScript across main/preload/renderer  |
| `npm run test:rust` | Rust engine-core unit tests (cargo)             |
| `npm run build:wasm`| Rebuild the WASM engine pkg from `crates/`      |
| `npm run bench`     | TS vs WASM micro-benchmarks (perf gates)        |
| `npm run build`     | Production build to `out/`                      |
| `npm run dist:win`  | Windows installer + portable exe (`release/`)   |
| `npm run dist:mac`  | macOS dmg                                       |
| `npm run dist:linux`| Linux AppImage + deb                            |

## The `.poly` project bundle

```text
MyDesign.poly/
├── manifest.json       # metadata, schema version, viewport state
├── scene.bin           # binary scene graph (PFRM envelope, MessagePack payload)
├── history.sqlite      # undo/redo journal — standard SQLite, survives restarts
├── thumbnail.png       # rendered preview
└── assets/             # images, deduplicated by SHA-256
    └── e3b0c44298fc…855.png
```

Copying the folder copies the entire project — shapes, history, and assets included.

## Documentation

| Doc | Contents |
| --- | -------- |
| [CHANGELOG.md](CHANGELOG.md) | What shipped in each release |
| [Feature-Matrix.md](docs/Feature-Matrix.md) | 231-row Figma parity matrix with honest statuses (recounted each release) |
| [Roadmap.md](docs/Roadmap.md) | Phased plan with shipped-status notes: v0.2 ✓ → v0.3 ✓ → v0.4 performance core → v1.0 distribution |
| [Architecture-Decisions.md](docs/Architecture-Decisions.md) | ADR-001…016: every load-bearing decision and its replacement trigger |
| [Findings-and-Concerns.md](docs/Findings-and-Concerns.md) | Risk register F-01…F-17 with severities and mitigations |
| [V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md) | Rust/WASM + WebGPU port: module inventory, API contracts, verification gates |
| [Plugin-API.md](docs/Plugin-API.md) | Plugin dev preview API + post-1.0 sandbox design |
| [schema.fbs](docs/schema.fbs) | Scene object model (schema v3) — FlatBuffers target & Rust struct reference |
| [Product-Overview.md](docs/Product-Overview.md) | Original product vision (historical) |
| [Technical-Specification.md](docs/Technical-Specification.md) | Original architecture spec (historical) |

## Architecture

```
Electron main ──ipc── preload bridge ──── React UI chrome (panels, inspector)
  │  .poly bundle IO                          │
  │  SQLite journal (sql.js)                  ├── DocumentStore (scene graph, history,
  │  fonts, dialogs, assets                   │    R-tree index — outside React)
  └───────────────────────────────────────────┴── Canvas2D (default) + WebGPU (beta)
                                               │   renderers + Canvas2D overlays
                    crates/polyform-core (Rust→WASM) — the full engine surface:
                    geometry, outlines, spatial index, exact-CSG booleans, scene
                    graph + commands, constraints, hit-testing, components/layout,
                    serialization, lyon tessellation for the WebGPU backend.
                    Per-module TS/WASM switch in engine/backend.ts (ADR-015).
```

The engine (scene graph, geometry, commands, booleans, layout, serialization) is dependency-light TypeScript with no DOM access, deliberately shaped so the Rust core can replace it module-by-module behind unchanged interfaces (ADR-002). That port is underway: each Rust module ships only after a differential fuzz suite proves it equivalent to its TS twin ([docs/V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md)).

## Contributing

Issues and PRs welcome. Run `npm run typecheck && npm test` before submitting. The feature matrix marks plenty of well-scoped 📋 items if you're looking for something to pick up.

## License

[MIT](LICENSE)
