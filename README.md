# Polyform

**A local-first, open-source vector design tool for the desktop.**

Polyform is a Figma-style design editor that runs entirely on your machine. No cloud, no account, no server — every project is a plain folder on disk that you can copy, zip, sync, or version-control like any other file.

> Status: **v0.4.1 shipped** — offline, on-device image background removal (BiRefNet on the GPU, MIT-licensed, non-destructive) on top of v0.4.0 "Performance Core", where every portable engine module gained a fuzz-proven Rust/WASM twin (spatial index, exact-CSG booleans and rustybuzz text shaping run on Rust by default) and a WebGPU renderer beta (View → GPU Rendering) pans **100,000 shapes at 60fps** with 11/11 pixel-parity fixtures against the Canvas2D reference — effects, all 16 blend modes and shaped text included ([docs/V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md)). **v0.5 is underway**: GLB models and gaussian splats now place on the canvas as posable nodes ([ADR-020](docs/Architecture-Decisions.md)). Next: v0.6 agent connectivity (MCP + CLI), opening with a research spike ([docs/Roadmap.md](docs/Roadmap.md)). See [docs/Feature-Matrix.md](docs/Feature-Matrix.md) for exactly what's implemented, partial, and planned.

## Highlights

- **100% local-first** — projects are self-contained `.poly` directory bundles: `manifest.json`, binary `scene.bin`, a real SQLite `history.sqlite` journal, and SHA-256 content-addressed `assets/`. Design-system libraries are just other `.poly` folders you attach.
- **Session-spanning undo/redo + version history** — every edit is journaled to SQLite on disk; reopen a project and keep undoing, or browse the timeline (`Ctrl+Alt+H`) and jump anywhere.
- **Components & instances** — materialized instances with journaled overrides, swap, and detach; a design system can live entirely in local files.
- **Real design tools** — multi-page documents, frames with auto layout + constraints, shapes, pen paths with a vector-edit mode, text with system fonts, image fills (crop/adjust), gradients with a stop editor, effects (drop/inner shadow, layer/background blur), masks, boolean operations, rulers + guides, snapping with smart + spacing guides, align/distribute, SVG import, PNG/SVG export.
- **Canvas-rendered scene** — shapes are never DOM or SVG nodes; everything paints through a GPU-composited canvas pipeline behind a renderer interface (WebGPU backend is the v0.4 track).
- **Rust/WASM engine core** — the full engine surface (geometry, outlines, spatial index, exact-CSG booleans, scene graph + command engine, constraints, hit-testing, components/layout passes, serialization, text shaping) has Rust twins in `crates/polyform-core`, held equivalent to the TypeScript engine by differential fuzz suites; the spatial index, boolean CSG and text shaping run on Rust by default. The TS engine remains the reference implementation and automatic fallback.
- **Real text shaping** — rustybuzz (the pure-Rust HarfBuzz port) shapes text in the engine: kerning and ligatures from the font's own tables, deterministic layout pinned to the shipped engine (not the browser version), fonts read directly from the OS via the Local Font Access API. Both renderers draw the same positioned glyphs; the WebGPU backend batches them from a shared glyph atlas.
- **3D models on the canvas** — place a GLB mesh or a gaussian splat capture (`.ply`/`.spz`/`.splat`/`.ksplat`/`.sog`), double-click to orbit it, pick a lighting preset, and composite vectors and text on top. Rendered offscreen by three.js + Spark and exported into your PNGs and SVGs. Render-of-3D-in-2D — Polyform stays a 2D tool.
- **On-device background removal** — one click cuts the subject out of an image fill using a local AI model (BiRefNet, MIT-licensed) on the GPU. The model downloads once with explicit consent and everything runs offline forever after — no cloud APIs, non-destructive, fully undoable with "Restore original".
- **WebGPU rendering (beta)** — View → GPU Rendering switches the scene onto a lyon-tessellated, batched WebGPU pipeline: **100,000 shapes pan at 60fps** (verified by the in-app harness), with 9/9 pixel-parity fixtures against the Canvas2D reference — including drop/inner shadows, layer & background blur, and all 16 blend modes through a bake-time effects compositor (ADR-017). Canvas2D remains the default renderer.
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
| `npm run test:mcp`  | Agent-connectivity probe: a real MCP client vs the built app |
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
└── assets/             # images and 3D models, deduplicated by SHA-256
    └── e3b0c44298fc…855.png
```

Copying the folder copies the entire project — shapes, history, and assets included.

## Documentation

| Doc | Contents |
| --- | -------- |
| [CHANGELOG.md](CHANGELOG.md) | What shipped in each release |
| [Feature-Matrix.md](docs/Feature-Matrix.md) | 234-row Figma parity matrix with honest statuses (recounted each release) |
| [Roadmap.md](docs/Roadmap.md) | Phased plan with shipped-status notes: v0.2 ✓ → v0.3 ✓ → v0.4 performance core → v0.4.1 background removal → v0.5 3D model import → v0.6 agent connectivity (MCP + CLI) → v1.0 distribution |
| [Architecture-Decisions.md](docs/Architecture-Decisions.md) | ADR-001…021: every load-bearing decision and its replacement trigger |
| [Findings-and-Concerns.md](docs/Findings-and-Concerns.md) | Risk register F-01…F-19 with severities and mitigations |
| [V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md) | Rust/WASM + WebGPU port: module inventory, API contracts, verification gates |
| [Plugin-API.md](docs/Plugin-API.md) | Plugin dev preview API + post-1.0 sandbox design |
| [schema.fbs](docs/schema.fbs) | Scene object model (schema v4) — FlatBuffers target & Rust struct reference |
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
                    serialization, lyon tessellation + rustybuzz text shaping for
                    the renderers. Per-module TS/WASM switch in backend.ts (ADR-015).
```

The engine (scene graph, geometry, commands, booleans, layout, serialization) is dependency-light TypeScript with no DOM access, deliberately shaped so the Rust core can replace it module-by-module behind unchanged interfaces (ADR-002). That port is underway: each Rust module ships only after a differential fuzz suite proves it equivalent to its TS twin ([docs/V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md)).

## Contributing

Issues and PRs welcome. Run `npm run typecheck && npm test` before submitting. The feature matrix marks plenty of well-scoped 📋 items if you're looking for something to pick up.

## License

[MIT](LICENSE)
