import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'doc-proof',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
