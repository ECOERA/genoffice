import { defineConfig } from 'vitest/config'

/// Node environment: the suites here cover Tod's pure scheduling, geometry and
/// string tables — the React surface is exercised from the apps' own suites.
export default defineConfig({
  test: {
    name: 'ui',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
