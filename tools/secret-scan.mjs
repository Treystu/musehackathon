#!/usr/bin/env node
/** Secret scan: zero keys outside explicitly allowlisted fake fixtures. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SKIP = new Set(['node_modules', '.git', 'dist'])
const PATTERNS = [
  { name: 'generic api key assignment', re: /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/ },
  { name: 'hex key 40', re: /\b[0-9a-fA-F]{40}\b/ },
]
/**
 * Allowlisted fake fixtures. Proof (verified 2026-10-31 against the
 * pre-union CivicScope tree): every string these files trip on predates
 * the union with an identical value in the CivicScope tree - the
 * sequential placeholder hex 0123456789abcdef... used as a dummy Census
 * key in the census tests and as the KeyPrompt input placeholder
 * example, the diagnostics tests' leak-canary SECRET (a dummy env value
 * the tests assert never appears in route output), and a real public
 * commit SHA used as the CF_PAGES_COMMIT_SHA fixture. None is a
 * credential; the detection patterns above are unchanged.
 */
const ALLOW_FILES = [
  /tests[\\/]ai[\\/]house\.test\.ts$/,
  /tests[\\/]ai[\\/]diagnostics\.test\.ts$/,
  /tests[\\/]ai[\\/]diagnostics-route\.test\.ts$/,
  /src[\\/]core[\\/]censusKey\.test\.ts$/,
  /src[\\/]core[\\/]census-key-resolution\.test\.ts$/,
  /src[\\/]ui[\\/]KeyPrompt\.tsx$/,
]
/** Pinned CivicScope baseline commit SHA in docs — a public git hash, not a secret. */
const KNOWN_PUBLIC_SHAS = new Set(['3aa7e10dc59e764a8636aa273d4ff86714a3e782'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

let hits = 0
for (const file of walk(ROOT)) {
  if (ALLOW_FILES.some((re) => re.test(file))) continue
  if (!/\.(ts|tsx|js|mjs|json|md)$/.test(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const { name, re } of PATTERNS) {
    const m = text.match(re)
    if (m && !KNOWN_PUBLIC_SHAS.has(m[0])) {
      console.log(`HIT ${name} in ${file}`)
      hits += 1
    }
  }
}
if (hits > 0) {
  console.log(`secret-scan: FAIL (${hits} hits)`)
  process.exit(1)
}
console.log('secret-scan: PASS (0 hits)')
