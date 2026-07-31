import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/renderer/src/engine/**/*.test.ts', 'src/shared/**/*.test.ts'],
    environment: 'node',
  },
})
