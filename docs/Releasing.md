# Releasing

How a Polyform release is cut, what a downloader can verify, and what is
deliberately still missing.

## Cutting one

**Bump the version. That is the release.**

```sh
npm version 0.8.0 --no-git-tag-version   # or edit package.json
npm run licenses                          # regenerate THIRD-PARTY-NOTICES.md if deps changed
# ...move the CHANGELOG's "Unreleased" section under a new heading...
git commit -am '0.8.0 — "Name"' && git push
```

There is no tag to remember: [`release.yml`](../.github/workflows/release.yml)
runs on every push to `main`, asks whether `package.json`'s version has been
released yet, and stops in ten seconds if it has. When it has not, it releases —
and `gh release create` makes the tag itself from the commit being released.

Pushing a `v*` tag by hand still works, for re-cutting one; the tag then has to
match `package.json` or the run fails rather than shipping mislabelled files.

*Why not have CI push the tag? A tag created with the default token does not
trigger workflows (GitHub's recursion guard), so that route needs a stored PAT.
Letting `gh release create` make the tag needs no secret and has one fewer moving
part.*

Either way, the run:

1. **The whole CI suite runs first** — `release.yml` calls `build.yml`, so a
   release cannot skip the Rust tests, the TS↔WASM parity fuzz, typecheck, the
   vitest suite, the notices freshness check, or the input-layer gates.
2. **The version is resolved once and asserted on every runner**, so the
   artifacts cannot be labelled with a version nobody asked for.
3. **Installers are built on all three platforms** and each one is
   **smoke tested** — the packaged app, not the source tree, has to create a
   document, take an agent edit, reopen it in a fresh process, export a PNG, and
   still have its history (`npm run test:packaging`).
4. **SHA-256 checksums** are computed per platform, then merged into one
   `SHA256SUMS.txt` and verified with `sha256sum -c` before publication.
5. **A draft release is created** with every artifact and the checksums.

6. **A Sigstore build-provenance attestation** is recorded for each artifact.

The draft is the last gate, and it is a human one: open it, read the notes,
download one installer, run it, then press **Publish**. Bumping a version should
be able to produce a release without announcing one.

## Verifying a download

Every release carries `SHA256SUMS.txt`:

```sh
sha256sum -c SHA256SUMS.txt              # Linux
shasum -a 256 -c SHA256SUMS.txt          # macOS
Get-FileHash .\Polyform-Setup-0.7.0-x64.exe -Algorithm SHA256   # Windows, compare by eye
```

Artifact names deliberately contain **no spaces**: GitHub rewrites spaces to dots
on upload, so a `SHA256SUMS.txt` naming `Polyform Setup 0.7.0.exe` could never
verify the `Polyform.Setup.0.7.0.exe` that a browser actually downloads — the one
check we ask people to run, defeated by a filename.

Until the artifacts are signed this is the **only** integrity signal a downloader
has, which is why [F-10](Findings-and-Concerns.md#f-10-future-auto-update-security--code-signing-and-artifact-integrity)
lists publishing checksums as an obligation that exists now rather than when the
updater ships.

## Provenance — what we have instead of a signature

Every artifact also carries a **Sigstore build-provenance attestation**, created
by the release workflow under its own OIDC identity:

```sh
gh attestation verify Polyform-Setup-0.7.0-x64.exe --repo AndreaDev3D/Polyform
```

That proves the file came out of *this repository's release workflow at that
commit*, rather than off someone's laptop. It is free, and it is not code
signing: it answers a different question and does nothing for SmartScreen or
Gatekeeper. Keep it after signing lands — the two cover different attacks.

## Signing on a budget of zero

- **Windows: apply to the [SignPath Foundation](https://signpath.org/).** They
  provide Authenticode signing free to open-source projects, with the private key
  in their HSM, and they vouch for the binary on the strength of *the build coming
  out of a public repository* rather than on a purchased identity certificate.
  That is an application with eligibility criteria, not a checkout — worth
  starting early, because the pipeline it wants is the one we already have (public
  repo, CI-only builds, pinned actions, a smoke-tested artifact).
- **macOS: there is no free path.** Notarization requires the Apple Developer
  Programme (paid, annual), full stop. Until then the release notes tell people
  the exact override (right-click → Open, or `xattr -d com.apple.quarantine`).
  **Measured on the first macOS build: it was not applied.** electron-builder
  reported `skipped macOS application code signing … 0 identities found`, which
  means the arm64 dmg could not have launched at all — Apple Silicon refuses a
  binary with *no* signature, quite apart from Gatekeeper. `mac.identity: "-"` now
  forces ad-hoc signing, and the release job **asserts** it with
  `codesign --verify` rather than trusting the log. Ad-hoc is free and is not
  notarization: it makes the binary loadable, and Gatekeeper still asks for a
  right-click → Open.
- **Do not self-sign.** A self-signed certificate buys nothing with SmartScreen
  or Gatekeeper and dresses an unverified build as a verified one.
- **Do not read "signing with signtool.exe" as signing.** electron-builder prints
  that line on Windows even with no certificate configured, and the artifact comes
  out `NotSigned` — verified with `Get-AuthenticodeSignature`. The release job now
  prints the real status on every run, because a log that implies a signature is
  worse than one that says nothing.
- **Later, cheaper trust than a certificate:** publishing through **winget**,
  **Homebrew casks** or **Flathub** gives users an install path they already trust
  and needs no certificate of ours.

## What is deliberately not here yet

- **Code signing** (Roadmap 5.2) — see above.
- **Installing updates.** The app *checks* and links to the release page; it does
  not install (ADR-028). `electron-updater` verifies the *signature* of what it
  downloads, and an unsigned package gives it nothing to verify, so an updater
  over unsigned artifacts is a remote-code-execution channel with a checksum in
  front of it. One constant, `INSTALL_UPDATES` in `main/updater.ts`, turns it on
  in the same commit that adds signing.
- **Crash reporting** (Roadmap 5.3), opt-in and local-queue-first when it lands.

## The pieces, and where they live

| Piece | Where |
| :--- | :--- |
| CI: unit gates, input-layer gates, packaged build + smoke test | [`.github/workflows/build.yml`](../.github/workflows/build.yml) |
| Version bump (or a `v*` tag) → draft release with checksums + attestations | [`.github/workflows/release.yml`](../.github/workflows/release.yml) |
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
