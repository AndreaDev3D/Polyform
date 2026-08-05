// Generates THIRD-PARTY-NOTICES.md — the attribution that has to travel with
// the binary.
//
// Every dependency Polyform ships is permissive (MIT/ISC/Apache-2.0/BSD), and
// permissive is not the same as free of obligation: MIT and BSD both require
// the copyright notice and licence text to be included "in all copies or
// substantial portions of the Software". An installer is a copy. So this walks
// what actually ships and reproduces each licence in full.
//
// Scope, deliberately over-inclusive rather than under:
//   - every PRODUCTION npm dependency, transitively (`npm ls --omit=dev`).
//     Vite tree-shakes the bundle, so some of these contribute nothing to
//     `out/` — listing a package that turned out unused is harmless, missing
//     one that shipped is not.
//   - every Rust crate in the dependency graph of the WASM engine, which is
//     compiled into `polyform_core_bg.wasm` and committed under
//     src/renderer/src/engine/wasm/pkg.
//
// Not in scope: devDependencies (build-time only, nothing of them is in the
// artifact) and the BiRefNet model, which is not shipped at all — it is
// downloaded on explicit consent and carries its own MIT licence and pinned
// SHA-256 (ADR-019).
//
// Usage:
//   node scripts/licenses.mjs            write THIRD-PARTY-NOTICES.md
//   node scripts/licenses.mjs --check    fail if the committed file is stale
//
// The --check mode is a CI gate: it needs both npm and cargo, because a notices
// file assembled from half the graph is worse than none — it looks complete.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.md')
const CHECK = process.argv.includes('--check')

/** Top-level licence-ish files, in the order a reader would want them. */
const LICENSE_FILE = /^(licen[sc]e|copying|notice)([-_.].*)?$/i

function licenseTexts(dir) {
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return names
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name.replace(/\.(md|txt|markdown)$/i, '')))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim() }))
    .filter((f) => f.text.length > 0)
}

function spdxOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type
  // Ancient packages use the plural array form.
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return null
}

function personName(p) {
  if (!p) return null
  if (typeof p === 'string') return p
  return p.name ?? null
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

/** Filled by npmPackages(): declared optional peers that are not installed. */
let npmNotInstalled = []

function npmPackages() {
  const r = spawnSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 256 * 1024 * 1024,
  })
  if (!r.stdout) throw new Error(`npm ls produced no output (status ${r.status}): ${(r.stderr || '').slice(0, 400)}`)
  const tree = JSON.parse(r.stdout)
  const found = new Map()
  const unresolved = new Set()
  /**
   * Optional peers the tree declares and nothing installed — npm lists them as
   * bare `{}`. They are not on disk, so they are not in the artifact either.
   * Named in the output rather than dropped quietly, so the omission is
   * something a reader can check instead of trust.
   */
  const notInstalled = new Set()
  const walk = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (!dep.version && !dep.path && Object.keys(dep).length === 0) {
        notInstalled.add(name)
        continue
      }
      const version = dep.version ?? '?'
      const key = `${name}@${version}`
      // `npm ls` reports a package once with its path and again as deduped
      // references without one; the first sighting is the real directory.
      if (dep.path && fs.existsSync(path.join(dep.path, 'package.json'))) {
        if (!found.has(key)) found.set(key, { name, version, dir: dep.path })
        unresolved.delete(key)
      } else if (!found.has(key)) {
        const hoisted = path.join(ROOT, 'node_modules', ...name.split('/'))
        if (fs.existsSync(path.join(hoisted, 'package.json'))) found.set(key, { name, version, dir: hoisted })
        else unresolved.add(key)
      }
      walk(dep)
    }
  }
  walk(tree)
  if (unresolved.size > 0) {
    throw new Error(
      `could not locate on disk: ${[...unresolved].join(', ')} — run npm ci and re-run; a notices file with holes is worse than none`,
    )
  }
  npmNotInstalled = [...notInstalled].sort()
  return [...found.values()]
    .map((p) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'))
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
      return {
        ...p,
        spdx: spdxOf(pkg),
        author: personName(pkg.author),
        homepage: pkg.homepage ?? (repo ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : null),
        texts: licenseTexts(p.dir),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

// ---------------------------------------------------------------------------
// Rust / WASM
// ---------------------------------------------------------------------------

/** `cargo` is on PATH in CI and in a login shell, but not in every terminal
 *  rustup's installer touched — so look where rustup puts it before giving up. */
function cargoBin() {
  const home = process.env.CARGO_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.cargo')
  for (const c of ['cargo', path.join(home, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')]) {
    const probe = spawnSync(c, ['--version'], { encoding: 'utf8', shell: true })
    if (probe.status === 0) return c
  }
  return 'cargo'
}

function cargoPackages() {
  const r = spawnSync(cargoBin(), ['metadata', '--format-version', '1'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 256 * 1024 * 1024,
  })
  if (!r.stdout) {
    throw new Error(
      `cargo metadata produced no output (status ${r.status}): ${(r.stderr || '').slice(0, 400)}\n` +
        'The Rust crates are compiled into the shipped WASM engine, so they belong in the notices; ' +
        'install the Rust toolchain or run this on a machine that has it.',
    )
  }
  const meta = JSON.parse(r.stdout)
  return meta.packages
    // source === null means a workspace member: our own code, not a third party.
    .filter((p) => p.source)
    .map((p) => ({
      name: p.name,
      version: p.version,
      spdx: p.license ?? null,
      author: (p.authors ?? []).map((a) => a.replace(/\s*<[^>]*>/, '')).join(', ') || null,
      homepage: p.repository ?? p.homepage ?? null,
      texts: licenseTexts(path.dirname(p.manifest_path)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function section(title, lead, packages) {
  const out = [`## ${title}`, '', lead, '']
  out.push('| Package | Version | Licence |', '| :--- | :--- | :--- |')
  for (const p of packages) {
    out.push(`| ${p.homepage ? `[${p.name}](${p.homepage})` : p.name} | ${p.version} | ${p.spdx ?? '(see text below)'} |`)
  }
  out.push('')
  for (const p of packages) {
    out.push(`### ${p.name} ${p.version}`, '')
    out.push(`Licence: ${p.spdx ?? 'unstated in metadata'}${p.author ? ` · Author: ${p.author}` : ''}`, '')
    if (p.texts.length === 0) {
      // Worth stating rather than hiding: the package published no licence file,
      // so the SPDX identifier above is all its author provided.
      out.push('_The published package contains no licence file; the identifier above is the whole of its declaration._', '')
    }
    for (const t of p.texts) {
      out.push(`<details><summary>${t.name}</summary>`, '', '```text', t.text, '```', '', '</details>', '')
    }
  }
  return out.join('\n')
}

function render(npm, cargo) {
  const counts = (list) => {
    const by = new Map()
    for (const p of list) by.set(p.spdx ?? 'unstated', (by.get(p.spdx ?? 'unstated') ?? 0) + 1)
    return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} (${v})`).join(', ')
  }
  return [
    '# Third-party notices',
    '',
    'Polyform itself is MIT licensed (see [LICENSE](LICENSE)). It is distributed with the',
    'third-party software listed here, each under its own licence, reproduced in full.',
    '',
    '**Generated file — do not edit.** Run `npm run licenses` to regenerate; CI fails if it',
    'is stale. Scope and reasoning are documented at the top of `scripts/licenses.mjs`.',
    '',
    `- npm packages shipped: **${npm.length}** — ${counts(npm)}`,
    `- Rust crates compiled into the WASM engine: **${cargo.length}** — ${counts(cargo)}`,
    '',
    'The background-removal model is **not** included in this list because it is not shipped:',
    'BiRefNet is downloaded once on explicit consent, under its own MIT licence, verified',
    'against a pinned SHA-256 (ADR-019).',
    '',
    '---',
    '',
    section(
      'npm dependencies',
      'Production dependencies, transitively. Build-time (`devDependencies`) packages are excluded — none of them are in the artifact.' +
        (npmNotInstalled.length
          ? `\n\nDeclared as optional peer dependencies and **not installed**, so not shipped and not listed below: ${npmNotInstalled.map((n) => `\`${n}\``).join(', ')}.`
          : ''),
      npm,
    ),
    '---',
    '',
    section(
      'Rust crates',
      'Compiled into `polyform_core_bg.wasm`, which ships inside the app bundle.',
      cargo,
    ),
  ].join('\n')
}

const text = render(npmPackages(), cargoPackages())

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (current.replace(/\r\n/g, '\n') !== text) {
    console.error(
      'THIRD-PARTY-NOTICES.md is stale: a dependency was added, removed or upgraded without regenerating it.\n' +
        'Run `npm run licenses` and commit the result.',
    )
    process.exit(1)
  }
  console.log('THIRD-PARTY-NOTICES.md is up to date.')
} else {
  fs.writeFileSync(OUT, text)
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${(text.length / 1024).toFixed(0)} KB).`)
}
