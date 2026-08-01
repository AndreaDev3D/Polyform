# Changelog

All notable changes to Polyform. Versions follow the [Roadmap](docs/Roadmap.md) phases.

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
