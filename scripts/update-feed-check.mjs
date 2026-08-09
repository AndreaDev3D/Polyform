// Does the published update feed actually answer, and does it answer the way
// electron-updater will ask?
//
// This exists because the release pipeline shipped for a whole version without
// publishing a feed file at all (F-29). Nobody noticed, because every check we had
// looked at the app side — `app-update.yml` is present, points at this repo — and
// no check ever asked GitHub for the file that app would go on to fetch. The two
// halves are built by different tools with different naming rules, so the only
// honest test is the round trip.
//
// It reproduces GitHubProvider.getLatestVersion() rather than trusting it:
//
//   1. `releases.atom` → the newest release's tag. That is the feed the provider
//      reads (not the API, to stay off the rate limit).
//   2. The channel name comes from the TAG: `v0.8.0-beta.7` → `beta`, otherwise
//      `latest`. Then per platform: `beta.yml` (Windows), `beta-mac.yml`,
//      `beta-linux.yml`.
//   3. Fetch each of those from that release's download path and read the version
//      and file names out of them.
//   4. HEAD every file the feed names, because a feed that points at a missing
//      asset fails at download time — later, and less legibly.
//   5. `releases/latest` must NOT be a pre-release. That is the whole opt-in: a
//      client with `allowPrerelease: false` resolves exactly that endpoint, so if a
//      beta ever appeared there, every user would be offered dev builds.
//
// Usage:
//   node scripts/update-feed-check.mjs [--repo owner/name] [--expect-version 0.8.0-beta.7]

import process from 'node:process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}

const REPO = flag('--repo', 'AndreaDev3D/Polyform')
const EXPECT = flag('--expect-version', null)
const BASE = `https://github.com/${REPO}`

let failed = 0
const fail = (msg) => {
  console.error(`FEED FAIL: ${msg}`)
  failed++
}
const pass = (msg) => console.log(`FEED OK: ${msg}`)

async function text(url, what) {
  const res = await fetch(url, { headers: { accept: '*/*' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} for ${url}`)
  return await res.text()
}

// --- 1. the newest release, from the feed the updater reads -----------------
const atom = await text(`${BASE}/releases.atom`, 'releases.atom')
const tags = [...atom.matchAll(/\/releases\/tag\/([^"']+)"/g)].map((m) => m[1])
if (tags.length === 0) {
  fail('no releases in the atom feed — an updater would report ERR_UPDATER_NO_PUBLISHED_VERSIONS')
  // exitCode, not exit(): tearing the loop down with sockets open aborts on Node 24.
  process.exitCode = 1
}
const tag = tags[0] ?? null
if (tag) console.log(`newest release in the feed: ${tag}`)

// --- 2. channel from the tag, exactly as the provider derives it ------------
const prerelease = tag ? (/^v?\d+\.\d+\.\d+-([0-9A-Za-z]+)[.-]/.exec(tag)?.[1] ?? null) : null
const channel = prerelease ?? 'latest'
const version = (tag ?? '').replace(/^v/, '')
if (EXPECT && version !== EXPECT) {
  fail(`newest release is ${version}, expected ${EXPECT} — a later run may have overtaken this one`)
}

// --- 3+4. every platform's feed file, and every file it names ---------------
// Windows has no suffix "due to historical reasons" (Provider.getChannelFilePrefix).
const SUFFIXES = ['', '-mac', '-linux']
for (const suffix of tag ? SUFFIXES : []) {
  const name = `${channel}${suffix}.yml`
  const url = `${BASE}/releases/download/${tag}/${name}`
  let body
  try {
    body = await text(url, name)
  } catch (err) {
    fail(`${name} is missing (${String(err.message)}) — electron-updater raises ERR_UPDATER_CHANNEL_FILE_NOT_FOUND for this`)
    continue
  }
  const declared = /^version:\s*(.+)$/m.exec(body)?.[1]?.trim()
  if (declared !== version) fail(`${name} says version ${declared}, the release is ${version}`)
  const files = [...body.matchAll(/^\s*-\s*url:\s*(.+)$/gm)].map((m) => m[1].trim())
  if (files.length === 0) fail(`${name} names no files`)
  for (const file of files) {
    const assetUrl = `${BASE}/releases/download/${tag}/${encodeURIComponent(file)}`
    const head = await fetch(assetUrl, { method: 'HEAD', redirect: 'follow' })
    if (!head.ok) fail(`${name} points at ${file}, which is not in the release (HTTP ${head.status})`)
  }
  if (declared === version && files.length > 0) pass(`${name} → ${version}, ${files.length} file(s), all present`)
}

// --- 5. the opt-in itself: betas must not reach `releases/latest` -----------
{
  const res = await fetch(`${BASE}/releases/latest`, { redirect: 'follow' })
  const stableTag = /\/releases\/tag\/([^"'/]+)/.exec(res.url)?.[1] ?? null
  if (!stableTag) {
    console.log('NOTE: no stable release yet, so nothing to check about releases/latest')
  } else if (/-\w+\.\d+$/.test(stableTag)) {
    fail(`releases/latest resolves to ${stableTag}, a pre-release — every user would be offered betas`)
  } else {
    pass(`releases/latest is ${stableTag} (stable), so betas reach only clients that opt in`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} feed problem(s).`)
  process.exitCode = 1
} else {
  console.log('\nThe published feed answers every request electron-updater will make.')
}
