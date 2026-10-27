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
const ALLOW_FILE = /tests[\\/]ai[\\/]house\.test\.ts$/

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
  if (ALLOW_FILE.test(file)) continue
  if (!/\.(ts|tsx|js|mjs|json|md)$/.test(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) {
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
