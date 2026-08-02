# Polyform ↔ Figma Feature Parity Matrix

This document tracks Polyform's feature parity against Figma, section by section. It is deliberately honest: approximations are marked partial, and deliberate non-goals are marked out of scope rather than "coming soon."

**Scope reminder:** Polyform is a local-first, single-user, open-source desktop design tool. Cloud, multiplayer, and SaaS platform features are out of scope by design, not by omission. See [Product-Overview.md](./Product-Overview.md) and [Technical-Specification.md](./Technical-Specification.md).

## Status Legend

| Status | Meaning |
| :--- | :--- |
| ✅ | **Implemented** — working in the current build |
| 🟡 | **Partial** — implemented with known gaps or approximations vs. Figma |
| 📋 | **Planned** — on the roadmap, not yet implemented |
| ❌ | **Out of scope** — deliberately excluded (local-first, single-user product) |

## Summary by Section

| Section | ✅ Implemented | 🟡 Partial | 📋 Planned | ❌ Out of scope | Rows |
| :--- | ---: | ---: | ---: | ---: | ---: |
| [Canvas & Viewport](#canvas--viewport) | 15 | 1 | 2 | 0 | 18 |
| [Drawing & Shape Tools](#drawing--shape-tools) | 13 | 0 | 4 | 0 | 17 |
| [Vector Editing](#vector-editing) | 7 | 3 | 5 | 0 | 15 |
| [Selection & Transform](#selection--transform) | 19 | 0 | 5 | 0 | 24 |
| [Layers & Hierarchy](#layers--hierarchy) | 14 | 0 | 2 | 0 | 16 |
| [Fills, Strokes & Effects](#fills-strokes--effects) | 14 | 5 | 4 | 1 | 24 |
| [Text & Typography](#text--typography) | 11 | 1 | 6 | 1 | 19 |
| [Auto Layout & Constraints](#auto-layout--constraints) | 7 | 0 | 6 | 0 | 13 |
| [Components, Styles & Libraries](#components-styles--libraries) | 4 | 3 | 4 | 1 | 12 |
| [Prototyping](#prototyping) | 0 | 0 | 7 | 2 | 9 |
| [Export & Import](#export--import) | 4 | 2 | 6 | 0 | 12 |
| [Files, Data & History](#files-data--history) | 12 | 1 | 1 | 2 | 16 |
| [Collaboration](#collaboration) | 0 | 0 | 0 | 11 | 11 |
| [Performance & Rendering](#performance--rendering) | 5 | 4 | 1 | 0 | 10 |
| [Desktop / Platform](#desktop--platform) | 5 | 1 | 3 | 1 | 10 |
| [Extensibility](#extensibility) | 4 | 1 | 1 | 4 | 10 |
| **Total** | **134** | **22** | **57** | **23** | **236** |

---

## Canvas & Viewport

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Infinite canvas | Unbounded pannable design surface | ✅ | Unbounded canvas; no artificial document edges |
| Pan with Space-drag | Hold Space and drag to pan | ✅ | |
| Pan with middle mouse | Middle-button drag pans the viewport | ✅ | |
| Pan with scroll wheel / trackpad | Two-finger scroll or wheel pans | ✅ | |
| Zoom to cursor | Ctrl/Cmd + wheel zooms toward the pointer | ✅ | |
| Zoom to fit | Shift+1 frames all content in view | ✅ | |
| Zoom to 100% | Shift+0 / Ctrl+0 resets to actual size | ✅ | |
| Zoom to selection | Shift+2 frames the current selection | 📋 | Fit and 100% zoom shipped |
| Pixel grid at high zoom | Pixel lattice appears when zoomed far in | ✅ | |
| Pixel grid toggle | Show/hide pixel grid preference | ✅ | |
| Layout grids | Column/row/grid overlays on frames | 📋 | |
| Rulers | Toggleable rulers along canvas edges | ✅ | Shift+R toggle; tick spacing adapts to zoom |
| User guides | Draggable guide lines from rulers | ✅ | Drag from rulers, drop back to delete; persisted per page; snapping targets |
| Snap to object edges/centers | Objects snap to sibling geometry while dragging | ✅ | Snaps to sibling edges and centers |
| Smart alignment guides | Red lines flash when edges/centers align | ✅ | Red smart-guide lines during drag |
| Spacing / measurement guides | Red measurements show equal spacing between objects | 🟡 | Equal-spacing snap between two neighbours shipped; no measurement labels yet |
| Viewport state persistence | Reopening a file restores camera position | ✅ | Zoom/pan saved in `manifest.json` viewport state |
| Hand tool (H) | Dedicated pan tool | ✅ | |

## Drawing & Shape Tools

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Move tool (V) | Default select/move tool | ✅ | |
| Frame tool (F) | Draw frames as layout containers | ✅ | |
| Rectangle tool (R) | Draw rectangles | ✅ | |
| Ellipse tool (O) | Draw ellipses and circles | ✅ | |
| Line tool (L) | Draw straight lines | ✅ | |
| Arrow tool (Shift+L) | Line with arrowhead cap | 📋 | Line tool ships without arrowhead presets |
| Polygon tool | Draw N-sided polygons | ✅ | |
| Star tool | Draw stars | ✅ | |
| Polygon/star point-count editing | Adjust vertex count and star ratio after drawing | ✅ | Inspector N / inner-radius fields |
| Pen tool (P) | Place vertices and bezier curves | ✅ | Draws vector paths; see Vector Editing for edit-mode gaps |
| Pencil tool (freehand) | Freehand drawing smoothed into vectors | 📋 | |
| Text tool (T) | Click or drag to create text | ✅ | Detailed in Text & Typography |
| Image placement | Place bitmap images onto the canvas | ✅ | Stored content-addressed in `assets/`, deduplicated |
| Slice tool (S) | Define arbitrary export regions | 📋 | Export currently targets selection or frames |
| Corner radius (uniform) | Round all rectangle corners at once | ✅ | |
| Per-corner radius | Independent radius per corner | ✅ | |
| Corner smoothing | iOS-style "squircle" smoothing slider | 📋 | |

## Vector Editing

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Vector networks (data model) | Paths are graphs, not linear command lists | 🟡 | Spec-shaped vertex/edge network model is in place; UI does not yet exploit it |
| Bezier path drawing | Pen tool places lines and cubic curves | ✅ | |
| Dedicated vector edit mode | Enter/exit object to edit vertices and handles | ✅ | Double-click or Enter; move vertices/handles, click edge to insert, Del removes |
| Branching edges per vertex | One vertex can join N edges | 🟡 | Data model supports it; no branching-edge editing UI |
| Bend tool | Toggle a point between corner and curve | 📋 | Depends on vector edit mode |
| Paint bucket region fill | Fill enclosed regions of a vector network | 📋 | Depends on vector edit mode |
| Boolean union | Non-destructive merge of shapes | ✅ | Exact bezier CSG in the Rust core (WASM, default); TS polygon-flattening fallback |
| Boolean subtract | Non-destructive subtraction | ✅ | Exact bezier CSG (Rust core) |
| Boolean intersect | Non-destructive intersection | ✅ | Exact bezier CSG (Rust core) |
| Boolean exclude | Non-destructive XOR of shapes | ✅ | Exact bezier CSG (Rust core) |
| Non-destructive boolean groups | Children stay editable inside the boolean | ✅ | Boolean result recomputes as children change |
| Flatten selection | Bake selection into a single vector layer | 📋 | |
| Outline stroke | Convert a stroke into filled geometry | 📋 | |
| Masks | Layer masks clip sibling content | 🟡 | Vector/shape clipping of siblings above (Ctrl+Alt+M); no luminance masks |
| Rounded corners on vector paths | Corner radius applies to arbitrary vertices | 📋 | Radius currently applies to rectangles |

## Selection & Transform

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Click select | Click to select topmost object | ✅ | R-tree hit-testing |
| Shift multi-select | Shift-click adds/removes from selection | ✅ | |
| Marquee select | Drag a rubber band over objects | ✅ | |
| Double-click drill-down | Double-click enters groups/frames | ✅ | |
| Deep select | Ctrl/Cmd+click selects nested object directly | ✅ | |
| Drag to move | Drag selection to reposition | ✅ | |
| Axis-locked move | Shift constrains movement to one axis | ✅ | |
| Resize handles | 8 handles on the selection bounds | ✅ | |
| Aspect-locked resize | Shift preserves aspect ratio while resizing | ✅ | |
| Rotation handles | Rotate from just outside the corners | ✅ | |
| Arrow-key nudge | Arrows move selection by 1px | ✅ | |
| Shift-nudge | Shift+arrows move by 10px | ✅ | |
| Numeric X/Y/W/H | Type exact position and size in inspector | ✅ | |
| Numeric rotation | Type exact rotation angle | ✅ | |
| Flip horizontal/vertical | Mirror selection (Shift+H / Shift+V) | 📋 | |
| Scale tool (K) | Proportionally scale including strokes/text | 📋 | |
| Align 6-way | Left/center/right, top/middle/bottom alignment | ✅ | |
| Distribute | Even horizontal/vertical distribution | ✅ | |
| Tidy up | Auto-arrange into an even grid | 📋 | |
| Copy / paste | Clipboard for design objects | ✅ | App-internal clipboard |
| Duplicate (Ctrl+D) | Duplicate in place with offset | ✅ | |
| Delete | Remove selection | ✅ | |
| Paste from OS clipboard | Paste images/text copied from other apps | 📋 | Clipboard is app-internal for now |
| Math in inspector fields | Type `100+20` or `50%` into number fields | 📋 | |

## Layers & Hierarchy

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Layers panel tree | Hierarchical layer list of the document | ✅ | |
| Expand / collapse | Disclosure triangles on containers | ✅ | |
| Rename layers | Double-click a layer name to rename | ✅ | |
| Hide / show layers | Eye toggle per layer | ✅ | |
| Lock / unlock layers | Lock toggle prevents canvas selection | ✅ | |
| Drag to reorder | Reorder siblings by dragging in the panel | ✅ | |
| Drag to reparent | Drop a layer into a different container | ✅ | |
| Layer type icons | Icons distinguish frames, shapes, text, etc. | ✅ | |
| Group / ungroup | Ctrl+G groups, Ctrl+Shift+G dissolves | ✅ | |
| Frames as containers | Frames own children and define layout bounds | ✅ | |
| Frame selection | Wrap current selection in a new frame | ✅ | |
| Clip content | Frames optionally clip children to bounds | ✅ | |
| Z-order commands | Bring forward/backward, to front/back | ✅ | |
| Sections | Named organizational regions on canvas | 📋 | No target milestone yet |
| Multi-page documents | Multiple pages per file | ✅ | Pages panel; per-page guides + viewport; undoable page ops |
| Layer search / filter | Filter the layers panel by name/type | 📋 | |

## Fills, Strokes & Effects

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Solid fills | Flat color fill with opacity | ✅ | |
| Multiple fills per object | Stacked fill list per node | ✅ | |
| Linear gradients | Two+ stop linear gradient fill | ✅ | |
| Radial gradients | Center-out gradient fill | ✅ | |
| Angular gradients | Sweep/conic gradient fill | 📋 | |
| Diamond gradients | Diamond-shaped gradient fill | 📋 | |
| Gradient stop editing | On-canvas handles, stop insert/remove/recolor | 🟡 | Full stop bar in inspector (drag/add/remove/recolor); on-canvas handles pending |
| Image fills | Bitmap as a fill paint | ✅ | Content-addressed assets, deduplicated |
| Image fill modes | Fill / Fit / Crop / Tile scaling modes | 🟡 | FILL, FIT, TILE, STRETCH shipped; Figma-style CROP awaits image crop tooling |
| Image crop & adjust | Crop plus exposure/contrast/saturation sliders | ✅ | Non-destructive crop rect + exposure/contrast/saturation on image fills |
| Image background removal | One-click AI subject cutout | ✅ | v0.4.1 (ADR-019): on-device BiRefNet (MIT, RMBG-2.0's architecture) on the WebGPU EP ~5s, consent-gated one-time download (~473 MB), fully offline after, non-destructive + Restore original; accepted on real images 2026-08-02 |
| Video fills | Video as a fill paint | ❌ | Out of scope |
| Stroke color & weight | Per-object stroke paint and thickness | ✅ | |
| Stroke align: center | Stroke centered on the path | ✅ | |
| Stroke align: inside / outside | Stroke inset or outset from the path | 🟡 | Clip-based approximation, not true geometric offset |
| Dashed strokes | Dash pattern control | ✅ | |
| Per-side strokes | Different weights on top/right/bottom/left | 📋 | |
| Stroke caps & joins | Cap (butt/round/square) and join controls | 📋 | |
| Drop shadow | Offset/blur/spread/color shadow effect | ✅ | |
| Inner shadow | Shadow cast inside the shape | ✅ | |
| Layer blur | Gaussian blur on the layer | ✅ | |
| Background blur | Blur content behind a translucent layer | 🟡 | Canvas2D default: backdrop-capture self-draw, expensive on very large canvases; GPU mode: scoped pass split, cost bounded per effect node (ADR-017) |
| Blend modes | Full Photoshop-style blend mode list | 🟡 | All 16 modeled modes in both renderers (GPU: MULTIPLY/SCREEN fixed-function, rest W3C composite shaders); Figma's linear/plus variants not modeled |
| Layer opacity | 0–100% object opacity | ✅ | |

## Text & Typography

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Text tool with on-canvas editing | Type and edit directly on canvas | ✅ | DOM edit overlay positioned over the canvas |
| System font access | Local fonts available via desktop app/agent | ✅ | Chromium `queryLocalFonts` — no font agent needed |
| Cloud font catalog | Built-in Google Fonts library | ❌ | Conflicts with local-first design; system fonts only |
| Font size | Point-size control | ✅ | |
| Font weight | Weight selection per family | ✅ | |
| Italic | Italic style toggle | ✅ | |
| Line height | Fixed or percentage line height | ✅ | |
| Letter spacing | Tracking control | ✅ | |
| Paragraph spacing | Space between paragraphs | 📋 | |
| Horizontal alignment | Left/center/right/justify | ✅ | |
| Vertical alignment | Top/middle/bottom within the box | ✅ | |
| Auto-resize modes | Auto width, auto height, fixed size | ✅ | |
| Text decoration | Underline and strikethrough | 📋 | |
| Text case | Uppercase/lowercase/title transforms | 📋 | |
| Lists | Bulleted and numbered lists | 📋 | |
| Mixed styles in one node | Different styles per character range | 📋 | Text nodes are uniformly styled |
| OpenType features & ligatures | Ligatures, stylistic sets, figures control | 🟡 | Font-default ligatures/kerning ship via engine shaping (ADR-018); no feature-toggle UI yet (liga/ss01/tnum) |
| Variable fonts | Variable axis sliders | 📋 | |
| Text shaping quality | HarfBuzz-grade kerning/ligature shaping | ✅ | rustybuzz (HarfBuzz port) in the engine core — deterministic across machines and Electron upgrades (ADR-018); single-run shaping, no bidi itemization yet |

## Auto Layout & Constraints

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Auto layout: horizontal | Children flow in a row | ✅ | |
| Auto layout: vertical | Children flow in a column | ✅ | |
| Item spacing (gap) | Fixed gap between children | ✅ | |
| Padding | Per-side container padding | ✅ | |
| Counter-axis alignment | Align children across the flow axis | ✅ | |
| Hug contents | Container sizes itself to children | ✅ | |
| Fill container | Child stretches to fill parent | 📋 | |
| Wrap | Children wrap onto multiple rows | 📋 | Known gap vs. Figma |
| Auto gap (space between) | Distribute remaining space between items | 📋 | |
| Absolute position in auto layout | Exempt a child from the flow | 📋 | |
| Constraints (pin / scale) | Pin edges or scale with parent resize | ✅ | Left/right/center/stretch/scale per axis; cascades through nested frames |
| Min / max width & height | Size clamps on auto-layout nodes | 📋 | |
| Grid layout mode | Two-dimensional auto-layout grid | 📋 | |

## Components, Styles & Libraries

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Components | Reusable master elements | ✅ | Ctrl+Alt+K from selection (or converts a frame in place) |
| Variants | Grouped component permutations | 📋 | Instance swapping shipped as the interim mechanism |
| Instances & overrides | Linked copies with local overrides | ✅ | Materialized instances auto-sync; edits journal as overrides; reset/detach per instance |
| Instance swapping | Swap an instance for another component | ✅ | Inspector dropdown |
| Component properties | Boolean/text/swap props on components | 📋 | |
| Color styles | Named, reusable color tokens | ✅ | Create/apply/detach; editing propagates to referencing layers |
| Text styles | Named, reusable typography sets | 🟡 | Create/apply/detach/rename; property re-editing via recreate |
| Effect styles | Named, reusable effect stacks | 🟡 | Apply-by-reference API shipped; no dedicated management UI yet |
| Grid styles | Named, reusable layout grids | 📋 | Depends on layout grids |
| Variables / design tokens | Modes, aliases, token-driven values | 📋 | |
| Team libraries | Publish libraries across an organization | 🟡 | Local-first flavor: attach any .poly as a library, import components/styles, manual update pull |
| Library publish & update flow | Push/accept library updates across files | ❌ | Same rationale |

## Prototyping

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Prototype connections | Draw interaction "noodles" between frames | 📋 | |
| Triggers | Click, hover, drag, key, delay triggers | 📋 | |
| Transitions & Smart Animate | Dissolve, slide, and property-matched animation | 📋 | |
| Presentation mode | Play the prototype full-screen | 📋 | |
| Overlays | Frames presented above the current screen | 📋 | |
| Scroll behavior | Scrollable regions and sticky elements | 📋 | |
| Flows / starting points | Multiple named entry points | 📋 | |
| Shareable prototype links | Cloud URL anyone can open | ❌ | Requires cloud hosting |
| Mobile mirror app | Preview prototypes on a phone | ❌ | Requires cloud sync |

## Export & Import

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| PNG export | Raster export of nodes/frames | ✅ | Selection or frames |
| Export scales | 0.5x–4x multiplier presets | ✅ | 1x–4x |
| JPG export | Lossy raster export | 📋 | |
| SVG export | Vector export of nodes/frames | ✅ | Selection or frames |
| PDF export | Per-frame PDF output | 📋 | |
| Per-node export settings | Persisted export presets on layers | 📋 | Export is invoked ad hoc for now |
| Slice export | Export arbitrary canvas regions | 📋 | Blocked on slice tool |
| SVG import | Paste or place SVG as editable vectors | 🟡 | File > Import SVG: paths/shapes/groups/text, full d-grammar incl. arcs; gradients fall back to solid |
| .fig import | Open Figma's native files | 📋 | |
| Image import | Place PNG/JPEG assets | ✅ | SHA-256 content-addressed, deduplicated |
| 3D model import (GLB, PLY/SPZ) | — (beyond Figma; Spline-territory) | 🟡 | v0.5 (ADR-020): GLB meshes and gaussian splats place as MODEL3D nodes, double-click to orbit, procedural lighting presets, PNG/SVG export bake the render — all through an offscreen three.js+Spark island. Partial: SPZ v3 only (v4 pending upstream), no perf/memory gates on real multi-million-splat captures, menu-only import |
| Copy as PNG / SVG | Copy rendered output to clipboard | 📋 | |

## Files, Data & History

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| File storage model | Cloud documents on Figma's servers | ✅ | Deliberate inversion: local `.poly` directory bundles, fully portable |
| Self-contained assets | Assets stored with the cloud document | ✅ | `assets/` folder travels with the project directory |
| Asset deduplication | Server-side asset dedup | ✅ | SHA-256 content-addressed filenames |
| New / Open / Save / Save As | Standard document lifecycle | ✅ | Native file dialogs |
| Autosave | Continuous background save to cloud | ✅ | 30-second local autosave |
| Recent files | Recents list on the file browser | ✅ | |
| File thumbnails | Auto-generated document previews | ✅ | Thumbnail written into the bundle |
| Unlimited undo / redo | Deep undo stack per session | ✅ | Unlimited, command/PatchOp based |
| History survives restart | Undo history lost when the tab closes | ✅ | Polyform exceeds Figma: disk-backed SQLite journal spans sessions |
| Version history browsing | Timeline UI of past document states | ✅ | Ctrl+Alt+H: journal timeline, jump anywhere, Save As to fork |
| Named versions | Manually titled checkpoints | 📋 | |
| Binary scene serialization | Proprietary binary format | 🟡 | MessagePack envelope (`PFRM1` + schemaVersion) today; FlatBuffers per `docs/schema.fbs` is the target once flatc codegen lands |
| Durable history journal | Server-side operation log | ✅ | Real SQLite file via sql.js WASM — zero native dependencies |
| Full offline operation | Limited offline editing, sync on reconnect | ✅ | Polyform is 100% offline, always |
| Cloud file browser | Web dashboard of team files | ❌ | Local filesystem is the file browser |
| Branching & merging | Org-plan design branching workflow | ❌ | Cloud/team workflow; single-user product |

## Collaboration

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Realtime multiplayer editing | Many editors in one document live | ❌ | Core non-goal: local-first, single-user |
| Live cursors | See collaborators' pointers | ❌ | |
| Comments & threads | Pinned discussion on the canvas | ❌ | |
| Audio / huddles | Voice chat inside a file | ❌ | |
| Observation / spotlight mode | Follow another user's viewport | ❌ | |
| Share links & permissions | View/edit links with access control | ❌ | Share the `.poly` directory instead |
| Teams, projects & orgs | Organizational workspace hierarchy | ❌ | |
| Community files & templates | Public template/duplicate ecosystem | ❌ | |
| FigJam whiteboarding | Companion whiteboard product | ❌ | |
| Figma Slides | Companion presentation product | ❌ | |
| Billing / SSO / admin | Seats, SAML, admin consoles | ❌ | Free and open source; nothing to bill |

## Performance & Rendering

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| GPU-accelerated rendering | Custom WebGL/WebGPU tile renderer | 🟡 | Canvas2D default; WebGPU beta behind View → GPU Rendering with full effects/blend compositing (ADR-016/017) |
| No DOM/SVG shapes | Canvas is never built from DOM nodes | ✅ | Shapes render to canvas only; DOM is reserved for editor chrome |
| Spatial-index hit testing | Fast picking on huge scenes | ✅ | R-tree over AABBs — Rust rstar via WASM by default, rbush fallback (ADR-015) |
| Viewport culling | Off-screen objects skipped per frame | ✅ | Driven by the same R-tree |
| Crisp vectors at any zoom | Re-rasterized sharp at every zoom level | ✅ | Immediate-mode redraw; no stale raster tiles |
| WebGPU backend | Hardware rasterization pipeline | 🟡 | Beta: lyon-tessellated batched pipeline, **11/11** pixel-parity fixtures vs Canvas2D incl. shadows/blurs/all 16 blend modes (ADR-017) and shaped text from the glyph atlas (ADR-018); Canvas2D stays the default pending soak time |
| Rust/WASM core engine | C++/WASM core in Figma's case | 🟡 | Sprint A shipped: geometry/shapes/spatial ported to Rust (crates/polyform-core), fuzz-proven equivalent, spatial live by default; remaining modules per V0.4-Porting-Plan.md |
| Off-main-thread engine | Rendering/layout off the UI thread | 📋 | Spec targets a worker + SharedArrayBuffer with the WASM core |
| 100k+ object documents | Smooth editing on massive files | 🟡 | **Verified: 100k shapes pan at 60fps** (0.18ms CPU/frame) in the WebGPU beta; Canvas2D default targets typical documents |
| Swappable render backends | Single internal engine (not swappable) | ✅ | `IRenderer` abstraction is a Polyform architectural feature |

## Desktop / Platform

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Native desktop app | Electron app for Windows/macOS | ✅ | Electron + electron-vite + React 19 + TypeScript + Tailwind CSS 4; Windows, macOS, Linux |
| Native application menus | OS menu bar with full command set | ✅ | |
| Context menu | Right-click canvas/layer menus | ✅ | |
| Figma-compatible shortcuts | Extensive keyboard shortcut map | ✅ | Shortcut map deliberately mirrors Figma |
| Status bar | No equivalent (zoom lives in toolbar) | ✅ | Polyform addition |
| UI themes | Light and dark editor themes | 🟡 | Dark Figma-like UI only for now |
| Runs in the browser | Full editor available at figma.com | ❌ | Desktop-only by design |
| Auto-update | Silent background updates | 📋 | Planned via GitHub Releases; CI groundwork ships now |
| Installers | Signed installers per platform | 📋 | NSIS `.exe`, `.dmg`, `.AppImage`/`.deb` targets per spec §6 |
| Multiple windows / tabs | Many files open in tabs | 📋 | One document window for now |

## Extensibility

| Feature | Figma behavior | Polyform status | Notes |
| :--- | :--- | :---: | :--- |
| Plugin API | JS plugin runtime with typed API | 🟡 | Dev-preview script runner + design doc (docs/Plugin-API.md); currently CSP-blocked in built apps (F-17) — sandboxed API post-1.0 |
| Widget API | Interactive collaborative canvas objects | ❌ | Built for multiplayer canvases |
| REST API | Cloud API for files, nodes, images | ❌ | No cloud service; the file format is the API |
| Webhooks | Server-side event notifications | ❌ | No server |
| Dev Mode / code inspect | Measurements, tokens, code snippets for devs | 📋 | |
| Agent connectivity (MCP) | Dev Mode MCP server | ✅ | v0.6 (ADR-021/022): an in-app loopback **MCP server**. Reads: document structure, shared styles, components, per-layer appearance, PNG views of the canvas, live selection, a cursor-based change feed. Writes: `edit_document` — one batch = one attributed, undoable journal entry, atomic on failure, gated on an `edit` capability that **defaults off**. Off by default, bearer-token + Origin protected, five individually revocable capabilities, visible indicator |
| Agent consent + activity indicator | — (Figma has no equivalent) | ✅ | Agent → Agent Connection lists each capability beside the tools it enables; revoking reaches a connected session mid-flight. Status-bar light distinguishes attached from reading-now, pushed from main |
| Headless CLI | — | ✅ | `polyform new/query/export/mcp serve` — same binary headless, exports pixel-identical to the app; `mcp serve` = stdio MCP over files at rest, all capabilities on, save-on-edit (ADR-023) |
| Open-source codebase | Proprietary, closed source | ✅ | Polyform is fully open source |
| Plugin community / marketplace | Hosted plugin discovery and installs | ❌ | Cloud distribution platform; plugins (when they land) will load locally |

---

*Counts in the summary table are exact row tallies from the sections above, mechanically recounted (last verified 2026-08-02: 134 ✅ / 22 🟡 / 57 📋 / 23 ❌ = 236). Statuses reflect the current build — **v0.4.1 released**, plus the unreleased v0.5 3D work (items 6.1–6.3) and the complete v0.6 agent surface (items 7.1–7.4). Remaining approximations (stroke-align clipping, shape-clip masks, nearest-instance override capture, single-run text shaping, SPZ v3-only splats) are intentionally reported as 🟡 rather than ✅. See the [CHANGELOG](../CHANGELOG.md) for what landed in each release.*
