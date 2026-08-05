// SHA-256 sums for release artifacts, in the format `sha256sum -c` reads.
//
// F-10 lists published checksums as an obligation that exists NOW, while
// auto-update does not: without code signing, a checksum is the only way anyone
// can tell a real download from a tampered one. It stays useful after signing —
// a signature says who built it, a checksum says the bytes are unchanged.
//
// Written in Node rather than shell on purpose: `sha256sum`, `shasum -a 256` and
// `certutil -hashfile` differ in availability, output shape and line endings
// across the three runners, and a checksum file that only parses on one platform
// is worse than none.
//
// Usage: node scripts/checksums.mjs [dir=release] [--out SHA256SUMS.txt]

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const outName = outFlag >= 0 ? args[outFlag + 1] : 'SHA256SUMS.txt'
const dir = args.find((a) => !a.startsWith('--') && a !== outName) ?? 'release'

/** What we publish. Not the unpacked directories, not the builder metadata. */
const ARTIFACT = /\.(exe|msi|dmg|zip|AppImage|deb|rpm|snap|blockmap)$/

if (!fs.existsSync(dir)) {
  console.error(`checksums: no ${dir}/ directory — build the artifacts first`)
  process.exit(1)
}

const files = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && ARTIFACT.test(e.name) && e.name !== outName)
  .map((e) => e.name)
  .sort()

if (files.length === 0) {
  console.error(`checksums: no release artifacts in ${dir}/ (looked for ${ARTIFACT})`)
  process.exit(1)
}

const lines = files.map((name) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')
  return `${hash}  ${name}`
})

// Trailing newline, LF only: this file is read by sha256sum, not by an editor.
fs.writeFileSync(path.join(dir, outName), lines.join('\n') + '\n')
console.log(lines.join('\n'))
console.log(`\nWrote ${path.join(dir, outName)} (${files.length} artifact${files.length === 1 ? '' : 's'}).`)
