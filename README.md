<img src="resources/polyform-logo.svg" alt="Polyform" width="132" align="right" />

# Polyform

**A local-first, open-source vector design tool for the desktop.**

Polyform is a vector design editor for interfaces and graphics that runs entirely on your machine. No cloud, no account, no server — every project is a plain folder on disk that you can copy, zip, sync, or version-control like any other file.

> Status: **v0.7.0 — "Distribution & .fig Import"**. Releases are cut by bumping the version: CI builds and **smoke-tests the packaged app** on Windows, macOS and Linux, publishes SHA-256 checksums and a Sigstore build-provenance attestation, and opens a draft release ([docs/Releasing.md](docs/Releasing.md)) — the installers are **not code signed yet** (Roadmap 5.2), and the app tells you about a new version rather than installing it (ADR-028). New in 0.7: **`.fig` import** (experimental — reads a Figma export offline and reports what it could not carry, ADR-029), a project you can **double-click** (`MyPoster/MyPoster.poly`, ADR-027), **flip/rotate 90°**, dropdowns that are **our own DOM** with a caret and a checkmark (ADR-026), and resizable side panels. Built on v0.6 (agents over MCP + a headless CLI), v0.5 (3D models and gaussian splats), and v0.4 (fuzz-proven Rust/WASM engine twins; a WebGPU renderer that pans **100,000 shapes at 60fps**). Full plan in [docs/Roadmap.md](docs/Roadmap.md); exactly what is implemented, partial and planned is in [docs/Feature-Matrix.md](docs/Feature-Matrix.md).

## Highlights

- **100% local-first** — a project is a self-contained folder: a `<Name>.poly` project file you double-click, binary `scene.bin`, a real SQLite `history.sqlite` journal, and SHA-256 content-addressed `assets/`. Design-system libraries are just other projects you attach.
- **Session-spanning undo/redo + version history** — every edit is journaled to SQLite on disk; reopen a project and keep undoing, or browse the timeline (`Ctrl+Alt+H`) and jump anywhere.
- **Components & instances** — materialized instances with journaled overrides, swap, and detach; a design system can live entirely in local files.
- **Real design tools** — multi-page documents, frames with auto layout + constraints, shapes, pen paths with a vector-edit mode (Move/Bend/Delete, per-point handle mirroring and **corner radius**, and **Carve** to punch holes),  text with system fonts, image fills (crop/adjust), gradients with a stop editor, effects (drop/inner shadow, layer/background blur), masks, boolean operations, rulers + guides, snapping with smart + spacing guides, align/distribute, SVG import, PNG/SVG export.
- **Canvas-rendered scene** — shapes are never DOM or SVG nodes; everything paints through a GPU-composited canvas pipeline behind a renderer interface, with Canvas2D and WebGPU as peer backends.
- **Rust/WASM engine core** — the full engine surface (geometry, outlines, spatial index, exact-CSG booleans, scene graph + command engine, constraints, hit-testing, components/layout passes, serialization, text shaping) has Rust twins in `crates/polyform-core`, held equivalent to the TypeScript engine by differential fuzz suites; the spatial index, boolean CSG and text shaping run on Rust by default. The TS engine remains the reference implementation and automatic fallback.
- **Real text shaping** — rustybuzz (the pure-Rust HarfBuzz port) shapes text in the engine: kerning and ligatures from the font's own tables, deterministic layout pinned to the shipped engine (not the browser version), fonts read directly from the OS via the Local Font Access API. Both renderers draw the same positioned glyphs; the WebGPU backend batches them from a shared glyph atlas.
- **Agent connectivity (reads shipped)** — an MCP server inside the app lets an AI agent attach to the *running* editor: read the document with its shared styles and components, inspect how any layer looks, **see PNG views of your canvas**, read your selection, and watch your edits stream in through the journal. Off by default, loopback-only, bearer-token protected, and split into four capabilities you grant and revoke individually while the agent is connected — with a light on the bottom bar whenever it is attached ([ADR-021](docs/Architecture-Decisions.md)/[022](docs/Architecture-Decisions.md)). Agents also *edit* — batched, attributed, one-undo entries behind a write capability that defaults off — and a headless **`polyform` CLI** (`new`/`query`/`export`/`mcp serve`) works on `.poly` files with no window at all: `mcp serve` exposes the same tools over stdio for CI and scripting, with exports pixel-identical to the app ([ADR-023](docs/Architecture-Decisions.md)).
- **3D models on the canvas** — place a GLB mesh or a gaussian splat capture (`.ply`/`.spz`/`.splat`/`.ksplat`/`.sog`), double-click to orbit it, pick a lighting preset, and composite vectors and text on top. Rendered offscreen by three.js + Spark and exported into your PNGs and SVGs. Render-of-3D-in-2D — Polyform stays a 2D tool.
- **On-device background removal** — one click cuts the subject out of an image fill using a local AI model (BiRefNet, MIT-licensed) on the GPU. The model downloads once with explicit consent and everything runs offline forever after — no cloud APIs, non-destructive, fully undoable with "Restore original".
- **WebGPU rendering, on by default** — the scene draws through a lyon-tessellated, batched WebGPU pipeline: **100,000 shapes pan at 60fps** (0.18 ms CPU per frame, one draw call — verified by the in-app harness), with **19/19 pixel-parity fixtures** against the Canvas2D reference — drop/inner shadows, layer & background blur, all 16 blend modes through a bake-time effects compositor (ADR-017), shaped text from a GPU glyph atlas (ADR-018), and group/even-odd/text masks. Where there is no WebGPU device it falls back to Canvas2D on its own, and View → GPU Rendering turns it off.
- **R-tree spatial indexing** for fast hit-testing and viewport culling.
- **`.fig` import (experimental)** — File → Import .fig… reads a Figma export offline and turns it into editable layers in one undoable step: hierarchy, names, fills, strokes, text, images, and shapes taken from the file's own flattened geometry so booleans, stars and arcs come in looking right. It reports everything it approximated or dropped rather than losing it quietly ([fidelity report](docs/research/Fig-Import-Spike.md)).
- **Open format** — the scene schema is documented ([docs/schema.fbs](docs/schema.fbs)); the `.poly` bundle is inspectable with standard tools. A plugin-API dev preview ships behind the Plugins menu.

## Getting started

Requirements: Node.js 20+ (22 recommended) and npm. A Rust toolchain is **optional** — the compiled WASM engine pkg is committed, so you only need Rust (stable + `wasm32-unknown-unknown` + [wasm-pack](https://github.com/rustwasm/wasm-pack)) if you change `crates/`.

```bash
git clone https://github.com/AndreaDev3D/Polyform
cd polyform
npm install
npm run dev        # launches the Electron app with hot reload
```

Then: **New Project…**, pick where to save the `.poly` folder, and draw. Press `R` for rectangle, `F` for frame, `T` for text, `V` to select. `Ctrl+wheel` zooms, `Space` pans, `Ctrl+Z` undoes. There is no Save button: edits are written about a second after you stop making them, and the title bar says so. The full shortcut map is in the Help section of the feature matrix.

### Scripts

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Run the app in development with hot reload      |
| `npm test`          | Engine unit tests + TS↔WASM parity fuzz (vitest)|
| `npm run typecheck` | Strict TypeScript across main/preload/renderer  |
| `npm run test:rust` | Rust engine-core unit tests (cargo)             |
| `npm run test:e2e`  | Drives the built app with synthetic OS input: 23 checks no unit test can reach (F-18/F-19/F-21/F-23/F-24/F-30/F-31) |
| `npm run test:mcp`  | Agent-connectivity probe: 53 checks — a real MCP client vs the built app, driving the consent panel |
| `npm run test:cli`  | Headless CLI gate: new → stdio-MCP edit → persistence → pixel-checked export |
| `npm run test:packaging` | Drives the **packaged** app (after `electron-builder`): asar layout, the whole CLI gate against the installed binary, and history read back out of the journal it wrote |
| `npm run licenses`  | Regenerates `THIRD-PARTY-NOTICES.md` (CI fails if it is stale) |
| `npm run build:wasm`| Rebuild the WASM engine pkg from `crates/`      |
| `npm run bench`     | TS vs WASM micro-benchmarks (perf gates)        |
| `npm run build`     | Production build to `out/`                      |
| `npm run dist:win`  | Windows installer + portable exe (`release/`)   |
| `npm run dist:mac`  | macOS dmg                                       |
| `npm run dist:linux`| Linux AppImage + deb                            |

## The `.poly` project bundle

```text
MyDesign/
├── MyDesign.poly       # the project file: metadata, schema version, viewport state
├── scene.bin           # binary scene graph (PFRM envelope, MessagePack payload)
├── history.sqlite      # undo/redo journal — standard SQLite, survives restarts
├── thumbnail.png       # rendered preview
└── assets/             # images and 3D models, deduplicated by SHA-256
    └── e3b0c44298fc…855.png
```

A project is a **folder**, and `MyDesign.poly` inside it is the file you
double-click — the shape `.csproj`, `.uproject` and `project.godot` all use, and
the only one that works: a folder cannot carry a file association on Windows or
Linux, so a project that is *only* a folder can never be opened from a file
manager. Copying the folder copies the entire project — shapes, history and
assets included.

Bundles written before v0.7 are a `MyDesign.poly/` **directory** with a
`manifest.json` inside. Those still open, and still save to the manifest they
were found in; nothing is rewritten behind your back.

## Documentation

| Doc | Contents |
| --- | -------- |
| [CHANGELOG.md](CHANGELOG.md) | What shipped in each release |
| [Feature-Matrix.md](docs/Feature-Matrix.md) | 244-row feature matrix with honest statuses, compared against the tool most readers know (recounted each release) |
| [Roadmap.md](docs/Roadmap.md) | Phased plan with shipped-status notes: v0.2 ✓ → v0.3 ✓ → v0.4 performance core → v0.4.1 background removal → v0.5 3D model import → v0.6 agent connectivity (reads shipped; writes + CLI next) → v1.0 distribution |
| [Architecture-Decisions.md](docs/Architecture-Decisions.md) | ADR-001…026: every load-bearing decision and its replacement trigger |
| [Findings-and-Concerns.md](docs/Findings-and-Concerns.md) | Risk register F-01…F-24 with severities and mitigations |
| [V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md) | Rust/WASM + WebGPU port: module inventory, API contracts, verification gates |
| [Plugin-API.md](docs/Plugin-API.md) | Plugin dev preview API + post-1.0 sandbox design |
| [Releasing.md](docs/Releasing.md) | Cutting a release: tag → CI → smoke-tested installers → checksums → draft, and what is still unsigned |
| [schema.fbs](docs/schema.fbs) | Scene object model (schema v5) — FlatBuffers target & Rust struct reference |
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

## Trademarks

Polyform is an independent project and is not affiliated with or endorsed by any
other design-tool vendor. Product names referenced in the documentation belong to
their owners and are used for identification and comparison only — see
[TRADEMARKS.md](TRADEMARKS.md).

## License

[MIT](LICENSE)
