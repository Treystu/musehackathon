/**
 * The no-weird-characters rule, pinned.
 *
 * The maintainer reported a broken middle dot on the live site on 2026-10-07.
 * The cause was
 * edits that round-tripped source through a shell decoding UTF-8 as Windows-1252,
 * and what let it ship was that no check looked for it: the emoji scanner saw
 * nothing, because mojibake bytes are not emoji.
 *
 * So both directions are asserted here. Detection must fire on every family of
 * double-encoding, and it must not fire on the typographic characters this
 * codebase legitimately uses — the sort glyphs above all, which a scanner broad
 * enough to catch their mojibake would flag in their correct form too.
 */
import { describe, expect, it } from 'vitest'

import { findWeirdInLine, scanForWeird } from '../tools/mojibake-scan.mjs'

const kinds = (line: string) => findWeirdInLine(line).map((f) => f.kind)

describe('mojibake is caught', () => {
  it('catches the sequences the live site actually showed', () => {
    // Each of these is a UTF-8 character decoded as cp1252, with the intended
    // character in the comment beside it.
    expect(kinds('areas \u00C2\u00B7')).toEqual(['mojibake']) // middle dot
    expect(kinds('\u00E2\u20AC\u201D free')).toEqual(['mojibake']) // em dash
    expect(kinds('load\u00E2\u20AC\u00A6')).toEqual(['mojibake']) // ellipsis
    expect(kinds("'\u00E2\u2013\u00B2'")).toEqual(['mojibake']) // up triangle
    expect(kinds("'\u00E2\u2013\u00BC'")).toEqual(['mojibake']) // down triangle
    expect(kinds("'\u00E2\u2020\u2022'")).toEqual(['mojibake']) // up-down arrow
    expect(kinds('\u00C2\u00B1 5')).toEqual(['mojibake']) // plus-minus
    expect(kinds('3 \u00C3\u2014 2')).toEqual(['mojibake']) // multiply
  })

  it('catches every lead character, not only the most common one', () => {
    for (const lead of ['\u00C2', '\u00C3', '\u00C5', '\u00E2']) {
      expect(kinds(`${lead}\u201D`), lead).toEqual(['mojibake'])
    }
  })

  it('catches a byte-order mark, wherever it is', () => {
    expect(kinds('\uFEFFimport { x }')).toEqual(['bom'])
    expect(kinds('const a = 1\uFEFF')).toEqual(['bom'])
  })
})

describe('real characters are not flagged', () => {
  it('leaves the typographic characters this codebase uses', () => {
    for (const line of [
      'areas \u00B7 requests', // middle dot, correct
      'the country \u2014 free.', // em dash, correct
      'load\u2026', // ellipsis, correct
      "'\u25B2' : '\u25BC') : '\u2195'", // the sort glyphs, correct
      '\u00B1 5',
      '3 \u00D7 2',
      '\u00A7 4',
      '\u2265 3 \u2264 4',
      'caf\u00E9', // a legitimate accented letter
      'na\u00EFve',
      '\u201Cquoted\u201D', // real smart quotes
      "it\u2019s", // a real curly apostrophe
      'Urb\u00E0',
    ]) {
      expect(findWeirdInLine(line), line).toEqual([])
    }
  })

  it('does not flag a lone lead character followed by ASCII', () => {
    // A name like "Ângela" contains a lead byte character legitimately; only a
    // lead *immediately followed by a cp1252 special* is mojibake.
    expect(findWeirdInLine('\u00C2ngela')).toEqual([])
  })

  it('is quiet on plain prose', () => {
    expect(findWeirdInLine('Loaded 33,791 areas')).toEqual([])
    expect(findWeirdInLine('')).toEqual([])
  })
})

describe('the tree is clean', () => {
  const { files, findings } = scanForWeird(process.cwd())

  it('scans a plausible number of files, so a broken path cannot pass as clean', () => {
    expect(files).toBeGreaterThan(50)
  })

  it('has no mojibake and no byte-order marks anywhere', () => {
    expect(findings, findings.join('\n')).toHaveLength(0)
  })
})
