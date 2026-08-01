import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
