import { defineConfig } from 'vitest/config'

/**
 * Live API contract checks, kept out of the default run so the normal test
 * suite stays fast and hermetic. Run with `npm run test:live`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/live/**/*.test.ts'],
  },
})
