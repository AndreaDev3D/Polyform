// Bakes the current release into the website's download buttons.
//
// Writes site/src/release.generated.json, which site/src/main.ts imports and
// Vite inlines at build time. The file is NOT committed: it is derived from
// the GitHub API and would be stale the moment a release is cut. The Pages
// workflow runs this before every build, and re-runs the whole build on
// `release: published`, so the buttons follow releases with no code change.
//
// Two things about this repo's releases that a naive implementation gets
// wrong, both learned from the live API:
//
//   1. GET /releases/latest 404s here. It excludes pre-releases, and every
//      Polyform release so far is one. So we list releases and choose.
//   2. Asset names are not uniform enough to construct. electron-builder's
//      artifactName templates give the Windows builds an arch suffix
//      (Polyform-Setup-0.8.0-beta.25-x64.exe) while the Intel dmg has none
//      (Polyform-0.8.0-beta.25.dmg, vs -arm64.dmg for Apple silicon) and the
//      deb uses Debian's own convention entirely (polyform_0.8.0-beta.25_
//      amd64.deb). Building filenames from a version string produces links
//      that 404 on some platforms and not others. We match what is actually
//      published, by pattern, and skip anything we do not recognise.
//
// Never fails the build: with no network (offline dev, rate limit) it writes
// a fallback that points every button at the releases page. A website that
// builds with slightly duller download links beats a website that does not
// build.
//
// Usage: node scripts/site-release.mjs [--if-missing]
//
//   --if-missing  do nothing when the file already exists. `npm run typecheck`
//                 passes this: TypeScript needs the file to exist, but it has
//                 no business making a network call, and neither does a
//                 typecheck on a plane.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'site', 'src', 'release.generated.json')

const OWNER = 'AndreaDev3D'
const REPO = 'Polyform'
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`

/**
 * How a published asset becomes a download button.
 *
 * Order matters: the first pattern that matches an asset claims it, so the
 * arm64 dmg must be tested before the bare-dmg pattern that would also match
 * it. `arch` is what we tell the reader, not what electron-builder called it.
 */
const KINDS = [
  { os: 'windows', match: /^Polyform-Setup-.*\.exe$/i, label: 'Installer', arch: '64-bit', primary: true },
  { os: 'windows', match: /^Polyform-Portable-.*\.exe$/i, label: 'Portable', arch: '64-bit' },
  { os: 'macos', match: /-arm64\.dmg$/i, label: 'Disk image', arch: 'Apple silicon', primary: true },
  { os: 'macos', match: /\.dmg$/i, label: 'Disk image', arch: 'Intel' },
  { os: 'linux', match: /\.AppImage$/i, label: 'AppImage', arch: '64-bit', primary: true },
  { os: 'linux', match: /\.deb$/i, label: 'Debian package', arch: '64-bit' },
]

/** The electron-updater feed files. Published, but not something to download. */
const FEED = /^(latest|beta)(-mac|-linux)?\.yml$/i

function fallback(reason) {
  console.warn(`site-release: ${reason} — falling back to the releases page`)
  return {
    ok: false,
    version: null,
    tag: null,
    publishedAt: null,
    prerelease: true,
    htmlUrl: RELEASES_URL,
    checksumsUrl: null,
    downloads: { windows: [], macos: [], linux: [] },
  }
}

async function fetchLatest() {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': `${REPO}-site-build` }
  // CI passes a token so the build is not sharing the anonymous 60/hour limit
  // with every other job on the runner's IP.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=30`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return fallback(`GitHub API returned ${res.status}`)

  const all = (await res.json()).filter((r) => !r.draft)
  if (!all.length) return fallback('no published releases')

  // Prefer a stable release when one exists, so the site stops advertising
  // betas the day 1.0 ships without anyone remembering to change this.
  // The API returns newest first, so `find` is already "the newest that is".
  const rel = all.find((r) => !r.prerelease) ?? all[0]

  const downloads = { windows: [], macos: [], linux: [] }
  let checksumsUrl = null

  for (const asset of rel.assets) {
    if (asset.name === 'SHA256SUMS.txt') {
      checksumsUrl = asset.browser_download_url
      continue
    }
    if (FEED.test(asset.name)) continue

    const kind = KINDS.find((k) => k.match.test(asset.name))
    if (!kind) {
      console.warn(`site-release: no button for asset ${asset.name} — skipped`)
      continue
    }
    downloads[kind.os].push({
      name: asset.name,
      label: kind.label,
      arch: kind.arch,
      primary: Boolean(kind.primary),
      url: asset.browser_download_url,
      size: asset.size,
    })
  }

  // The API lists assets alphabetically, which puts "Portable" above the
  // installer most people want. Recommended build first, per platform.
  for (const list of Object.values(downloads)) {
    list.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
  }

  const empty = Object.entries(downloads).filter(([, list]) => !list.length)
  if (empty.length) {
    console.warn(`site-release: ${rel.tag_name} has no assets for ${empty.map(([os]) => os).join(', ')}`)
  }

  return {
    ok: true,
    version: rel.tag_name.replace(/^v/, ''),
    tag: rel.tag_name,
    publishedAt: rel.published_at,
    prerelease: Boolean(rel.prerelease),
    htmlUrl: rel.html_url,
    checksumsUrl,
    downloads,
  }
}

if (process.argv.includes('--if-missing') && fs.existsSync(OUT)) {
  console.log('site-release: release.generated.json already present — left alone')
  process.exit(0)
}

let data
try {
  data = await fetchLatest()
} catch (err) {
  data = fallback(err instanceof Error ? err.message : String(err))
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n')

const count = Object.values(data.downloads).reduce((n, list) => n + list.length, 0)
console.log(`site-release: ${data.tag ?? 'no release'} → ${count} download(s) → site/src/release.generated.json`)
