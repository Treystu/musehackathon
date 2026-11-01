/**
 * The no-emoji rule, pinned.
 *
 * These assertions exist because the obvious implementation of this check is
 * wrong in a way that is invisible until it is deployed. A scanner matching
 * `\p{Extended_Pictographic}` flags `↕` (U+2195) — the sort indicator in
 * `src/ui/SweepTable.tsx`, which is `aria-hidden` and backed by `aria-sort`, so
 * deleting it to satisfy the gate would remove a real affordance. A scanner
 * walking UTF-16 code units misses every emoji above the BMP, because a
 * surrogate half matches no Unicode property.
 *
 * Both were observed while writing `tools/emoji-scan.mjs`, so both are asserted.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findEmojiInLine, scanForEmoji } from '../tools/emoji-scan.mjs'

const has = (line: string) => findEmojiInLine(line).length > 0

describe('emoji scan: emoji is caught', () => {
  it('catches emoji-presentation characters', () => {
    expect(has('Loaded \u2705')).toBe(true) // white heavy check mark
    expect(has('Great \u{1F600}')).toBe(true) // grinning face
    expect(has('\u{1F680} launch')).toBe(true) // rocket
    expect(has('\u{1F525} hot')).toBe(true) // fire
    expect(has('Status \u{1F534}')).toBe(true) // red circle
    expect(has('\u2728 magic')).toBe(true) // sparkles
  })

  it('catches a text glyph forced to emoji by U+FE0F', () => {
    // The interesting case. These render as ordinary text on their own and only
    // become emoji because something appended the variation selector, so a
    // scanner that ignores VS16 misses exactly the subtle offence.
    expect(has('Done \u2714\uFE0F')).toBe(true) // check mark + VS16
    expect(has('Sort \u2195\uFE0F')).toBe(true) // up-down arrow + VS16
    expect(has('\u26A0\uFE0F careful')).toBe(true) // warning sign + VS16
  })

  it('catches a stray variation selector with no pictograph before it', () => {
    expect(has('trailing \uFE0F')).toBe(true)
  })
})

describe('emoji scan: text glyphs are not emoji', () => {
  it('leaves the sort indicators alone', () => {
    // Regression guard. These three are the sort glyphs in SweepTable.tsx; they
    // are aria-hidden and paired with aria-sort on the header cell, and they are
    // the only visual indication of sort state for a sighted reader.
    expect(has("'\u25B2'")).toBe(false) // up triangle
    expect(has("'\u25BC'")).toBe(false) // down triangle
    expect(has("'\u2195'")).toBe(false) // up-down arrow
  })

  it('leaves ordinary arrows alone', () => {
    expect(has('\u2190 what was originally requested')).toBe(false)
    expect(has('a \u2192 b')).toBe(false)
  })

  it('leaves the mathematical and typographic glyphs this codebase uses alone', () => {
    for (const line of [
      '\u00B1 5',
      '\u2265 3 \u2264 4',
      '3 \u00D7 2',
      'an em dash \u2014 here',
      '\u00A7 4',
      '\u00B5g',
      '\u00B2 \u00B3 \u00BD',
      '\u2260 not equal',
    ]) {
      expect(has(line), line).toBe(false)
    }
  })

  it('leaves plain prose alone', () => {
    expect(has('Loaded 33,791 areas')).toBe(false)
    expect(has('')).toBe(false)
  })
})

describe('emoji scan: the shipped tree is clean', () => {
  const { files, findings } = scanForEmoji(join(process.cwd()))

  it('scans a plausible number of files, so a broken path cannot pass as clean', () => {
    // Without this, a scanner pointed at a missing directory returns zero
    // findings and the gate reports a clean run it never performed — the exact
    // "reports a pass it did not earn" failure this repository keeps guarding
    // against elsewhere.
    expect(files).toBeGreaterThan(50)
  })

  it('has no emoji outside docs/', () => {
    expect(findings, findings.join('\n')).toHaveLength(0)
  })
})

describe('emoji scan: docs are exempt', () => {
  it('does not flag emoji that exist in the planning documents', () => {
    // The exemption is a decision, so it is asserted rather than assumed. If a
    // future change removes the exemption this test fails instead of the gate
    // quietly flagging 200-odd lines of planning prose.
    const docs = join(process.cwd(), 'docs')
    const exempt = scanForEmoji(docs)
    // docs/ is skipped by the scanner, so scanning it directly finds nothing...
    expect(exempt.findings).toHaveLength(0)
    // ...even though the files it skips really do contain emoji.
    const target = join(docs, 'EXECUTION_READY.md')
    if (existsSync(target)) {
      expect(findEmojiInLine(readFileSync(target, 'utf8')).length).toBeGreaterThan(0)
    }
  })
})
