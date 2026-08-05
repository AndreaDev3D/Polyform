# `.fig` import — research spike

**Status:** research done, implementation not started. Waiting on real `.fig`
exports to build against (see [What is needed](#what-is-needed-to-start)).
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

Established from several independent write-ups and consistent between them; the
byte offsets below are to be confirmed against a real file before any of this is
committed as code.

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
| 16 | N | **chunk 0 — the schema**, deflate (`78 da`) |
| 16+N | 4 | chunk 1 length |
| 20+N | M | **chunk 1 — the message**, zstd (`28 b5 2f fd`) on recent versions, deflate on older |

Compression is detected from the magic bytes rather than the version number:
version thresholds are a guess about Figma's history, magic bytes are a fact
about the file in front of us.

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
