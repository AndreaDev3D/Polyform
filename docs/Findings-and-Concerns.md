# Findings and Concerns — Engineering Risk Register

**Project:** Polyform — current through v0.6 (F-01…F-20)
**Companion documents:** [Architecture-Decisions.md](./Architecture-Decisions.md), [Technical-Specification.md](./Technical-Specification.md)

This is the honest ledger of where Polyform cuts corners, what those corners cost, and what we do about each one. Every entry has a **severity** (impact × likelihood for real users on the current feature set), a description of the actual failure mode, and a **mitigation** split into what ships now versus what the roadmap owes. Entries are amended in place as the picture changes — a finding whose fix shipped keeps its number and gains a status note, so the history of the risk stays readable.

Severity scale: **High** — can lose user data or block core workflows; **Med** — visible quality/performance defects in normal use; **Low** — edge-case or cosmetic, acceptable with disclosure. **Fixed** — the failure is gone and a gate holds it that way.

| # | Finding | Severity |
| :-- | :-- | :-- |
| [F-01](#f-01) | Canvas2D performance ceiling | Med (GPU beta is the measured escape hatch, ADR-016) |
| [F-02](#f-02) | Text fidelity gaps without HarfBuzz | Low (shaping shipped v0.4, ADR-018; bidi/caret/feature-UI open) |
| [F-03](#f-03) | Boolean precision on curves | Low (exact CSG default since v0.4; TS fallback + SVG export unchanged) |
| [F-04](#f-04) | Stroke-align approximation artifacts | Low |
| [F-05](#f-05) | sql.js memory-resident DB + persistence/corruption | High |
| [F-06](#f-06) | Electron packaging pitfalls (asar + WASM) | High (at release time) |
| [F-07](#f-07) | Autosave vs data-loss windows | Med |
| [F-08](#f-08) | Undo journal growth and compaction | Med |
| [F-09](#f-09) | .poly portability caveats (fonts not embedded) | Med |
| [F-10](#f-10) | Future auto-update security | High (deferred, groundwork now) |
| [F-11](#f-11) | Memory for large images (and 3D models since v0.5) | Med |
| [F-12](#f-12) | Instance sync hashing cost (v0.3) | Med (High with big/many components) |
| [F-13](#f-13) | Nested-instance override capture depth (v0.3) | Med |
| [F-14](#f-14) | Library updates can orphan overrides (v0.3) | Med |
| [F-15](#f-15) | Plugin runner is unsandboxed (v0.3 preview) | High (consent-gated) |
| [F-16](#f-16) | Background blur backdrop pass cost (v0.2) | Low (resolved in GPU mode, ADR-017; Canvas2D default unchanged) |
| [F-17](#f-17) | Plugin preview is CSP-blocked in the built app (v0.3) | Med |
| [F-18](#f-18) | Add-text deleted its own node via a mid-gesture focus bounce (≤v0.3, fixed v0.4) | Fixed (High while live) |
| [F-19](#f-19) | Every double-click gesture was dead — `PointerEvent.detail` is always 0 (v0.1–v0.5, fixed v0.5) | Fixed (High while live) |
| [F-20](#f-20) | The agent endpoint is a local network listener inside the app (v0.6) | Med (accepted, mitigations shipped with it) |

---

<a id="f-01"></a>
## F-01. Canvas2D performance ceiling — and when WebGPU stops being optional

> **Status (v0.4): the escape hatch exists and is measured.** The WebGPU
> backend shipped as a beta (View → GPU Rendering, ADR-016/017/018) and
> pans **100,000 shapes at 60 fps** — 0.18 ms CPU per frame, one draw
> call — against the Canvas2D reference at 11/11 pixel-parity fixtures.
> Canvas2D is still the default renderer, so the ceiling below is still
> what most users hit; the difference is that escaping it is now a toggle
> rather than a project. This entry closes when GPU mode becomes the
> default.

**Severity: Med** on the default (Canvas2D) renderer; mitigated by the GPU beta.

### The problem

Canvas2D (ADR-003) is GPU-composited, but the *issuing* of draw commands is single-threaded JavaScript, and Skia's Canvas2D path re-rasterizes on state changes. Costs stack in three places:

1. **Per-draw-call JS overhead.** Each shape is a sequence of context calls (`save`, `transform`, `beginPath`, path verbs, `fill`, `restore`). At ~5,000+ visible nodes per frame this alone approaches the 16 ms budget, independent of pixel work.
2. **Fill-rate and effect cost.** `filter: blur(...)` (layer blur) and `shadowBlur` (drop shadow) trigger expensive intermediate-surface rasterization. A handful of large blurred layers on a 4K display can halve frame rate on integrated GPUs.
3. **No incremental repaint.** The v0.1 loop repaints the full viewport when the scene version bumps (ADR-010). Viewport culling via the rbush R-tree keeps *off-screen* work at zero, but everything on screen redraws.

### What holds it up in practice

Viewport culling + spatial index means performance tracks *visible* complexity, not document size. Typical v0.1 documents (hundreds to low-thousands of visible nodes, few large blur effects) hold 60 fps comfortably.

### When WebGPU becomes mandatory

Concrete triggers, in expected order of arrival:

* Sustained frame time > 16 ms with the profiler showing draw-call issue time (not engine logic) dominating — expected around 5–10k visible nodes.
* Multiple full-screen blur/shadow effects on 4K displays (design-system hero screens are the realistic case).
* Features Canvas2D cannot express: inner shadow, background blur, the full blend-mode set, HarfBuzz-shaped subpixel glyph runs (F-02).

### Mitigation

* **Now:** viewport culling (shipped); pixel grid only above zoom threshold (shipped); keep `IRenderer` the sole context toucher so backend swap stays clean (ADR-003).
* **Cheap next steps before WebGPU:** dirty-rect repaint regions; offscreen-canvas caching of effect-heavy subtrees keyed by node version; render-during-interaction degradation (drop shadows/blurs while dragging, restore on release).
* **Structural fix:** WebGPU backend behind `IRenderer` (planned, not yet). Begin the spike when any trigger above reproduces on a real user document.

---

<a id="f-02"></a>
## F-02. Text fidelity gaps without HarfBuzz

> **Status (v0.4 Sprint E): largely resolved.** Text now shapes through
> rustybuzz (the pure-Rust HarfBuzz port) in the engine core by default
> (ADR-018): kerning and ligatures come from the font's own tables, layout
> is deterministic and version-pinned to the shipped WASM binary (no more
> re-flow across Chromium upgrades), and both renderers consume the same
> positioned-glyph runs (Canvas2D fills outlines, WebGPU draws atlas
> quads). Letter-spacing now applies per shaped cluster. Still open from
> the list below: RTL/bidi itemization, cluster-aware caret movement in the
> edit overlay, an OpenType feature UI, and color emoji in shaped runs
> (single-run LTR shaping only for now — the legacy Canvas2D path remains
> the automatic per-node fallback, including while font bytes load).

**Severity: Low** (was Med) — Latin-script fidelity is now deterministic and feature-correct; internationalization gaps remain.

### The problem

v0.1 shapes and measures text with Canvas2D (`measureText` + `fillText`), which delegates to Chromium's text stack but exposes **no shaping control**:

* **Ligatures / OpenType features:** no way to toggle `liga`, `ss01`, tabular figures, etc. Chromium applies its defaults; the user cannot override, and defaults may differ from what Figma showed them for the same font.
* **Kerning:** applied by Chromium per-run, but Polyform's letter-spacing implementation interacts with it crudely (spacing is applied uniformly, which breaks kern pairs at nonzero tracking).
* **RTL and bidi:** `fillText` handles simple RTL runs, but Polyform's caret placement, selection geometry, and line-breaking in the edit overlay assume LTR visual order. Mixed-direction text will select and edit incorrectly.
* **Emoji and complex scripts:** color emoji render (Chromium handles fallback), but cluster-aware caret movement is approximated; Indic/Arabic contextual forms render correctly only because Chromium shapes them — Polyform's per-character measurement of those runs is wrong, so cursor positions inside shaped clusters drift.
* **Cross-version stability:** shaping output can shift between Chromium (Electron) upgrades, subtly re-flowing documents. Layout is not pinned to a shaping engine version.

### Mitigation

* **Now:** be honest in docs and UI — no OpenType feature UI is exposed (nothing pretends to work); auto-resize and alignment use whole-run `measureText`, which is reliable for the supported cases; keep all text measurement behind the engine's text-metrics API so the shaping engine is swappable.
* **Planned fix:** HarfBuzz (WASM) shaping producing positioned-glyph runs consumed by `IRenderer`, giving deterministic, version-pinned, feature-controllable shaping — scheduled alongside the WebGPU glyph pipeline (spec §5). Variable fonts and OpenType feature UI ride on this.
* **Do-not-do:** do not build caret/bidi logic on top of Canvas2D metrics beyond current scope; that work would be thrown away when HarfBuzz lands.

---

<a id="f-03"></a>
## F-03. Boolean precision on curves

> **Status (v0.4 Sprint B): largely resolved.** Boolean evaluation now runs
> exact bezier CSG in the Rust core by default (flo_curves via WASM, ADR-015)
> — intersections are computed on the curves and flattening happens only at
> display output (0.25 vs the old 0.5 input tolerance), measured 2x faster
> than the polygon-clipping path. The TS approximation below remains as the
> automatic fallback, and SVG export still emits flattened rings for boolean
> results (curve-preserving export lands with the Sprint C/D export work).

**Severity: Low** (was Med) — exact on the default Rust path; the description
below now applies only to the TypeScript fallback and to SVG export of
boolean results.

### The problem (as it stands on the TS fallback)

Boolean groups flatten beziers to polylines before clipping (ADR-007). Consequences:

* **Faceting:** curved edges in boolean output are many short line segments. Invisible at typical zoom; visible at high zoom and in scaled-up exports.
* **Point-count inflation:** SVG export of boolean results emits the flattened polygons — file sizes balloon and downstream editors show dense vertex chains instead of clean curves.
* **Tolerance coupling:** flattening tolerance is chosen for display fidelity; PNG export at 4x can expose facets that were subpixel at 1x.
* **Numeric edge cases:** near-tangent curves may flatten into slivers that survive as degenerate polygons in the result.

The non-destructive structure (children preserved, result computed on evaluation) contains the blast radius: no user geometry is destroyed, and a better evaluator retroactively improves every existing document.

### Mitigation

* **Now:** zoom/scale-aware flattening tolerance (tighter when the evaluation feeds a high-resolution export); post-clip collinear-point simplification to cut point counts; documented as a known approximation.
* **Planned fix:** exact bezier CSG in the Rust core (kurbo-style curve intersection or Skia PathOps via WASM) as one of the first phase-2 modules — ADR-007's revisit criteria.
* **Watch:** user reports of visible faceting in exports are the promotion trigger to High.

---

<a id="f-04"></a>
## F-04. Stroke-align approximation artifacts

**Severity: Low** — cosmetic, bounded, and disclosed.

### The problem

Canvas2D only strokes center-aligned. Polyform approximates **inside** by clipping a double-width stroke to the shape's fill region, and **outside** by clipping it to the region's complement. Known artifacts:

* **Corner joins:** miters/rounds are computed for the double-width center stroke *then* clipped, so sharp corners can differ subtly from a true inside/outside offset (slightly clipped miters, asymmetric round joins).
* **Dashed strokes:** dash pattern lengths are measured along the center path; on inside/outside alignment the visual dash rhythm at tight curves deviates from a true offset path.
* **Open paths:** inside/outside alignment on open paths (lines, unclosed pen paths) is geometrically ill-defined; Polyform falls back to center, which is the correct product answer but a silent one.
* **Effects interaction:** drop shadow is derived from the shape geometry, not the clipped stroke silhouette, so shadows of outside-aligned strokes hug the shape slightly too closely.

### Mitigation

* **Now:** the approximation is pixel-accurate for the dominant cases (rectangles, ellipses, closed shapes at moderate stroke weights); inspector labels the behavior honestly (docs mark align as "approx").
* **Planned fix:** true offset-path stroking arrives with the exact-geometry work in the Rust core (same machinery as F-03) or with a WebGPU stroker; no interim JS offset-path implementation is planned — the corner cases (self-intersecting offsets) are the hard part and would be rebuilt anyway.

---

<a id="f-05"></a>
## F-05. sql.js memory-resident database — persistence and corruption strategy

**Severity: High** — this is a data-durability surface; treated accordingly.

### The problem

sql.js (ADR-005) holds `history.sqlite` entirely in WASM memory. Three distinct risks:

1. **Persistence granularity.** The on-disk file only advances when Polyform exports the DB image. Crash between exports loses journal entries written since the last export (bounded by F-07's autosave cadence).
2. **Torn writes.** Naively overwriting `history.sqlite` in place means a crash mid-write leaves a half-old/half-new byte soup that SQLite cannot open — silently destroying *all* history, not just recent entries.
3. **Memory footprint.** The full journal occupies renderer memory for the life of the document (compounds with F-08 growth and F-11 image memory).

### Mitigation (shipped)

* **Atomic tmp+rename writes, always.** Every persistence path (scene.bin, manifest.json, history.sqlite) writes to a temp file in the same directory, flushes, then renames over the target. Rename-in-same-directory is atomic on NTFS, APFS, and ext4 — the on-disk file is always either the complete old version or the complete new version, never a tear.
* **Open-time behaviour — partly shipped, and this entry used to overstate it.** What exists: `HistoryDb.open` catches any failure to read or parse `history.sqlite` and starts a fresh journal, so **the scene itself is never held hostage by history** — `scene.bin` is the document of record and history is additive. What does *not* exist yet, despite being described here as shipped since v0.1: the header-magic/integrity probe, and the quarantine rename to `history.sqlite.corrupt-<timestamp>`. Today an unreadable journal is silently replaced, and the next persist overwrites the file that might have been recoverable. Found while building the packaging gate (which reads the journal's bytes precisely *because* the app's own answer is cheerful either way); corrected here rather than left as a claim. **Obligation:** rename-before-replace is a handful of lines and should land before v1.0 — losing history quietly is the failure mode this cluster exists to prevent.
* **Export coupling:** the DB image is exported on the same cadence as autosave (30 s) and on explicit Save/Save As/close, so journal and scene can't drift far apart.

### Residual risk and roadmap

* Journal entries inside the last autosave window are lost on hard crash (accepted; see F-07).
* If memory residency becomes a real ceiling (F-08 metrics), options in order: aggressive compaction, journal segmentation (cold segments on disk only), then a native/Rust SQLite driver — ADR-005's revisit.

---

<a id="f-06"></a>
## F-06. Electron packaging pitfalls — asar and `sql-wasm.wasm`

**Severity: High at release time** — the classic failure is an app that works in dev and dies on first launch when installed.

### The problem

Electron packs app sources into an `asar` archive. Two landmines for Polyform specifically:

1. **`sql-wasm.wasm` inside asar.** sql.js loads its WASM binary via a file fetch at runtime. Paths inside asar are virtual — WASM streaming/instantiation from an asar-internal path fails or silently falls back depending on loader behavior. The binary must be **asar-unpacked** (`asarUnpack`/`extraResources`) and located via a runtime-resolved path (`app.getAppPath()` + unpacked-dir rewrite), not a dev-relative URL.
2. **Dev/prod path drift.** electron-vite dev serves the renderer from a dev server; production serves from `file://`-adjacent packaged paths. Anything that resolves the WASM binary, default assets, or the sqlite journal with a path computed at build time will differ between the two. CSP and `file://` fetch rules also differ.

Adjacent pitfalls tracked with them: native menu/accelerator registration differing across platforms; Windows installer paths with spaces breaking naive path concatenation; per-platform userData locations for recents/settings.

### Mitigation

* **Now:** `sql-wasm.wasm` is declared in `asarUnpack`, and exactly one place resolves it — `getSqlJs()` in `main/history-db.ts`, via `require.resolve('sql.js')` rather than a build-time path. (This entry used to describe a shared `resolveWasmPath()` helper; there is no such function. One call site is the same guarantee as long as it stays one.)
* **The smoke test exists now — `npm run test:packaging`, and in CI on all three platforms.** It was described here as shipped from v0.1 and was not; it landed in v0.6. It drives the **packaged** app rather than the source tree: asserts the asar layout and the unpacked WASM, runs the whole CLI gate against the packaged binary (create → agent edit over stdio → reopen in a fresh process → export), then reads `history.sqlite` and finds the edit's journal entry in the bytes.
* **One correction from actually running it.** Removing `asarUnpack` and rebuilding leaves the app **working** on Electron 38: `locateFile` hands emscripten a path and Electron's patched `fs` reads it happily from inside the archive. The failure this entry describes did not reproduce here. The unpack rule stays — it is cheap, it is what the loader documentation asks for, and "it happens to work on the platform I built on" is precisely how this class of bug ships — but the gate is a config-drift guard, not a crash reproduction, and the entry should not have claimed a certainty nobody had measured.
* **Rule:** every runtime-loaded binary asset added later (HarfBuzz WASM, CanvasKit, future Rust core `.wasm`) goes through one resolver and the same smoke test. The failure mode recurs with every new WASM module if this isn't habitual.
* **CI:** GitHub Actions builds and smoke-tests the package on Windows, macOS and Linux on every push, and a tag additionally produces a draft release with SHA-256 checksums (`.github/workflows/release.yml`, [docs/Releasing.md](Releasing.md)). Packaging breakage is caught per commit, not on release day.

---

<a id="f-07"></a>
## F-07. Autosave vs data-loss windows

**Severity: Med** — bounded loss, but users judge design tools harshly on this.

### The problem

Autosave runs every **30 seconds** (plus on explicit save and window close). The loss windows:

* **Hard crash / power loss:** up to 30 s of scene edits and journal entries vanish. For fast-working designers that can be a nontrivial burst of work.
* **Save-in-progress crash:** covered by F-05's atomic tmp+rename — no torn files, worst case is the previous complete state.
* **Scene/journal skew:** scene.bin and history.sqlite are exported on the same cadence but not in a single atomic transaction across both files. A crash between the two renames can leave a scene newer than its journal tail (harmless — undo just starts from the loaded state) or a journal referencing patches ahead of the scene (detected at load via the scene version stamp recorded with each journal entry; trailing orphan entries are dropped).

Also worth naming: autosave writes the *document*, silently — there is no separate "unsaved changes" recovery file, so "I didn't mean to do that and the app crashed after autosave" is not recoverable beyond undo (which, mitigatingly, *does* survive restart by design).

### Mitigation

* **Now:** 30 s cadence + save-on-close + atomic writes + load-time skew reconciliation (above); dirty-flag tracking off the patch stream (ADR-010) means autosave is a no-op when idle — no gratuitous disk churn or thumbnail invalidation.
* **Cheap improvements queued:** event-driven autosave debounce (save N seconds after the *last* mutation rather than fixed-interval, shrinking the practical window during active editing); journal-first ordering (export journal before scene) so the recoverable direction of skew is the one that always occurs.
* **Position:** session-spanning undo is the real safety net — even "lost" intent inside the window is usually one restart + Ctrl+Z away from irrelevant, and that property should be protected above all in future changes.

---

<a id="f-08"></a>
## F-08. Undo journal growth and compaction strategy

**Severity: Med** — unbounded today; growth rate is the price of ADR-008's durability wins.

### The problem

Patch-based entries (ADR-008) store before *and* after values, and deletions store entire serialized subtrees. Unlimited, session-spanning history means `history.sqlite` grows monotonically for the life of the document. Hotspots:

* **High-frequency gestures:** an uncoalesced drag would write a patch per mousemove.
* **Delete-heavy workflows:** deleting a large frame writes its whole subtree into the journal.
* **Image-adjacent churn:** patches reference asset hashes (small), but repeated paste/delete of big subtrees still bulks the log.
* Growth hits twice: disk (`.poly` size, F-09 portability) and memory (sql.js residency, F-05).

### Mitigation

* **Now (shipped):** gesture coalescing — a drag/resize/rotate/nudge-run commits **one** journal entry (original before, final after) at gesture end, not per-event. This alone removes the dominant growth term.
* **Compaction strategy (design settled, implementation staged):**
  1. **Segment + checkpoint:** periodically record a scene checkpoint marker; entries older than the last N checkpoints become a "cold" segment.
  2. **Cold-segment squashing:** coalesce runs of patches touching the same node/property within a cold segment (keep first-before + last-after), preserving undo *reachability* while shedding intermediate states.
  3. **Bounded tail (user-visible policy):** optional cap ("keep full history for last N sessions, squashed beyond"), surfaced in settings once the version-history browsing UI (planned) exists — squashing granularity is a UX decision once history is browsable.
* **Instrumentation first:** journal size and entry counts are logged to telemetry-free local diagnostics; compaction phases 2–3 ship when real documents show the need, not speculatively.

---

<a id="f-09"></a>
## F-09. `.poly` portability caveats — fonts are not embedded

**Severity: Med** — the bundle promises portability; text is the asterisk.

### The problem

The `.poly` bundle is fully self-contained for shapes, history, and **images** (content-addressed in `assets/`) — but text nodes reference fonts **by family/style name**, resolved against the *opening* machine's installed fonts via `queryLocalFonts` (ADR-006). Move a document to a machine missing the font and:

* Text renders in a fallback face; metrics change; auto-resize re-measures — **layout shifts**, silently, and hug-content auto-layout frames reflow around it.
* There is no missing-font manifest today: the user isn't told what's missing or where it was used.
* Cross-platform is the common trigger (macOS system fonts opened on Windows), not exotic type foundries.

Secondary caveats, same family: absolute paths are never stored (good — the bundle is location-independent), but the bundle is a *directory*, which some channels (email, some upload forms) handle worse than a single file; users may also copy the directory mid-write, though atomic renames (F-05) keep any snapshot internally consistent.

### Mitigation

* **Now:** document the limitation prominently (this file, README, product docs); font references store family + style + resolved full name, which is the data a missing-font dialog needs.
* **Queued (cheap, high value):** missing-font detection at open — diff document font references against `queryLocalFonts` results and show a "Missing fonts: X, Y (used on N layers)" notice instead of silent fallback. This is the single best ROI item in this register.
* **Planned:** font embedding into `assets/` (fonts are just content-addressed bytes; the pipeline already exists) — gated on honoring OpenType `fsType` embedding-permission flags, which requires reading font tables (ADR-006's revisit). Until then, "portable except fonts" is the honest contract.
* **Considered/deferred:** zip-packing the bundle into a single `.poly` file — deferred because directory bundles keep assets diffable and dedupe-friendly for git-adjacent workflows.

---

<a id="f-10"></a>
## F-10. Future auto-update security — code signing and artifact integrity

**Severity: High when auto-update ships; groundwork obligations exist now.**

### The problem

Auto-update from GitHub Releases is planned (CI groundwork ships in v0.1). An auto-updater is a remote-code-execution channel by design; done carelessly it is the single largest security hole a desktop app can have:

* **Unsigned artifacts:** without code signing, users get scary OS warnings (SmartScreen, Gatekeeper) *and* have no way to distinguish a real release from a tampered one.
* **Update-feed trust:** an updater that trusts "whatever the latest GitHub Release says" is only as strong as the GitHub account/token security of every maintainer with release rights.
* **CI supply chain:** artifacts built in GitHub Actions inherit the integrity of the workflow — a compromised action dependency or a `pull_request_target` misconfiguration can poison releases at the source.
* **Downgrade attacks:** an updater that accepts any signed version can be fed an old, vulnerable-but-signed build.

### Mitigation

* **Now (while auto-update does not exist):** CI builds are reproducible-leaning (locked dependency versions, pinned action SHAs — not floating tags); SHA-256 checksums published alongside every release artifact; release creation restricted to protected tags.
* **Blocking requirements before the auto-updater ships (treat as a launch checklist):**
  1. **Windows:** Authenticode signing (OV minimum; EV or Azure Trusted Signing to clear SmartScreen reputation faster). **macOS:** Developer ID signing + notarization — non-negotiable, unsigned updates will not even run on modern macOS.
  2. Updater verifies **signature, not just checksum**, of downloaded artifacts before staging (electron-updater does this correctly *only when* packages are signed — signing is therefore the security floor, not a polish item).
  3. Signing keys live in CI secrets/HSM-backed signing service, never in the repo or on maintainer laptops.
  4. Version monotonicity enforced (reject downgrades) and update metadata fetched over TLS with certificate validation left ON (a depressingly common Electron footgun is disabling it "temporarily").
* **Cost note for planning:** OV certificates and Apple Developer Program are recurring paid costs for an open-source project — the funding question should be settled before, not after, the updater is announced.

---

<a id="f-11"></a>
## F-11. Memory for large images (and, since v0.5, 3D models)

**Severity: Med** — the failure mode is renderer OOM or GPU-memory thrash on image-heavy documents.

### The problem

Image fills (ADR-009) decode to bitmaps for rendering. Costs:

* A decoded image costs `width × height × 4` bytes regardless of file size on disk: a 12 MP photo is ~48 MB decoded; a 45 MB `.poly` full of photos can want gigabytes of decode memory if everything is held decoded simultaneously.
* Content-addressed **storage** dedupes perfectly (ten uses, one file — ADR-009), and decode caching by hash means ten uses also share **one** decoded bitmap — but *distinct* large images accumulate.
* Canvas2D drawing of large images at small on-screen sizes still uploads the full bitmap to the GPU texture path; zoomed-out overview pages full of screenshots are the worst case.
* sql.js residency (F-05) and journal growth (F-08) share the same renderer-process memory budget; these compound.

### Mitigation

* **Now (shipped):** decode-once-per-hash cache keyed by asset hash; viewport culling means off-screen images aren't drawn (though currently they may remain decoded once loaded).
* **Queued, in order of ROI:**
  1. **LRU eviction** on the decode cache with a byte budget (re-decode on demand — decode is fast relative to OOM).
  2. **Downsampled display proxies:** decode to a mip-appropriate size for the current zoom via `createImageBitmap(resizeWidth/Height)`; full-resolution decode only for high zoom and export paths.
  3. **Import-time guardrail:** warn (not block) on placing images above a size threshold, with a one-click "downsample copy into assets" offer — original bytes preserved by content addressing if declined.
* **Watch:** renderer memory on documents with 20+ distinct multi-megapixel images is the metric; if proxies (step 2) don't hold it, image decode moves off-thread (worker + `ImageBitmap` transfer) ahead of schedule.

---

<a id="f-12"></a>
## F-12. Instance sync hashing cost

**Severity: Med** today; **High** for documents with many or large components.

### The problem
Instance staleness (ADR-012) is detected by hashing `JSON.stringify` of the component subtree + overrides on every derived pass — i.e., after every commit, transient drag frame, and undo. Cost is O(total component content) per scene change. With dozens of instances of large components, this eats the frame budget during drags even when nothing component-related changed.

### Mitigation
Shipped: hashing is djb2 over one serialization pass (no tree diffing), and unchanged hashes skip materialization entirely. Planned (v0.4): the Rust core owns dirty-tracking — component subtree revision counters bumped by the op applier make staleness O(1), deleting the hash entirely. The `syncedHash` field is engine-internal, so this swap is invisible to the file format (the field just stops being consulted).

---

<a id="f-13"></a>
## F-13. Nested-instance override capture is nearest-instance only

**Severity: Med** — correctness edge, silent when it bites.

### The problem
Edits inside an instance are captured into the *nearest* enclosing instance's override map. When instances nest (component B contains an instance of A, and a document instance of B is edited inside the inner A), the override lands on the materialized inner instance — which is itself regenerated whenever B changes, discarding that override map.

### Mitigation
Shipped: single-level instances (the overwhelmingly common case) are fully correct; the structural lock prevents the worst confusion. Documented here rather than hidden. Planned: override *paths* (chains of sourceIds) captured to the outermost instance — designed alongside variant properties, which need the same addressing scheme; doing it once, correctly, beats doing it twice.

---

<a id="f-14"></a>
## F-14. Library updates can orphan instance overrides

**Severity: Med** — data is not lost, but intent can be.

### The problem
"Update from library" replaces an imported component's children with freshly-imported (re-identified) nodes. Instance overrides are keyed by the *old* child ids; after the update the sync pass regenerates instances against new ids, so overrides keyed to replaced children silently stop applying.

### Mitigation
Shipped: the update is an explicit, user-initiated pull (never a background surprise), it is one undoable entry (Ctrl+Z restores the previous component *and* re-applies old overrides), and instance geometry/position are never touched. Planned: structural re-keying (match old→new children by path/name/type) in the v1.0 update-review flow.

---

<a id="f-15"></a>
## F-15. Plugin runner executes untrusted code with document access

**Severity: High**, deliberately accepted for a consent-gated dev preview (ADR-014).

### The problem
`Plugins → Run Plugin Script…` evaluates arbitrary JavaScript in the renderer. Context isolation + sandbox keep Node and the filesystem out of reach, but a hostile script can still read and mutate the open document, spam dialogs, or hang the renderer.

### Mitigation
Shipped: explicit file pick each run (no auto-run, no plugin folder scanning), a plain-language consent dialog, all mutations in one rollback-able history entry, and `docs/Plugin-API.md` states the trust model in bold. **Since v0.6 this has a demonstrated second-order consequence**: because plugin code shares the renderer realm, it reaches whatever the preload exposes there — which nearly let a plugin start the agent endpoint without consent (F-20). New privileged surfaces are now handed out once, at startup, instead of being left on a global; that is a workaround for the missing isolation, not a substitute for it. Planned (post-1.0): worker isolation with a typed message bridge and manifest permissions — the current API surface was shaped so that migration is additive (`await` in front of the same calls).

---

<a id="f-16"></a>
## F-16. Background blur's backdrop pass is a full-canvas self-draw

**Severity: Low** (was Med) — purely a performance concern, and resolved on
the GPU backend; open only while Canvas2D is the default.

### The problem
Each node with background blur clips to its shape, then redraws the *entire canvas* through a blur filter (backdrop capture). Several such nodes stack full-canvas passes per frame; on a 4K viewport this is the single most expensive effect in the renderer.

### Mitigation
Shipped (Canvas2D): the pass runs only for nodes actually carrying the effect, and only within their clip. Documented in the matrix as the expensive effect.

**Resolved in GPU mode (v0.4, ADR-017):** the WebGPU compositor renders backdrop blur as a scoped pass split — snapshot the resolved backdrop, separable-gaussian ping-pong, resume the pass drawing the node's fill mesh sampling the blurred texture. The cost model is now explicit and bounded: one split + one fullscreen blur pair per backdrop-effect node per frame, zero cost to scenes without them. Canvas2D (still the default renderer) keeps the original behavior, so this entry stays open at Low severity until GPU mode is the default.

---

<a id="f-17"></a>
## F-17. Plugin dev preview is blocked by the renderer CSP

**Severity: Med** — a dev-preview feature silently can't run; no data risk.

### The problem
Discovered during the v0.4 Sprint A CSP work: the plugin runner executes scripts via `new Function` (actions.ts), but the renderer CSP (`script-src 'self'`) has never included `'unsafe-eval'` — so Chromium refuses the evaluation and the runner's catch block reports the script as failed. The v0.3 preview shipped effectively non-functional under its own CSP. (Sprint A added `'wasm-unsafe-eval'`, which permits **only** WebAssembly compilation — it does not and must not unblock `new Function`.)

### Mitigation
None shipped — loosening the CSP to `'unsafe-eval'` for the whole renderer is the wrong trade for a preview feature. The correct fix is the already-designed post-1.0 sandbox (worker with its own CSP + typed bridge, ADR-014/Plugin-API.md); pulling a minimal version of it forward is the recommended path if plugins matter before then. Until fixed, the feature matrix marks plugins accordingly.

---

<a id="f-18"></a>
## F-18. Add-text deleted its own node via a mid-gesture focus bounce

**Severity: Fixed (was High — blocked a core workflow)** — user-reported during v0.4; present since at least v0.3 in built/preview mode.

### The problem
Placing a text node (T + click) opens the DOM textarea overlay, which focuses itself in a mount effect and commits on blur — deleting the node when the text is still empty ("Remove Empty Text"). Chromium can bounce focus straight off a textarea that is focused while a pointer gesture is active: a **trusted** `focusout` with `relatedTarget: null` fires ~1ms after `focus()`, with the window focused and no code calling `blur()`. The blur handler committed the empty node and deleted it before the user could type a character. Every freshly placed text node died instantly; the same one-shot bounce did not recur on manual refocus.

Bisection (CDP-automated: real key/mouse events against built apps at v0.3, Sprint D, and HEAD) showed the bug at **every** commit tested — this was not a v0.4 regression but a survivor of the v0.1.1 StrictMode-era fix, invisible to all existing gates because no engine test or render fixture exercises DOM focus.

### Mitigation
Fixed: a blur that lands **nowhere** (`relatedTarget === null`) while the window still has focus is never a deliberate end-of-edit — the overlay re-arms focus instead of committing. All real exits keep committing: focusing another control (relatedTarget set), clicking the canvas (the controller clears `editingTextId` → unmount commit), window deactivation (`document.hasFocus()` false), Escape/Ctrl+Enter.

**New gate:** `npm run test:e2e` boots the built app under the DevTools protocol, simulates the real gesture (T, timed click, typing, Escape), and asserts the text survives and no "Remove Empty Text" entry appears. (It has since grown the F-19 gesture gates too.) This is the register's reminder that focus/DOM interplay needs end-to-end coverage — unit and pixel gates cannot see it.

---

<a id="f-19"></a>
## F-19. Every double-click gesture was dead: `PointerEvent.detail` is always 0

**Severity: Fixed (was High — three features unreachable)** — user-reported during v0.5 ("I lose the ability to interact with anything inside a frame"); present since v0.1.

### The problem
The canvas derived its click count from `e.detail` on a **pointerdown** event. Per the Pointer Events spec, `detail` is defined as 0 for `pointerdown`/`pointerup` — only mouse events carry a click count. Verified directly in the built app: a real double-click produces `pointerdown:detail=0, mousedown:detail=1, pointerdown:detail=0, mousedown:detail=2, dblclick:detail=2`.

So `isDouble` was **always false**, and every double-click behaviour in the app was unreachable: drilling into a group or frame, opening an existing text node for editing, entering vector-edit mode (masked, because Enter also works), and — newly added in v0.5 — entering a 3D model's orbit mode. Nothing errored; the gestures simply did nothing, which is why it survived four releases.

Compounding it, single-click resolution returned `topLevelAncestor(hit)`, so clicking anything inside a frame selected the *frame*. With drill-down broken, frame contents could not be selected on the canvas at all — only via the layers panel. That combination is what the user hit.

### Mitigation
Fixed in two parts:

1. **Click counting is timed, not read from the event.** The canvas tracks the previous pointerdown's timestamp and position; a second press within 400 ms and 6 px counts as a double-click. This is the standard approach for pointer events and works for pen and touch, which never carry a click count at all.
2. **Frames are no longer selection units.** `resolveClickTarget` now matches Figma: frames and components are transparent to clicks (their contents are selected directly), while groups, booleans and instances stay atomic — click selects the outermost one, double-click drills in. Drill-down context (`enteredContainer`) still narrows to the direct child, and the ancestor walk terminates at the page (root nodes report the page as their parent, ADR-011).

**New gates:** `selection.test.ts` pins the click-resolution matrix (frame child, nested frames, group, nested group, group-in-frame, instance, drilled context, page boundary), and `npm run test:e2e` now drives a real double-click against the built app and asserts the group drill-down plus direct frame-child selection.

**The lesson, and it is the same one as F-18:** input-layer bugs are invisible to unit and pixel tests. Both were found only by driving the built app with synthetic OS-level input. Any behaviour that depends on DOM event semantics needs an end-to-end gate, not an engine test.

---

<a id="f-20"></a>
## F-20. The agent endpoint is a local network listener inside the app

**Severity: Med — accepted; the consent debt this entry recorded is now paid** (v0.6, ADR-021/ADR-022).

### The problem
Agent connectivity works by Polyform *listening*: an MCP server runs inside the app and an agent connects to it over loopback HTTP. That is a genuinely new class of surface for this codebase — every other integration point so far has been the app reaching out (file dialogs, a model download) or code we load deliberately (plugins, F-15). A listener can be reached by anything already running on the machine, and — the non-obvious one — by any **web page in the user's browser**, since a page can POST to `127.0.0.1` and can be pointed there by DNS rebinding. Once the write surface lands (7.3), reaching it means editing the user's document.

### Mitigation
Shipped with the spike, before anything can write:

- **Off by default.** No listener until the user starts it; no autostart, no background port.
- **Loopback only.** Binds `127.0.0.1`; never `0.0.0.0`, so nothing off-machine can route to it.
- **Ephemeral port.** Port 0 — the OS assigns it, so there is no well-known port to scan for or squat.
- **Per-session bearer token**, freshly generated on start and compared in constant time. `npm run test:mcp` asserts an unauthenticated request gets `401`.
- **Origin/Host validation** against the loopback origin, which is what actually stops the browser-page case. The gate asserts a request carrying a foreign `Origin` gets `403`.
- **Read-only today.** The tools only read; writes are roadmap 7.3 and get their own consent, separate from reads.

Added in 7.2, closing what this entry said was owed:

- **Per-capability consent, revocable live.** Four capabilities, granted individually in Agent → Agent Connection. Revoking one removes its tools from the connected session and refuses the call if a stale client makes it anyway (ADR-022).
- **The endpoint is always visible while it listens** — a status-bar light that distinguishes attached from reading-right-now, pushed from the main process rather than polled, and clickable straight through to revoke.
- **Stopping is immediate and total.** The port closes, the token dies, and sockets are destroyed rather than drained — the gate asserts the port refuses connections afterwards. The endpoint also stops when the last window closes.

### What building it turned up
The first draft of the consent panel was **bypassable, and not through the network**. Plugin scripts run in the renderer's own realm (F-15), so `window.polyform` is theirs too — a plugin could have called `mcpStart()` and opened the listener with no dialog, no light, and no user decision. The panel would have been describing a choice the user never got. The controls are now a one-shot handout claimed at startup, and `npm run test:mcp` runs a plugin-shaped script and asserts it is blocked.

The general lesson is worth more than the fix: **a consent surface is only as strong as the weakest path to the thing it guards**, and in an app that executes user-supplied code in its own realm, the weakest path is usually not the one being consented to.

### Known limit: the session count over-reports
A `StreamableHTTPServerTransport` has no way to notice a client that vanishes without sending `DELETE` — between calls, gone and merely idle look identical. Such a session stays counted until the endpoint is stopped, so the indicator can say an agent is attached after it has died. That is the **conservative** direction for a security light (over-reporting beats under-reporting), and the panel's *last read* line is how you tell live from stale. A well-behaved client, including Claude Code, terminates cleanly and is dropped immediately; `npm run test:mcp` gates that path.

### Closed by 7.3 (2026-08-02)
Both remaining debts are paid: the `edit` capability **defaults off** (reads default on — changing a document is a separate decision from seeing it), and every agent commit is attributed — an `Agent:`-prefixed label, an AGENT chip in the history browser, one journal entry per batch, one Ctrl+Z to undo. What remains open lives under F-15: plugin isolation, on which the claimed-handout argument still rests.

---

## F-21. Writing a node's fields directly leaves the derived caches stale

**Severity: medium (visual, silent) — one instance found and fixed; the class is structural.**

`SceneGraph` caches world matrices and world AABBs, and `bump()` clears them. Every mutation *through* the scene (`addNode`, `moveNode`, `updateNode`, `removeNode`) bumps; a mutation that assigns to `node.x` and then commits with `applied: true` does not. The gap is invisible until something reads a cached value on both sides of the change.

It bit exactly once, and visibly: leaving vector edit re-anchors the path to its own bounding box and moves the node to compensate. Because it wrote `node.x/y/width/height` directly, the **selection overlay kept drawing at the pre-edit position with the post-edit size** — 144 world units out, in the measured repro. It looked like a redraw bug, and clicking away and back "fixed" it because that eventually caused some other mutation to bump the scene.

Fixed by routing the mutation through `updateNode`, so invalidation is part of the operation rather than something to remember. The rest of the direct writes were audited: they are all on nodes *under construction*, before `addNode` (pen finish, paste, SVG import), or inside drag loops that bump explicitly — so this was the only escape.

**Why no test caught it.** The document was correct; only a cache was wrong. Unit tests read the scene, and the scene was right. Pixel-parity tests render from a fresh bake. The overlay is the only reader that keeps a cached matrix across a mutation, so seeing it needs a live overlay **and** a live cache — which is now a check in `npm run test:e2e`.

**Standing obligation.** Prefer the scene's mutators. Where a gesture must write fields directly for performance (the drag loops do, every frame), it owes an explicit `bump()` in the same function — and the reason to look for one is any commit that passes `applied: true`.

---

## F-22. A regression test that has never failed is a guess

**Severity: process, not product — but it invalidated a check before it was ever trusted.**

The first version of the F-21 gate **passed against the unfixed build**. It did the whole sequence — create a path, edit it, exit, read the overlay's box — inside one synchronous `Runtime.evaluate`. Nothing had read the world matrix before the exit, so nothing had *cached* it, so there was no stale value to find. The check was green for the wrong reason, and would have stayed green through a reintroduction of the bug.

What made it real was letting frames render with the path still open, so the pre-exit matrix actually entered the cache. What made it *trustworthy* was then reverting the fix and watching it fail with the same numbers the user reported (`drawn at 300,300, shape at 210,240`).

**Standing obligation.** A new regression check is not finished when it passes. It is finished when it has been shown to fail without the fix — `git stash push` on the fix, rebuild, run, restore. This applies with particular force to bugs about *state that is only wrong for a while*: caches, debounces, animation, anything where the test's own timing decides whether the defect is reachable.

---

## F-23. Pointer-derived state behind a repaint gate: the cursor rarely changed

**Severity: medium (interaction, silent) — found via a complaint about rotation, fixed, now gated.**

The canvas render loop is dirty-gated: it repaints only when the document or the editor store changed. The cursor was written *inside* that gate — one line at the end of the paint. But the cursor is derived from **where the pointer is**, which is not something the store knows: moving the mouse from empty space onto a resize handle or a rotate zone changes `cursorOverride` on the controller and nothing else. No store write, no dirty flag, no paint, no cursor change.

So the app was computing the right cursor and then usually not applying it. Hovering a handle produced feedback only when a repaint happened to be triggered by something else — a hover outline appearing, a marquee, an animation elsewhere — which made it feel intermittent rather than broken. This is most of why rotating "felt like guesswork": the rotate zones were invisible **and** silent, so there was nothing at all to tell you the corner had two meanings.

Fixed by writing the cursor every frame, outside the gate, diffed against the last value so it is still one DOM write per actual change.

**Why no test caught it.** The geometry was never wrong — `boxHandles` and `hitHandle` had (and have) unit tests, and they passed. The controller's `cursor` getter returned the right string when asked. The defect lived entirely in *when the answer was read*, which needs a live pointer over a live overlay: it is now an `npm run test:e2e` check, and confirmed to fail without the fix per [F-22](#f-22-a-regression-test-that-has-never-failed-is-a-guess).

**Standing obligation.** Anything derived from pointer position — cursor, hover affordances, snap candidates, tooltips — must not sit behind the document/store dirty gate. If a new derived value is cheap and pointer-driven, compute it per frame and diff it; if it is expensive, it needs its own invalidation signal, not the paint's.

---

## F-24. A React portal into `document.body` does not stop the app's own key handlers

**Severity: medium (interaction, self-inflicted) — found while replacing the native `<select>`, fixed, now gated.**

The new dropdown renders its menu with `createPortal(…, document.body)`, so the inspector's scroll container cannot clip it. Its keydown handler was an ordinary React `onKeyDown` calling `e.stopPropagation()`, which is what every other field in the app does and what works everywhere inside the React root.

It did not hold. Escape closed the menu **and** reached `window`'s keydown listener, where the global shortcut cleared the selection — which emptied the inspector, which unmounted the dropdown mid-gesture. The next click had nothing to open, so the control appeared to work once and then die. React attaches its listeners to the root container; a portal into `document.body` is not inside it, and whatever delegation React does for the portal container did not stop the native event before it bubbled past.

This was **measured, not reasoned about**: a probe registered its own capture- and bubble-phase keydown listeners on `window` and logged the target of each. Before the fix, both fired with `DIV[listbox]` as the target. After it, only the capture-phase probe (registered first) sees the key.

Fixed by giving the open menu a *native* `keydown` listener on `window` in the capture phase for as long as it is open — an open menu owns the keyboard, and says so ahead of every other listener rather than hoping to out-bubble them.

**Standing obligation.** Any floating surface portalled outside `#root` — menu, popover, picker, dialog — must claim the keyboard natively while it is open, not through a synthetic handler. And the check for it must assert on the *side effect* (the selection survived), not just that the surface closed: closing was never the part that broke.

---

## Reading this register

Three themes run through every entry:

1. **Approximations are disclosed and containable.** F-02/F-03/F-04 (text, booleans, strokes) are quality approximations whose *replacements* are already architecturally placed (HarfBuzz behind text metrics, exact CSG behind non-destructive evaluation, true stroking behind `IRenderer`). None require file-format or UI breakage to fix.
2. **Durability gets the strictest treatment.** F-05/F-06/F-07/F-08 are the data-integrity cluster; the shipped invariants (atomic tmp+rename everywhere, journal quarantine over document hostage, gesture coalescing, packaging smoke test) are the non-negotiables of v0.1.
3. **Deferred features have present-tense obligations.** F-10 (auto-update) doesn't exist yet, but pinned CI actions and published checksums are obligations *now*; F-09's missing-font notice is cheap now and much cheaper than support tickets later.
4. **Anything that lets outside code in gets its defences before its features.** F-15 (plugins) and F-20 (the agent endpoint) are the same shape: capability first draws a threat model, then ships the gate, then ships the capability. F-20's 401/403 checks were written in the same commit as the server, not after it.
5. **Input-layer bugs are invisible to unit and pixel tests.** F-18 and F-19 both survived multiple releases with a green suite, and both were found only by driving the built app with synthetic OS-level input. That is why `npm run test:e2e` exists and why it keeps growing.
6. **A correct document is not a correct app.** F-21 was a stale cache over right data, F-23 was the right answer computed and then not applied, and F-22 is the reason both now have checks that can actually fail: a regression test is finished when it has been shown to go red without its fix, not when it first goes green.
7. **Framework abstractions stop at the framework's boundary.** F-24's `stopPropagation` was correct React and still let the key through, because the surface it was defending sat outside the React root. Where our own event plumbing meets the platform's — portals, native menus, OS popups — the platform's rules are the ones that decide, and the only way to know which applies is to instrument the boundary and read what actually arrives.
