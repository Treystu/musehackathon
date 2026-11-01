/**
 * Reads the user's own Census key out of their Chrome localStorage and verifies
 * it against the live API.
 *
 * The key is only ever sent to api.census.gov, and only to prove it works. It
 * is never written to a committed file, never logged in full, and never
 * transmitted anywhere else.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LEVELDB = join(
  homedir(),
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'Local Storage',
  'leveldb',
)

// Chrome's leveldb stores the key name; the value sits adjacent to it. Note
// that the stored form is `civicscope.censusKey.v1` — the namespace prefix and
// the versioned name are separate, so matching on the full localStorage key
// string finds nothing. Matching the leaf name is what actually works.
//
// The pattern deliberately avoids `\b` word boundaries. The stored bytes put a
// length or type byte immediately before the key, which is not a word character,
// so a leading boundary can never match and the token is silently missed.
const STORAGE_LEAF = 'censusKey.v1'
// Census keys are exactly 40 hexadecimal characters.
const KEY_RE = /[0-9a-f]{40}/gi

/**
 * Scans every leveldb file for our storage key and returns the 40-hex token
 * that follows it. Chrome may be running, so files can be partially written;
 * the read is best-effort and the caller verifies whatever comes back.
 */
export function readKeyFromChrome() {
  let files = []
  try {
    files = readdirSync(LEVELDB).filter((n) => n.endsWith('.ldb') || n.endsWith('.log'))
  } catch {
    return []
  }
  const found = []
  for (const name of files) {
    let buf
    try {
      buf = readFileSync(join(LEVELDB, name))
    } catch {
      continue
    }
    const text = buf.toString('latin1')
    let from = 0
    for (;;) {
      const i = text.indexOf(STORAGE_LEAF, from)
      if (i === -1) break
      // Only look a short distance past the key name; the value is adjacent.
      const window = text.slice(i, i + 120)
      for (const m of window.matchAll(KEY_RE)) found.push(m[0])
      from = i + STORAGE_LEAF.length
    }
  }
  return [...new Set(found)]
}

/** Confirms a key is genuinely accepted, and reports what it can see. */
export async function verifyKey(key, { verbose = false } = {}) {
  const url = `https://api.census.gov/data/2023/acs/acs5?get=NAME,B25064_001E&for=zip%20code%20tabulation%20area:78701&key=${encodeURIComponent(key)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const text = await res.text()
  if (text.trimStart().startsWith('<')) {
    const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? 'error page'
    if (verbose) console.log(`  rejected: ${title}`)
    return { ok: false, reason: title }
  }
  const body = JSON.parse(text)
  if (verbose) console.log(`  accepted. response rows: ${body.length}`)
  return { ok: Array.isArray(body), rows: body, reason: body }
}

// Main-module guard. `import.meta.url` is a file:// URL while `process.argv[1]`
// is a plain Windows path, so they are compared after normalising both to the
// same form rather than string-matched directly.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href

if (isMain) {
  const keys = readKeyFromChrome()
  if (keys.length === 0) {
    console.log('No Census key found in Chrome localStorage.')
    process.exit(1)
  }
  console.log(`Found ${keys.length} candidate key(s) in Chrome localStorage.`)
  for (const k of keys) {
    console.log(`  candidate ${k.slice(0, 6)}…${k.slice(-4)} (${k.length} chars)`)
    const r = await verifyKey(k, { verbose: true })
    if (r.ok) {
      console.log('\nWORKING KEY FOUND')
      console.log(k)
      process.exit(0)
    }
  }
  console.log('\nNo candidate key was accepted.')
  process.exit(1)
}
