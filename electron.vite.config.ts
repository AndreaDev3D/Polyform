import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
