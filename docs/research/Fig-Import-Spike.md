# `.fig` import — spike and fidelity report

**Status: shipped, experimental. Corrected 2026-08-08 — the first version placed
rotated layers wrongly; see "What the first version got wrong" below.** File →
Import .fig… works, and this document is now the fidelity report the roadmap asked
for.

Verified against three real exports (v106) by a check that compares **every mapped
node against the matrix it came from, corner for corner**: 350 nodes, 0 misplaced,
0 empty. Layers created: **95/158, 60/63 and 108/139** — the difference from the
node count is Figma's own DOCUMENT and CANVAS wrappers (deliberately unwrapped) and
the operands of flattened booleans (deliberately dropped, because the flattened
result already contains them).
**Roadmap item:** 5.4 (v1.0, effort **L**).
**Date:** 2026-08-05, corrected 2026-08-08.

The roadmap asks for "a research spike + best-effort importer for the
reverse-engineered Figma file format, explicitly labeled experimental, with a
written fidelity report of what maps and what cannot". Both halves are here: the
research first, then what shipped and what it costs.

## What shipped

- `src/shared/fig/` — container (ZIP → `canvas.fig` → chunks) and the Kiwi decoder.
  In `shared` because both processes need it: main owns decompression (zlib and
  Zstandard are Node's, and the renderer is sandboxed), the renderer owns mapping.
- `engine/import/fig/geometry.ts` — the path-command stream, and vector networks
  built from it.
- `engine/import/fig/map.ts` — the tree rebuild, node mapping, and the **report**.
- `File → Import .fig…`, landing as **one undoable entry**, with a summary of
  everything approximated or dropped shown when it finishes.
- 38 unit tests, plus two optional checks that run against a real export when
  `POLYFORM_FIG` points at one.

Measured in the running app, into a real project: **130 ms, 165 ms and 5.8 s**
(the last is 22 bitmaps being hashed and written; the mapping itself is ~150 ms),
one history entry each, one undo removes the whole import, 24 assets on disk.

## Verdict

**Feasible, and more feasible than it looks** — because the format is
**self-describing**: every `.fig` carries the schema for its own contents, so a
decoder does not have to track Figma's version-to-version changes. It reads the
schema out of the file, compiles it, and decodes the data with it.

**And it needs no new dependencies.** Everything the container needs is in Node
already (see [Decoding](#decoding-what-it-takes)), which matters for a project
whose engine is deliberately dependency-light and whose licences ship in the
installer.

The hard part is not decoding. It is **mapping** — deciding what a Figma node
means in Polyform's model, and being honest about what has no equivalent.

## The container

Established from several independent write-ups, then **checked byte for byte
against three real exports** (`OmniTecta.fig`, `Dipped.fig`, `OpenMods.fig`, all
version 106). Two published claims were wrong and are corrected below.

```
MyDesign.fig                    ZIP archive, entries STORED (PK\x03\x04)
├── canvas.fig                   the document
├── meta.json                    file name, background colour
├── thumbnail.png
└── images/<sha1>                bitmaps, content-addressed — like our assets/
```

`canvas.fig` itself:

| Offset | Size | Contents |
| ---: | ---: | :--- |
| 0 | 8 | `fig-kiwi` magic |
| 8 | 4 | version, LE uint32 (e.g. 106) |
| 12 | 4 | chunk 0 length, LE uint32 |
| 16 | N | **chunk 0 — the schema**, **RAW deflate** (no `78 da` header — the write-ups say zlib; the bytes start `b5 bd 09 98`, and `inflateRaw` reads them) |
| 16+N | 4 | chunk 1 length |
| 20+N | M | **chunk 1 — the message**, zstd (`28 b5 2f fd`) on recent versions, deflate on older |

Compression is detected from the magic bytes rather than the version number:
version thresholds are a guess about Figma's history, magic bytes are a fact
about the file in front of us. (In all three files chunk 0 was raw deflate and
chunk 1 was zstd. The schema chunk was byte-identical across the three — 28881
compressed, 72042 raw, 629 definitions — which is what "self-describing per
version" looks like in practice.)

The message decodes to a root `NODE_CHANGES` object holding a **flat** array of
node records — the same shape Figma's collaborative engine syncs, not a tree.
Rebuilding the tree takes two passes:

1. index every node by its GUID (a `sessionID:localID` pair, not a string);
2. attach each node to `parentGuid`, then sort siblings by
   `parentIndex.position` — a **fractional index** (an ordering string, not a
   number), which is how a CRDT keeps insert order without renumbering.

Both are cheap. Neither is guessable from the schema alone, which is exactly why
this document exists before the code does.

## Decoding: what it takes

| Layer | How | Dependency |
| :--- | :--- | :--- |
| ZIP | ~60 lines: read the central directory, then per entry either raw bytes (STORED) or `zlib.inflateRawSync` | none |
| deflate | `zlib.inflateSync` | none (Node built-in) |
| **zstd** | `zlib.zstdDecompressSync` | **none** — verified present in Node 24 *and* in Electron 38's Node 22.22, so both the app and the CLI have it |
| Kiwi schema + message | ~200 lines: the binary-schema reader and a generic message decoder | none, hand-rolled |

That last row is the one worth arguing about, because `kiwi-schema` (MIT, no
dependencies) already does it. Reasons to write it instead:

- it is small, it is pure, and it is exactly the kind of thing this repo's
  differential-fuzz habit is good at — a decoder we own can be round-tripped
  against an encoder written in the test;
- every dependency now enters `THIRD-PARTY-NOTICES.md` and the installer;
- the engine has no runtime dependencies today and that is a feature.

If the binary-schema format turns out to have corners the write-ups gloss over,
take `kiwi-schema` and move on — that is a one-line decision, not a rewrite.

## What is actually in the three files

Read by the shipped engine code, not by a probe (`POLYFORM_FIG=… npx vitest run fig.test.ts`):

| | OmniTecta | Dipped | OpenMods |
| :--- | ---: | ---: | ---: |
| nodes | 158 | 63 | 139 |
| VECTOR | 76 | 23 | 45 |
| FRAME | 20 | 8 | 32 |
| ROUNDED_RECTANGLE | 11 | 17 | 14 |
| ELLIPSE | 21 | 12 | — |
| LINE | — | — | 27 |
| BOOLEAN_OPERATION | 20 | — | 9 |
| TEXT | 7 | — | 8 |
| with fillPaints | 133 | 42 | 90 |
| with strokePaints | 56 | 18 | 36 |
| with vectorData | 86 | 25 | 45 |
| effects / auto layout | 0 / 0 | 0 / 0 | 0 / 0 |
| geometry blobs | 82 | 30 | 65 |
| images | 0 | 2 | 22 |

The lesson for the mapper is in the first two rows: **`VECTOR` is the most common
node type in all three files** (and `BOOLEAN_OPERATION` is next in two). An
importer that skips vector geometry would drop roughly half of every one of these
documents, so the geometry blobs are not a "later" item — they are the feature.

`vectorData` is `{ vectorNetworkBlob: <index>, normalizedSize, styleOverrideTable? }`,
where the index points into the root's `blobs` array of raw byte strings (46–2504
bytes each here). Decoding that blob layout is the next piece of reverse
engineering, and the only one left before a mapper can be written honestly.

## Mapping: where the fidelity goes

This is the part to be honest about, and the reason the roadmap calls the
deliverable a *fidelity report* rather than a converter.

**Should map cleanly** — the shapes of the two models genuinely agree:

| Figma | Polyform |
| :--- | :--- |
| `FRAME`, `GROUP` | `FRAME`, `GROUP` (clipping, corner radius) |
| `RECTANGLE`, `ELLIPSE`, `LINE`, `REGULAR_POLYGON`, `STAR` | same primitives |
| solid / linear / radial paints, opacity, blend modes | `Paint`, `blendMode` (all 16 modes ship) |
| strokes: weight, align, dash | `strokeWeight`, `strokeAlign`, `strokeDash` |
| drop/inner shadow, layer/background blur | `Effect` (all four ship) |
| auto layout, constraints | `AutoLayout`, `constraintsH/V` |
| images | `assets/<sha256>` + an image fill — theirs are SHA-1 named, ours SHA-256, so they get rehashed on the way in |
| components / instances | `COMPONENT` / `INSTANCE` with overrides (ADR-012) |
| multiple pages | pages (ADR-011) |

**Solved differently from the plan — and better.** Vector geometry looked like the
big risk. It turned out that every shape node also carries its **flattened
geometry** (`fillGeometry`, and `strokeGeometry` for open paths) as a command
stream in node-local coordinates, which is the space our own `VectorNetwork` uses.
So there was no need to reverse-engineer their editable network at all: a boolean
result, a star, an arc, a rounded rectangle with four different corners, a glyph
outline — all of it arrives as an editable path that looks right.

The command stream is `op byte + N float32`, no length prefix:
`0x00` CLOSE, `0x01` MOVE (2), `0x02` LINE (2), `0x04` CUBIC (6), and `0x03`
inferred as QUAD (4). The arities are not guesses: a 1024×1024 frame's fill is 46
bytes and parses *exactly* as MOVE + 4×LINE + CLOSE; requiring all 93 geometry
blobs across the three files to consume exactly their own length leaves one
consistent assignment; and a 64×64 ellipse comes out as MOVE + 4 cubics with
control points at 49.67 = 32 + 32×0.5523, the circle kappa. `0x03` never appears
in a real file, so it is supported and **reported as inferred** when met.

**Will need real work:**
- **Text.** Characters, font family, size, weight (from the style name), and
  alignment come across; per-range styles are flattened to one style per node and
  reported. Line breaks are re-derived by rustybuzz (ADR-018), so wrapping can
  differ even when every glyph matches — also reported.
- **Gradients.** Stops and type come across; Figma stores the geometry as a
  transform and we store handles, so the angle is currently reset to vertical and
  reported. Angular and diamond become radial, reported.
- **Auto layout** is read but not recreated: children arrive at their absolute
  positions, and the report says so.
- **Non-rotation transforms.** Skew and non-uniform scale reduce to rotation
  (reported) — our node model is x/y/size/rotation/flip.

**Cannot map, and should say so rather than approximate:**

- prototyping (flows, interactions, transitions) — not in the product (§Prototyping is 📋/❌ in the matrix)
- variables / modes, styles-as-variables
- variants beyond a plain component set (our variants are still 🟡)
- shared/team library links — they point at a cloud we deliberately do not have
- anything FigJam

## What the three files reported

Nothing here is hidden from the user: this is the text the importer itself shows.

- **OmniTecta** — 95 layers from 158 nodes across 2 pages. Approximated: open path
  from stroke outline ×46; ellipse as editable path ×21; boolean flattened ×20;
  boolean operands dropped ×20; text re-shaped ×7.
- **Dipped** — 60 layers from 63 nodes, 2 images. Approximated: open path ×16;
  ellipse ×12. Not imported: image fill whose bitmap was not in the archive ×4.
- **OpenMods** — 108 layers from 139 nodes across 3 pages. Approximated: gradient
  angle reset ×11; boolean flattened ×9; boolean operands dropped ×9; open path ×9;
  text re-shaped ×8; mixed text styles ×2; 1 Figma page moved aside.

Two things to improve next, in order: the **gradient transform** (it is a matrix
we could decompose into our two handles), and **speed with many bitmaps** — 22
images cost 5.6 s of the 5.8 s, one IPC round trip and one hash per image.

## What the first version got wrong

Every one of these produced a file that *looked* imported — finite coordinates,
sane bounding box, plausible layer tree — and none of them could be caught by any
check that only looked at our own output. They were found by rendering the three
files and comparing with Figma, then measured.

1. **Rotated layers landed elsewhere (the visible one).** Figma's per-node matrix
   maps the node's LOCAL space, whose origin is the box's top-left corner, so its
   translation says where that *corner* goes and the rotation turns the box about
   it. We store an unrotated box and turn it about its *centre*. Copying the
   translation straight into x/y therefore offset every rotated node by the gap
   between those pivots: 24 of Dipped's 60 nodes, one 90° bar landing 260 units
   from where it belonged. The conversion is exact — `(x, y) = t + M·c − c`, with
   `c` the half-size — and it is now asserted corner-for-corner on every node of
   every test file.
2. **A boolean's operands were drawn on top of its result.** A shape node with
   children is a boolean operation whose children are its *operands*, and we
   already import the flattened result. Hoisting the operands next to it drew the
   union AND both shapes it was made from: twenty of them turned the OmniTecta
   logo into a black scribble. Figma does not draw them either; now neither do we.
3. **A zero-byte fill blob was treated as geometry.** Figma writes a
   `fillGeometry` *entry* pointing at an empty blob for a shape with no fill. The
   old code chose fill-over-stroke on array length, so it took the empty entry,
   produced no commands, and built a vector node with **no vertices** — invisible —
   while a good 1537-byte stroke outline sat in the next field. 4 nodes in Dipped,
   37 in OmniTecta. The choice is now made on whether geometry actually parsed.
4. **Stroke outlines were stroked instead of filled.** `strokeGeometry` is the
   region a stroke *covers*, as a fillable shape, so it must be filled with the
   stroke paint. Stroking it draws a line around the edge of a line.
5. **A mirror was silently unmirrored.** `det < 0` is a reflection; reducing the
   matrix to an angle threw it away (9 nodes in one file, 5 in another). Any
   reflection is a rotation composed with one fixed flip, so it now becomes
   `flipV`, which our own matrix applies in the same centred frame — exact, not an
   approximation.
6. **Pages were stacked on each other.** Each Figma page has its own coordinates
   near its own origin, so a three-page file arrived as three pages of frames in
   one heap. Pages that would collide are now moved aside (and the amount is
   reported, so a deliberate offset cannot be mistaken for a misplaced node); pages
   that already sit apart keep their exact coordinates. Real pages — one Polyform
   page per Figma page — need an op that can target a page and are still owed.

The lesson generalised into F-28: **an importer can only be checked against the
thing it imported.** Finite numbers and a sane bounding box are properties of
nonsense too.

## Proposed shape of the work

1. **`crates`-free, engine-side, pure:** `src/renderer/src/engine/import/fig/`
   — container reader, kiwi decoder, node mapper, all pure functions over bytes,
   because that is what makes them unit-testable and reusable by the CLI.
2. **A fixture-driven test suite.** One committed *small* `.fig` (with the
   owner's permission, or one made from scratch in Figma for the purpose) plus a
   synthetic kiwi round-trip test. No network, no API key.
3. **Import as a menu item next to Import SVG**, producing ordinary nodes in one
   undoable entry, and a **report** — what came in, what was approximated, what
   was dropped — shown after the import rather than buried in a log. An importer
   that silently drops half a file is worse than one that refuses.
4. **Explicitly experimental** in the UI and the changelog until the fidelity
   report says otherwise.

## Testing it yourself

```sh
POLYFORM_FIG="D:/path/to/Yours.fig" npx vitest run src/renderer/src/engine/import/fig
```

Two optional checks wake up: one reads the container end to end and prints an
inventory, the other maps it and asserts the health properties a mapper can get
wrong while still looking fine in a log — non-finite coordinates, and a bounding
box so large that framing the import would show empty canvas.

No `.fig` is committed: a real export is somebody's design, and the format's
self-description means synthetic files exercise the same code. What synthetic
files cannot prove is that the *layout* guess is right, which is why the numbers
above are from real ones.

## Sources

Independent reverse-engineering write-ups and implementations, consulted
2026-08-05. Read for the format, not copied — the implementation here will be
written from the format description, and anything derived from a specific
project's code would inherit that project's licence:

- <https://www.npmjs.com/package/fig-kiwi> — reads/writes `.fig` and clipboard data
- <https://github.com/sunyui/figma-parser> — offline `.fig` parsing, node trees, assets
- <https://dev.to/jihyunsama/article-1-how-figma-stores-your-design-files-and-how-to-read-them-offline-1j2f> — the container layout and the zstd change
- <https://grida.co/docs/wg/feat-fig> — an independent import effort's notes
- <https://github.com/evanw/kiwi> — Kiwi itself, by its author (schema format, varints, message framing)
