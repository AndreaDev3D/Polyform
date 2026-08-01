// Builds crates/polyform-core to WASM and drops the pkg into the renderer.
// The pkg output is COMMITTED (contributors without a Rust toolchain can
// still run/dev/build the app); regenerate with `npm run build:wasm`.
import { execFileSync } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..'
const crate = path.resolve(root, 'crates/polyform-core')
const outDir = path.resolve(root, 'src/renderer/src/engine/wasm/pkg')

execFileSync(
  'wasm-pack',
  ['build', crate, '--release', '--target', 'web', '--out-dir', outDir, '--out-name', 'polyform_core'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
)

// wasm-pack drops a `.gitignore` with `*` into the pkg — remove it so the
// artifact stays committable.
for (const junk of ['.gitignore', 'README.md']) {
  const p = path.join(outDir, junk)
  if (existsSync(p)) rmSync(p)
}
console.log(`wasm pkg written to ${outDir}`)
