# Polyform

**A local-first, open-source vector design tool for the desktop.**

Polyform is a Figma-style design editor that runs entirely on your machine. No cloud, no account, no server — every project is a plain folder on disk that you can copy, zip, sync, or version-control like any other file.

> Status: **v0.1.0** — the first testable release. See [docs/Feature-Matrix.md](docs/Feature-Matrix.md) for exactly what's implemented, partial, and planned.

## Highlights

- **100% local-first** — projects are self-contained `.poly` directory bundles: `manifest.json`, binary `scene.bin`, a real SQLite `history.sqlite` journal, and SHA-256 content-addressed `assets/`.
- **Session-spanning undo/redo** — history is journaled to SQLite on disk; close the app, reopen the project, and keep undoing.
- **Canvas-rendered scene** — shapes are never DOM or SVG nodes; everything paints through a GPU-composited canvas pipeline behind a renderer interface (WebGPU backend planned, see the roadmap).
- **Real design tools** — frames, rectangles/ellipses/lines/polygons/stars, pen paths (vector networks), text with system fonts, image fills, gradients, effects, boolean operations, auto layout, snapping, align/distribute, PNG/SVG export.
- **R-tree spatial indexing** for fast hit-testing and viewport culling.
- **Open format** — the scene schema is documented ([docs/schema.fbs](docs/schema.fbs)); the `.poly` bundle is inspectable with standard tools.

## Getting started

Requirements: Node.js 20+ (22 recommended) and npm.

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
| `npm test`          | Engine unit tests (vitest)                      |
| `npm run typecheck` | Strict TypeScript across main/preload/renderer  |
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
| [Product-Overview.md](docs/Product-Overview.md) | Original product vision & stack |
| [Technical-Specification.md](docs/Technical-Specification.md) | Original architecture spec |
| [Feature-Matrix.md](docs/Feature-Matrix.md) | 200+ row Figma parity matrix with honest statuses |
| [Architecture-Decisions.md](docs/Architecture-Decisions.md) | ADRs incl. deviations from the spec and why |
| [Findings-and-Concerns.md](docs/Findings-and-Concerns.md) | Engineering risk register |
| [Roadmap.md](docs/Roadmap.md) | Phased plan: editing depth → components → Rust/WASM + WebGPU core → auto-update |
| [schema.fbs](docs/schema.fbs) | Target FlatBuffers schema for `scene.bin` |

## Architecture (v0.1)

```
Electron main ──ipc── preload bridge ──── React UI chrome (panels, inspector)
  │  .poly bundle IO                          │
  │  SQLite journal (sql.js)                  ├── DocumentStore (scene graph, history,
  │  fonts, dialogs, assets                   │    R-tree index — outside React)
  └───────────────────────────────────────────┴── Canvas2D renderer + overlays
```

The engine (scene graph, geometry, commands, booleans, layout, serialization) is dependency-light TypeScript with no DOM access, deliberately shaped like the future Rust/WASM core so it can be ported module-by-module (ADR-002).

## Contributing

Issues and PRs welcome. Run `npm run typecheck && npm test` before submitting. The feature matrix marks plenty of well-scoped 📋 items if you're looking for something to pick up.

## License

[MIT](LICENSE)
