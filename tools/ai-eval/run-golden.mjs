#!/usr/bin/env node
/**
 * Golden-corpus runner (hermetic).
 *
 * The scoring lives in tests/ai/golden-eval.test.ts so there is one
 * implementation; this script is the entry point the plan names, and passes the
 * real exit status through unchanged. A green run proves the corpus is
 * schema-valid, that every supported metric x mode x geography combination has
 * a fixture, and that every invented-numeral Explain fixture is withheld. It
 * does not prove model accuracy: the replay provider returns the recorded
 * expectation. Use run-live.mjs for that.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Run the repo's own vitest entry with the current Node, not `npx` through a
// shell: spawnSync('npx.cmd') fails with EINVAL on Node 24/Windows, which made
// this script exit 1 with no output while the suite underneath was green. A
// runner that lies about a pass is worse than one that fails loudly.
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url))
const result = spawnSync(process.execPath, [vitest, 'run', 'tests/ai/golden-eval.test.ts'], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
