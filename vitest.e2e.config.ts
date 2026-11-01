import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Browser-driven verification. Runs against a built app so the assertions cover
 * the production bundle, including the Content-Security-Policy that would block
 * a source that a dev server happily serves.
 *
 * Suites that need a Census key skip those checks; keyless browser checks still run.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/e2e/**/*.e2e.ts'],
    globalSetup: ['./src/e2e/validate-preview.ts'],
    testTimeout: 300000,
    hookTimeout: 180000,
    // Serialised deliberately. The placeholder and dogfood suites both seed and
    // sweep the same origin's cache, so running them concurrently has one suite
    // delete the cache out from under the other and each reports the other's
    // state. Sequential runs take longer and produce trustworthy results.
    fileParallelism: false,
    poolOptions: {
      threads: { singleThread: true },
      forks: { singleFork: true },
    },
  },
})
