# Releasing

How a Polyform release is cut, what a downloader can verify, and what is
deliberately still missing.

## Two branches

| Branch | Every push produces | State | Who sees it |
| :-- | :-- | :-- | :-- |
| `staging` | `0.8.0-beta.<run>` | **published pre-release** | only people who ticked **betas** in the app |
| `production` | `0.8.0`, when the version has changed | **draft** | nobody, until a human presses Publish |

`package.json` holds the *base* version (`0.8.0`) and the branch decides the rest.
A pre-release suffix in the file is refused, because the run number adds one and
`0.8.0-beta.1-beta.42` is not a version.

**The rule that keeps betas useful: bump the base version right after cutting a
stable release.** Betas sort *below* their base (`0.8.0-beta.7` < `0.8.0`), so if
`staging` still says `0.7.0` after `0.7.0` shipped, every beta it cuts is older
than what people already have and the updater — correctly — ignores it.

### Dev work

Push to `staging`. A beta appears a few minutes later, versioned by the run
number, and anyone with **betas** ticked is told about it the next time they
check. The ten newest betas are kept; older ones are deleted with their tags, so
the release list does not silently become hundreds of entries.

### Cutting a stable release

**Bump the version. That is the release.**

```sh
npm version 0.9.0 --no-git-tag-version   # or edit package.json
npm run licenses                          # regenerate THIRD-PARTY-NOTICES.md if deps changed
# ...move the CHANGELOG's "Unreleased" section under a new heading...
git commit -am '0.9.0 — "Name"'
git push origin staging                   # betas of the new base, if you want them first
# then merge into production, which is what actually cuts it:
git push origin staging:production
```

There is no tag to remember: [`release.yml`](../.github/workflows/release.yml)
runs on every push to `production`, asks whether `package.json`'s version has been
released yet, and stops in ten seconds if it has. When it has not, it releases —
and `gh release create` makes the tag itself from the commit being released.

**After publishing a stable draft by hand, run `npm run test:feed`.** A draft's
assets are not public, so the pipeline cannot check the update feed of a release it
has just drafted; that one command asks GitHub for exactly what an installed app
will ask for and fails if the answer is wrong (F-29).

Pushing a `v*` tag by hand still works, for re-cutting either kind; the tag then
has to match `package.json` — compared against its *base*, so `v0.8.0-beta.3` is a
legal re-cut on a `0.8.0` package — or the run fails rather than shipping
mislabelled files.

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
5. **The update feed is written for both channels** and asserted to name this
   version — see below, and F-29 for why this is a step rather than an assumption.
6. **The release is created**: a draft for `production`, a published pre-release
   for `staging`.
7. **A Sigstore build-provenance attestation** is recorded for each artifact.
8. **For a beta, the feed is fetched back from GitHub** the way an installed app
   fetches it (`npm run test:feed`), and old betas beyond the newest ten are
   deleted with their tags.

For a stable release the draft is the last gate, and it is a human one: open it,
read the notes, download one installer, run it, then press **Publish**. Bumping a
version should be able to produce a release without announcing one.

## Betas and the update feed

The app's **betas** checkbox (welcome screen, beside *Check for updates*) sets
`allowPrerelease`. That single flag decides which GitHub endpoint the updater
resolves, which is why "pre-release" is the right state for a beta and "draft" is
not:

| Opt-in | What electron-updater reads | Result |
| :-- | :-- | :-- |
| off | `releases/latest` — **excludes pre-releases** | betas are unreachable, not merely unoffered |
| on | the newest entry of `releases.atom` | the newest beta, or the stable release if it is newer |

Then it fetches a **metadata file out of that release's assets** — not an API
query — and the name depends on the tag it picked:

| Platform | Stable release | Beta release |
| :-- | :-- | :-- |
| Windows | `latest.yml` | `beta.yml` |
| macOS | `latest-mac.yml` | `beta-mac.yml` |
| Linux | `latest-linux.yml` | `beta-linux.yml` |

Two traps live here, and both have bitten (F-29):

1. **electron-builder writes only `latest*.yml` for the GitHub provider**,
   whatever the version says — the channel is *never* auto-detected there. So the
   release job copies each `latest*.yml` to `beta*.yml`; the file describes the
   artifact, not the channel.
2. **A stable release also needs `beta*.yml`** — for the beta user being offered
   the stable version that supersedes their build, whose client asks for the beta
   name against a stable tag.

`npm run test:feed` checks all of it against the live repo, including the property
the opt-in rests on: `releases/latest` must never resolve to a pre-release.

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

  Two honest caveats before anyone counts on it. **First, maturity is a criterion.**
  The Foundation is lending its own reputation, so it looks for a project with users
  and a history, not a repository that appeared last week — which is what Polyform
  is today. The application is still worth making early, because the answer is
  information either way and the technical requirements are already met; it just
  should not be planned around for the next release.
  **Second, a signature and a quiet SmartScreen are not the same thing.** Signing
  replaces "Unknown publisher" with a name, which is the dialog the user saw. It does
  not by itself stop the "Windows protected your PC" screen: that one is driven by
  *reputation*, which accrues to the signing identity across downloads. The reason
  this matters more than it sounds is that reputation on an **unsigned** file is
  keyed to the file's hash, so every release starts from zero forever. A stable
  signing identity is what lets trust accumulate at all — that, not the wording of
  one dialog, is the argument for signing.

- **The one nearly-free Windows path that skips SmartScreen entirely is the
  Microsoft Store.** Store submissions are signed by Microsoft, and a Store install
  raises no reputation prompt. It is not zero — an individual developer account is a
  small one-time registration fee — and it costs something else: an MSIX package,
  Store review, and the Store's own update mechanism rather than the one built here.
  Worth knowing it exists; not a v0.7 job.
  Package managers (`winget`, Scoop, Chocolatey) are a lesser version of the same
  trick: they change the *path* by which the file arrives, so the double-click dialog
  never happens, while the binary stays exactly as unsigned as it was.
- **Self-signing is worse than not signing.** A certificate no one trusts still shows
  a warning, and the only way to make it trusted is to ask users to install a root
  certificate — which teaches exactly the habit an attacker needs. We do not ship one.
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

  Ad-hoc alone was not enough. Under the hardened runtime, library validation
  refuses to load Electron's own frameworks when the signature is ad-hoc — they
  carry no matching team identifier — and the symptom is an app that never starts,
  with nothing readable to explain why. `resources/entitlements.mac.plist` grants
  `com.apple.security.cs.disable-library-validation` (with the two JIT entitlements
  V8 needs), and the release job asserts the entitlement is **in the signature**,
  not merely in a file it hoped was used. All of it stays valid when a Developer ID
  arrives: the frameworks and the app then share a team, and the entitlement stops
  mattering.

  **Ignore one warning in that job's log.** electron-builder prints
  *"ad-hoc signing with hardenedRuntime enabled requires the
  com.apple.security.cs.disable-library-validation entitlement"* on every macOS
  build, including builds where the entitlement **is** granted — it is a
  configuration heuristic, not a reading of the finished binary. The gate two lines
  later reads the entitlement out of the actual signature with
  `codesign -d --entitlements`, twice, once per architecture. Trust that, not the
  warning; it is the reason the check was written to interrogate the artifact.

  **What CI now proves, and what it does not.** The arm64 app is launched and
  exercised on an Apple Silicon runner — the packaging smoke test creates a bundle,
  takes an agent edit over stdio, reopens it in a fresh process and exports a PNG
  through the packaged binary — so the ad-hoc signature plus that entitlement do
  load and run. What is still unverified is the **Gatekeeper path**: a dmg
  downloaded from a release carries `com.apple.quarantine`, which a locally built
  app does not, so "double-click the download and it opens after a right-click →
  Open" remains a claim nobody here has tested. The x64 app is built but not
  smoke-tested; the runner is arm64 and translating a 250 MB binary under Rosetta
  once hung a whole job.
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
