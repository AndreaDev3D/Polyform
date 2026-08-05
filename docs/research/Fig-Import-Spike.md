# `.fig` import — research spike

**Status:** research done and **verified against three real exports**; the
container + Kiwi reader ships as engine code (`engine/import/fig/`, 21 tests).
The node mapper and the vector-geometry blobs are the remaining work.
**Roadmap item:** 5.4 (v1.0, effort **L**).
**Date:** 2026-08-05.

The roadmap asks for "a research spike + best-effort importer for the
reverse-engineered Figma file format, explicitly labeled experimental, with a
written fidelity report of what maps and what cannot". This is the first half.

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

**Will need real work:**

- **Vector geometry.** Figma stores a vector network *plus* a separate serialized
  blob of path commands; our `VectorNetwork` is vertices and edges with control
  points. Expect this to be the largest single piece, and expect the blob to need
  its own small decoder.
- **Text.** Character runs with per-range styles, plus Figma's own line breaking.
  Our text is one style per node with engine-side shaping (ADR-018), so a
  multi-style paragraph either splits into several nodes or loses the ranges.
  Either way the *layout* will differ: their line breaks came from their shaper.
- **Fractional-index ordering** must be preserved as z-order, not re-derived.

**Cannot map, and should say so rather than approximate:**

- prototyping (flows, interactions, transitions) — not in the product (§Prototyping is 📋/❌ in the matrix)
- variables / modes, styles-as-variables
- variants beyond a plain component set (our variants are still 🟡)
- shared/team library links — they point at a cloud we deliberately do not have
- anything FigJam

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

## What is needed to start

A real export, ideally two:

- **a simple one** — a frame or two, rectangles, text, an image;
- **a real one** — components, instances, auto layout, vector paths, effects.

`File → Save local copy…` in Figma produces the `.fig`. Any path on disk is
fine; the parser never touches the network, and nothing from these files is
committed unless it is a fixture we agree to ship.

Without one, the decoder can be written but not *believed*: every published
description of this format is someone's reverse-engineering, and the only way to
know which parts are still true for the files people actually have is to open
one.

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
