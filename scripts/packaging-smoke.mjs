// The packaging smoke test F-06 has been promising since v0.1.
//
// Every gate before this one runs the app from source. That leaves a whole class
// of failure untested — the one where the code is right and the PACKAGE is
// wrong: a WASM binary swallowed into app.asar so it cannot be read, a resource
// path that only resolves relative to the repo, an unpacked file that quietly
// stopped being unpacked. Those break on a user's machine and on no developer's.
//
// So this drives the packaged app:
//
//   1. LAYOUT — asar present; sql-wasm.wasm present OUTSIDE it (asarUnpack), it
//      being inside is what F-06 warns about; LICENSE and THIRD-PARTY-NOTICES.md beside
//      the app, because attribution that misses the installer is not shipped.
//   2. THE CLI GATE, against the packaged binary rather than the dev build
//      (POLYFORM_BIN): new -> stdio-MCP edit -> fresh-process query -> export.
//      The packaged app is the same binary as the CLI (ADR-023), so this
//      exercises the real bundle end to end for the price of an env var.
//   3. HISTORY SURVIVES — read the journal the packaged app wrote and find the
//      edit's entry in it. This is the assertion F-06 asks for, and it cannot be
//      obtained by asking the app: `HistoryDb.open` falls back to a fresh
//      database when it cannot read one, so a packaged app with a broken journal
//      answers every question cheerfully. The bytes cannot.
//
// Usage:
//   npx electron-builder --dir        (or a full --win/--mac/--linux build)
//   npm run test:packaging            (or: node scripts/packaging-smoke.mjs --bin <path>)
//
// It tests the packaged app DIRECTORY, not the installer's install step: the
// unpacked tree is what NSIS/dmg/AppImage each copy verbatim, and it is the same
// on all three platforms, so this is the part worth gating on every push.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const RELEASE = path.join(ROOT, 'release')

let failures = 0
const pass = (m) => console.log(`PACKAGING PASS: ${m}`)
const fail = (m) => {
  console.error(`PACKAGING FAIL: ${m}`)
  failures++
}

/** Where electron-builder leaves the packaged tree, per platform. */
function findPackaged() {
  const flag = process.argv.indexOf('--bin')
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1]
  const candidates =
    process.platform === 'win32'
      ? ['win-unpacked/Polyform.exe', 'win-arm64-unpacked/Polyform.exe']
      : process.platform === 'darwin'
        ? ['mac/Polyform.app/Contents/MacOS/Polyform', 'mac-arm64/Polyform.app/Contents/MacOS/Polyform']
        : ['linux-unpacked/polyform', 'linux-arm64-unpacked/polyform']
  for (const c of candidates) {
    const p = path.join(RELEASE, ...c.split('/'))
    if (fs.existsSync(p)) return p
  }
  return null
}

const bin = findPackaged()
if (!bin) {
  console.error(
    'PACKAGING FAIL: no packaged app found under release/.\n' +
      'Build one first: npx electron-vite build && npx electron-builder --dir',
  )
  process.exit(1)
}
console.log(`Packaged app: ${path.relative(ROOT, bin)}`)

// --- 1. layout -------------------------------------------------------------
// resources/ sits beside the executable everywhere except macOS, where the
// executable is two levels down inside the .app.
const appRoot = process.platform === 'darwin' ? path.resolve(path.dirname(bin), '..') : path.dirname(bin)
const resources = path.join(appRoot, 'Resources')
const resourcesDir = fs.existsSync(resources) ? resources : path.join(appRoot, 'resources')

const asar = path.join(resourcesDir, 'app.asar')
if (!fs.existsSync(asar)) fail(`no app.asar in ${path.relative(ROOT, resourcesDir)} — is this a packaged app?`)
else pass(`app.asar present (${(fs.statSync(asar).size / 1024 / 1024).toFixed(1)} MB)`)

// Measured, so this claim stays accurate: removing `asarUnpack` and rebuilding
// leaves the app WORKING on Electron 38 — the loader passes a path through
// emscripten's `locateFile`, and Electron's patched `fs` reads happily inside an
// asar. So this is a config-drift guard for a documented invariant (F-06's rule
// that every runtime-loaded binary goes through one resolver and stays
// unpacked), not a reproduction of a crash. It is worth gating anyway: the rule
// exists because this has failed before, and because "it happens to work on the
// platform I built on" is how it failed.
const wasm = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
if (!fs.existsSync(wasm)) {
  fail(
    `sql-wasm.wasm is not unpacked (looked in ${path.relative(appRoot, wasm)}) — ` +
      'the asarUnpack rule from F-06 is not in effect for it',
  )
} else {
  pass(`sql-wasm.wasm unpacked outside the asar (${(fs.statSync(wasm).size / 1024).toFixed(0)} KB)`)
}

for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  const p = path.join(resourcesDir, file)
  if (!fs.existsSync(p)) fail(`${file} is missing from the package — the licences have to travel with the binary`)
  else pass(`${file} ships with the app (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`)
}

// --- 2. the CLI gate, against the packaged binary --------------------------
console.log('\n--- CLI gate against the packaged binary ---')
const gate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cli-test.mjs')], {
  cwd: ROOT,
  env: { ...process.env, POLYFORM_BIN: bin, POLYFORM_KEEP_BUNDLE: '1' },
  encoding: 'utf-8',
  timeout: 600_000,
})
process.stdout.write(gate.stdout ?? '')
process.stderr.write(gate.stderr ?? '')
if (gate.status !== 0) fail(`the CLI gate failed against the packaged app (exit ${gate.status})`)
else pass('the packaged binary passes the whole CLI gate (new → stdio MCP edit → query → export)')

// --- 3. history survives the round trip ------------------------------------
// The gate leaves its bundle behind when POLYFORM_KEEP_BUNDLE is set; find it
// and read the journal the PACKAGED app wrote.
const kept = (gate.stdout ?? '').match(/^KEPT_BUNDLE=(.+)$/m)?.[1]?.trim()
if (!kept || !fs.existsSync(kept)) {
  fail(`could not find the bundle the gate left behind (KEPT_BUNDLE=${kept ?? 'unset'})`)
} else {
  const dbFile = path.join(kept, 'history.sqlite')
  if (!fs.existsSync(dbFile)) {
    fail('the packaged app wrote no history.sqlite — the journal never reached disk')
  } else {
    // Read the file, do not open it with sql.js. Two reasons, both real:
    //   - loading sql.js in this harness crashes Node 24 on exit ("Assertion
    //     failed: !(handle->flags & UV_HANDLE_CLOSING)" in libuv), whether the
    //     exit is explicit or natural, so every run would end non-zero after
    //     passing. Electron's own Node is a different version and unaffected —
    //     the app and the CLI gate both use sql.js happily.
    //   - `HistoryDb.open` catches an unreadable journal and silently starts a
    //     fresh one (deliberately: a bad journal must not hold the document
    //     hostage), so asking the app whether the history is there would get a
    //     cheerful answer either way. The bytes cannot be cheerful.
    const bytes = fs.readFileSync(dbFile)
    const header = bytes.subarray(0, 16).toString('latin1')
    const text = bytes.toString('latin1')
    if (header !== 'SQLite format 3\0') {
      fail(`history.sqlite is not a SQLite database (header ${JSON.stringify(header)})`)
      // sqlite_master stores the CREATE statement with `IF NOT EXISTS` stripped,
      // so match what SQLite actually writes, not what the schema constant says.
    } else if (!text.includes('CREATE TABLE journal')) {
      fail('history.sqlite has no journal table — the schema never ran')
    } else if (!text.includes('Agent: Gate frame')) {
      fail("the journal has no entry for the edit the gate made ('Agent: Gate frame') — the edit saved without its undo step")
    } else {
      pass(`history survives the reopen: ${(bytes.length / 1024).toFixed(0)} KB SQLite journal containing the edit's entry`)
    }
  }
  try {
    fs.rmSync(path.dirname(kept), { recursive: true, force: true })
  } catch {
    /* a temp dir left behind is not a failure */
  }
}

console.log(failures ? `\nPACKAGING GATE: ${failures} failure(s)` : '\nPACKAGING GATE: all checks passed')
process.exit(failures ? 1 : 0)
