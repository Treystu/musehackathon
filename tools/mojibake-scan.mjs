/**
 * Finds mojibake and byte-order marks in text, so neither can ship.
 *
 * This exists because the maintainer reported a broken middle dot on the live
 * site on 2026-10-07, and the cause was edits that round-tripped source files through a
 * shell that decoded UTF-8 as Windows-1252. Every `·`, `—` and `±` in those files
 * became two or three characters of garbage, and the emoji scanner could not see
 * it: mojibake bytes are not emoji, so a gate that only asks about emoji reported
 * clean while the interface displayed a double-encoded middle dot between every
 * pair of values and the sort headers showed a double-encoded up triangle
 * instead of the real one.
 *
 * The detection is deliberately narrow, because the same trap runs in both
 * directions. A *legitimate* `·` or `—` or `▲` is a single character; mojibake is
 * always a UTF-8 lead byte decoded as cp1252, so it is a character from
 * `Â Ã â Å` immediately followed by a character from the cp1252 special range
 * (`€ ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž ' ' " " • – — ˜ ™ š › œ ž Ÿ`). Correct English
 * prose in this repository never places those two characters together, so nothing
 * real is flagged — asserted by test, in both directions, the same way the emoji
 * scanner pins its own carve-out for the sort glyphs.
 *
 * A byte-order mark is flagged anywhere: U+FEFF is never part of the content of a
 * text file, and one at the top of a source file is a leftover from a Windows
 * editor writing "UTF-8" as "UTF-8 with BOM". Six files carried one after the same
 * round-trips, including the one that aborted a repair script mid-run.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** UTF-8 lead bytes, as they appear when decoded as cp1252. */
const LEAD = /[\u00C2\u00C3\u00C5\u00E2]/

/** Characters only cp1252 produces in the 0x80-0x9F range. */
const SPECIAL =
  /[\u0080-\u00BF\u20AC\u201A\u0192\u201E\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/

const BOM = '\uFEFF'

const SKIP_DIRS = new Set([
  '.git',
  '.wrangler',
  'audit',
  'dist',
  'node_modules',
  'packs',
  '.agents',
  '.claude',
  '.opencode',
])

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.css', '.html', '.md', '.yml', '.txt'])

/**
 * Every mojibake sequence and byte-order mark in one line.
 *
 * Each finding is `{ index, kind, text }` where `index` is a code-unit offset,
 * enough to report a column.
 *
 * @param {string} line
 * @returns {{ index: number, kind: 'mojibake' | 'bom', text: string }[]}
 */
export function findWeirdInLine(line) {
  /** @type {{ index: number, kind: 'mojibake' | 'bom', text: string }[]} */
  const found = []
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === BOM) found.push({ index: i, kind: 'bom', text: 'U+FEFF' })
    if (LEAD.test(line[i]) && SPECIAL.test(line[i + 1])) {
      found.push({ index: i, kind: 'mojibake', text: line.slice(i, i + 3) })
      i += 2
      continue
    }
  }
  // A BOM as the final character of a line is still a BOM.
  if (line.endsWith(BOM)) found.push({ index: line.length - 1, kind: 'bom', text: 'U+FEFF' })
  return found
}

/**
 * @param {string} file
 * @param {number} lineNumber
 * @param {{ index: number, kind: 'mojibake' | 'bom', text: string }} hit
 * @returns {string}
 */
function finding(file, lineNumber, hit) {
  const label = hit.kind === 'mojibake' ? `mojibake ${JSON.stringify(hit.text)}` : 'byte-order mark'
  return `${file}:${lineNumber} ${label}`
}

/** Every finding in one file, or `[]` if it cannot be read as text. */
/** @param {string} path @returns {string[]} */
export function findWeirdInFile(path) {
  /** @type {string} */
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  /** @type {string[]} */
  const out = []
  text.split(/\r?\n/).forEach((line, i) => {
    for (const hit of findWeirdInLine(line)) out.push(finding(path, i + 1, hit))
  })
  return out
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) out.push(full)
  }
  return out
}

/**
 * Every finding under `root`.
 *
 * Unlike the emoji scanner this does **not** exempt `docs/`: mojibake in a
 * planning document is corruption rather than a style choice, and a byte-order
 * mark there breaks tooling exactly the same way.
 */
/** @param {string} root @returns {{ files: number, findings: string[] }} */
export function scanForWeird(root = '.') {
  const files = walk(root)
  /** @type {string[]} */
  const findings = []
  for (const file of files) findings.push(...findWeirdInFile(file))
  return { files: files.length, findings }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, findings } = scanForWeird(process.argv[2] ?? '.')
  for (const f of findings) console.log(f)
  console.log(`\n${findings.length} finding(s) in ${files} scanned file(s)`)
  process.exit(findings.length === 0 ? 0 : 1)
}
