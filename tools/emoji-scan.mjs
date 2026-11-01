/**
 * Finds emoji in text, without flagging the typographic and geometric glyphs
 * this codebase legitimately uses.
 *
 * The distinction matters, because the naive version of this check is wrong in
 * both directions.
 *
 * Too broad — matching `\p{Extended_Pictographic}` alone flags `↕` (U+2195),
 * which is the sort indicator in `src/ui/SweepTable.tsx` and is load-bearing:
 * it is `aria-hidden`, so removing it would leave sighted users with no visual
 * sort state at all, and screen-reader users are served by `aria-sort` on the
 * header cell instead. A gate that flagged it would have demanded the removal of
 * an accessibility affordance.
 *
 * Too narrow — matching ASCII-range symbols would let through U+1F4EC and every
 * other pictograph above the BMP. Iterating UTF-16 code units splits those into
 * surrogate halves, and a lone surrogate matches no property, so a first version
 * of this scanner passed a grinning face. Astral characters have to be walked by
 * code point.
 *
 * So: a pictograph counts as emoji only when it is actually rendered as one.
 * Either it has emoji presentation by default, or U+FE0F asks for it. A bare
 * pictograph codepoint in running text is a text glyph and is left alone.
 *
 * `docs/` is exempt. Planning documents are agent-facing notes, not product
 * surface, and a checkmark in a status line there harms nobody.
 *
 * Used by `tools/completion-gate.mjs` and pinned by `tests/emoji-scan.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PICT = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const VS16 = '\uFE0F'

/** Directories that are never product surface. `docs` is exempt by decision. */
const SKIP_DIRS = new Set([
  '.git',
  '.wrangler',
  'audit',
  'dist',
  'docs',
  'node_modules',
  'packs',
  '.agents',
  '.claude',
  '.opencode',
])

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.css', '.html'])

/**
 * Every emoji in one line, located by code point index.
 *
 * `why` records which of the two rules matched, so a failure message says
 * whether to drop the character or the U+FE0F after it.
 */
export function findEmojiInLine(line) {
  // Array.from walks by code point, not by code unit. This is the fix for
  // astral emoji being invisible to the matcher.
  const points = Array.from(line)
  const found = []
  for (let i = 0; i < points.length; i++) {
    const ch = points[i]
    if (ch === VS16) {
      const prev = points[i - 1]
      // A variation selector is only meaningful after a pictograph; one on its
      // own is still a stray emoji-presentation request, so it counts.
      if (!prev || !PICT.test(prev)) found.push({ index: i, char: ch, why: 'stray variation selector' })
      continue
    }
    if (!PICT.test(ch)) continue
    const byDefault = EMOJI_PRESENTATION.test(ch)
    if (byDefault) {
      found.push({ index: i, char: ch, why: 'emoji presentation' })
    } else if (points[i + 1] === VS16) {
      found.push({ index: i, char: ch, why: 'text glyph forced to emoji by U+FE0F' })
    }
  }
  return found
}

/** One finding, shaped for a gate detail line. */
function finding(file, lineNumber, hit) {
  const cp = hit.char.codePointAt(0)
  const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')
  return `${file}:${lineNumber} ${hex} (${hit.why})`
}

/** Every emoji in one file, or `[]` if the file cannot be read as text. */
export function findEmojiInFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out = []
  text.split(/\r?\n/).forEach((line, i) => {
    for (const hit of findEmojiInLine(line)) out.push(finding(path, i + 1, hit))
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
 * Every emoji under `root`, excluding the exempt directories.
 *
 * @param {string} root absolute or cwd-relative directory to scan
 * @returns {{ files: number, findings: string[] }}
 */
export function scanForEmoji(root = '.') {
  const files = walk(root)
  const findings = []
  for (const file of files) findings.push(...findEmojiInFile(file))
  return { files: files.length, findings }
}

// pathToFileURL rather than string concatenation: `import.meta.url` on Windows
// is `file:///C:/...` with three slashes, so a hand-built `file://${argv[1]}`
// never matches and the CLI silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, findings } = scanForEmoji(process.argv[2] ?? '.')
  for (const f of findings) console.log(f)
  console.log(`\n${findings.length} emoji in ${files} scanned file(s) (docs/ exempt)`)
  process.exit(findings.length === 0 ? 0 : 1)
}
