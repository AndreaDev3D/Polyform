# v0.4.1 Research Spike — On-Device Image Background Removal (Roadmap 4.7)

**Date:** 2026-08-02 · **Status:** complete — decision recorded in ADR-019.
**Question:** which model + runtime gives Polyform one-click, fully offline
background removal that an MIT-licensed app may ship?

## Ground rules (from the roadmap)

1. **Offline only.** A cloud API breaks the local-first contract. Inference
   runs on the user's machine, network cable unplugged.
2. **License-clean.** The model weights and every runtime component must be
   redistributable inside an MIT app. "Free for non-commercial use" is a
   disqualifier, not a discount.
3. **No silent downloads.** Either the model ships in the installer or it is
   an explicit, consent-gated one-time download.
4. **Zero native modules.** Same rule that picked sql.js over
   better-sqlite3 (ADR-005) — the app must keep building without a compiler.

## Model candidates

| Model | License | ONNX size (practical variant) | Notes |
| :-- | :-- | :-- | :-- |
| **ISNet (DIS)** | **Apache-2.0** ✓ | **~44 MB quantized (quint8), ~88 MB fp16** | The dichotomous-segmentation workhorse; proven **in production browser use** — img.ly's commercial background-removal product ships exactly this model quantized. Strong general-purpose edges on products and photos. |
| **BiRefNet / BiRefNet_lite** | **MIT** ✓ | lite: 115 MB fp16 / 224 MB fp32 (community ONNX) | Current open-weights quality leader for dichotomous segmentation; ONNX exports exist (deformable convs rewritten via grid_sample). Bigger and slower than ISNet; the full (non-lite) model is far larger. |
| U²-Net / u2netp | Apache-2.0 ✓ | 176 MB / 4.7 MB | The 2020 classic. u2netp is tiny but visibly weaker edges than ISNet; superseded by its own successor (ISNet is from the same authors). |
| MODNet | Apache-2.0 ✓ | ~25 MB | Portrait-only matting — great hair edges on people, wrong tool for product shots / general graphics. Possible future *supplement*, not the default. |
| RMBG-1.4 / **RMBG-2.0** (BRIA) | **Non-commercial CC; commercial use requires a BRIA agreement** ✗ | — | **Disqualified on license** despite strong quality. (Instructive: RMBG-2.0 is architecturally BiRefNet trained on licensed data — the architecture is open, the weights are not.) |

**Wrapper library note:** `@imgly/background-removal` (the popular npm
package) is **AGPL-3.0** — linking it into an MIT app is not acceptable. We
use the *models* directly with our own ~200-line pre/post-processing glue
(resize → normalize → run → alpha matte → composite), which is the
well-documented part anyway.

## Runtime candidates

| Runtime | Verdict |
| :-- | :-- |
| **onnxruntime-web** (MIT) in the renderer: **WASM EP baseline, WebGPU EP when available** | **Chosen.** No native modules; the WebGPU execution provider is proven for this exact workload (img.ly published ~20x speedups moving this model from WASM to the WebGPU EP), and Polyform's Electron 38 renderer has WebGPU (our own renderer already uses it). WASM EP is the universal fallback — same graceful-degradation shape as our engine flags. |
| onnxruntime-node in the main process | Native binary per platform — violates rule 4; also serializes image traffic over IPC both ways. Rejected. |
| transformers.js | A convenience layer over onnxruntime-web; we need one model with custom pre/post — the layer adds size, not value. Rejected. |

**Threading:** inference runs in a **Web Worker** (onnxruntime-web supports
it) so a 1–3s inference never blocks the canvas. This is also Polyform's
first renderer-side worker — deliberate groundwork for the deferred engine
flip (V0.4-Porting-Plan closeout note).

**Loading:** packaged apps cannot `fetch()` file:// assets (ADR-015 lesson)
and 44 MB is far past inlining — model bytes load via a main-process IPC
read (`ArrayBuffer` transfer), shipped asar-unpacked like the sql.js wasm.

## Decision (ADR-019)

> **Amended at implementation (2026-08-02), three changes:** (1) distribution
> flipped to **consent-gated download-on-first-use** on user direction —
> installer stays slim, feature is offline after one fetch; (2) quantized
> copies avoided — the circulating ones ship inside AGPL-adjacent packages;
> (3) **real-image acceptance FAILED on ISNet** (mattes too aggressive —
> ate part of the subject) — the pre-approved BiRefNet quality tier was
> promoted to default. This is exactly the RMBG-2.0 architecture the user
> asked about, with MIT weights instead of BRIA's non-commercial license.
> After measurement (ADR-019), the runnable artifact on today's
> onnxruntime-web is **BiRefNet FULL at 512×512 input (fp16 file, ~473 MB)**
> — the 1024-input lite variant trips the WebGPU storage-buffer limit AND
> the wasm32 memory ceiling; 512-full runs on the WebGPU EP at ~5 s.

- **Default model: BiRefNet (512² input)** (ISNet retired; superseded files
  are cleaned from app data). ImageNet normalization, sigmoid-on-logits
  matte, upscaled to source resolution.
- **Quality escape hatch (only if 4.8 acceptance testing shows ISNet edge
  quality failing on real docs): BiRefNet_lite fp16 (115 MB, MIT) as a
  consent-gated one-time download.** Not built until proven necessary.
- **Runtime: onnxruntime-web, WASM EP baseline + WebGPU EP opportunistic,
  in a Web Worker.** Own glue code; no AGPL wrapper.
- **Document semantics (4.8):** the cutout is written as a NEW SHA-256
  content-addressed asset; the image fill swaps `assetHash`; the original
  stays in `assets/`; one journal entry; "Restore original" swaps back.

## Acceptance gates for 4.8 (written now, tested then)

1. Offline: cutout succeeds with networking disabled.
2. License audit: `licenses` check on the shipped model + runtime files.
3. Quality: side-by-side on a fixed set (product shot, portrait hair,
   fine-edge object, transparent-ish object) — recorded in the PR.
4. Perf: < 4 s on WASM EP mid-hardware, < 1 s on WebGPU EP for 2048px
   input; UI never drops frames (worker-hosted).
5. Non-destructive: restore-original is byte-identical (same hash).

## Sources

- [BiRefNet repo (MIT)](https://github.com/ZhengPeng7/BiRefNet) · [community ONNX exports](https://huggingface.co/onnx-community/BiRefNet-ONNX) · [lite ONNX sizes](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX)
- [ISNet/DIS (Apache-2.0)](https://github.com/xuebinqin/DIS)
- [RMBG-2.0 license terms (non-commercial CC / BRIA agreement)](https://huggingface.co/briaai/RMBG-2.0)
- [img.ly on ONNX Runtime WebGPU for this workload](https://img.ly/blog/browser-background-removal-using-onnx-runtime-webgpu/) · [@imgly/background-removal is AGPL](https://www.npmjs.com/package/@imgly/background-removal)
