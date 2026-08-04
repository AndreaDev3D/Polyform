import { createRequire } from 'node:module'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The product version, baked in at build time. app.getVersion() cannot be
// trusted here: run from source, Electron finds no package.json beside
// out/main and reports its OWN version instead (the welcome screen showed
// "v38.8.6"). package.json is the one source of truth either way.
// The build's appId comes from the same file the installer reads, so the
// running app's Windows shell identity cannot drift from the shortcut's.
const pkg = createRequire(import.meta.url)('./package.json') as {
  version: string
  build: { appId: string }
}
const { version } = pkg
const appId = pkg.build.appId

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __APP_VERSION__: JSON.stringify(version), __APP_ID__: JSON.stringify(appId) },
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          // The stdio↔loopback relay for `polyform mcp serve` (ADR-023).
          // Runs under ELECTRON_RUN_AS_NODE because Electron GUI processes
          // on Windows never deliver piped stdin to the main process.
          relay: 'src/main/relay.ts',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // Vite special-cases .wasm (no default asset handling); the engine core
    // is imported with ?inline as a data: URI (packaged file:// pages cannot
    // fetch assets), which needs .wasm registered as a plain asset type.
    assetsInclude: ['**/*.wasm'],
  },
})
