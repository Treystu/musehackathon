#!/usr/bin/env node
/**
 * Live-tier eval runner (credit-budgeted, plan section 6.3 tier 3).
 *
 * Refuses rather than skipping quietly when MUSE_API_KEY is absent: a silent
 * skip here would let the submission claim a live score it never measured. The
 * recorded result is the console line printed by src/live/muse-eval.test.ts;
 * copy it into docs/muse-layer-eval.md with the date and model.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const key = process.env.MUSE_API_KEY
const proxyBase = process.env.MUSE_EVAL_PROXY_BASE
if (!key && !proxyBase) {
  console.error(
    'Neither MUSE_API_KEY nor MUSE_EVAL_PROXY_BASE is set. The live tier cannot run, so it is ' +
      'reported as NOT RUN. MUSE_EVAL_PROXY_BASE measures the deployed /api/muse surface, which ' +
      'is the shipped path and needs no key on this machine. Do not write a live score into any ' +
      'document without this run.',
  )
  process.exit(2)
}
console.log(
  key
    ? 'live tier surface: direct (api.meta.ai with MUSE_API_KEY)'
    : `live tier surface: proxy (${proxyBase}/api/muse/*, deployment's shared key)`,
)

// Same reason as run-golden.mjs: `npx` through spawnSync fails with EINVAL on
// Node 24/Windows, so the live entry point silently exited 1.
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url))
const result = spawnSync(
  process.execPath,
  [vitest, 'run', '--config', 'vitest.live.config.ts', 'src/live/muse-eval.test.ts'],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
