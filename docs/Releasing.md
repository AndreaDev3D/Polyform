# Releasing

How a Polyform release is cut, what a downloader can verify, and what is
deliberately still missing.

## Cutting one

```sh
# 1. version, changelog, notices
npm version 0.7.0 --no-git-tag-version   # or edit package.json
npm run licenses                          # regenerate THIRD-PARTY-NOTICES.md
# ...move the CHANGELOG's "Unreleased" section under the new heading...
git commit -am "0.7.0"

# 2. tag and push
git tag v0.7.0
git push origin main v0.7.0
```

The tag triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. **The whole CI suite runs first** — `release.yml` calls `build.yml`, so a
   release cannot skip the Rust tests, the TS↔WASM parity fuzz, typecheck, the
   190 vitest cases, the notices freshness check, or the input-layer gates.
2. **The tag is checked against `package.json`.** A `v0.7.0` tag on a `0.6.0`
   package produces installers named `0.6.0`; the job fails instead.
3. **Installers are built on all three platforms** and each one is
   **smoke tested** — the packaged app, not the source tree, has to create a
   document, take an agent edit, reopen it in a fresh process, export a PNG, and
   still have its history (`npm run test:packaging`).
4. **SHA-256 checksums** are computed per platform, then merged into one
   `SHA256SUMS.txt` and verified with `sha256sum -c` before publication.
5. **A draft release is created** with every artifact and the checksums.

The draft is the last gate, and it is a human one: open it, read the notes,
download one installer, run it, then press **Publish**. A tag should be able to
produce a release without announcing one.

## Verifying a download

Every release carries `SHA256SUMS.txt`:

```sh
sha256sum -c SHA256SUMS.txt              # Linux
shasum -a 256 -c SHA256SUMS.txt          # macOS
Get-FileHash .\Polyform-Setup-0.7.0.exe -Algorithm SHA256   # Windows, compare by eye
```

Until the artifacts are signed this is the **only** integrity signal a downloader
has, which is why [F-10](Findings-and-Concerns.md#f-10-future-auto-update-security--code-signing-and-artifact-integrity)
lists publishing checksums as an obligation that exists now rather than when the
updater ships.

## What is deliberately not here yet

- **Code signing** (Roadmap 5.2). Windows shows a SmartScreen warning; macOS
  Gatekeeper refuses to open the app without an explicit override. Fixing it is
  certificate logistics — Authenticode (OV minimum, or Azure Trusted Signing)
  plus an Apple Developer ID with notarization — and recurring cost, so the
  funding question comes before the announcement.
- **Auto-update** (Roadmap 5.1), and in that order: `electron-updater` verifies
  the *signature* of what it downloads, and an unsigned package gives it nothing
  to verify. An updater over unsigned artifacts is a remote-code-execution
  channel with a checksum in front of it. Signing is the floor, not the polish.
- **Crash reporting** (Roadmap 5.3), opt-in and local-queue-first when it lands.

## The pieces, and where they live

| Piece | Where |
| :--- | :--- |
| CI: unit gates, input-layer gates, packaged build + smoke test | [`.github/workflows/build.yml`](../.github/workflows/build.yml) |
| Tag → draft release with checksums | [`.github/workflows/release.yml`](../.github/workflows/release.yml) |
| Packaging smoke test | `npm run test:packaging` → `scripts/packaging-smoke.mjs` |
| Third-party notices (generated; CI fails if stale) | `npm run licenses` → `THIRD-PARTY-NOTICES.md` |
| Checksums, identical on every platform | `node scripts/checksums.mjs release` |

Every GitHub Action is pinned to a **commit SHA**, not a tag: what this pipeline
produces is what people install, and a floating tag lets someone else change
what runs after it was reviewed. Upgrading one is a deliberate commit with the
new SHA and the comment updated.

## Dry-running the whole thing locally

```sh
npm run build
npx electron-builder --dir      # or --win / --mac / --linux for real installers
npm run test:packaging
node scripts/checksums.mjs release
```
