import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * C10 pin (item-16 audit, ZIP lookup — state re-entry PRESENT, LOW):
 * a multi-match city submit opened the CityZipBrowser and cleared
 * the search box with setTerm(''), discarding the term the reader
 * had typed. The cure keeps the typed term in the box.
 *
 * The pin is a source pin on the submit handler, in the same style
 * as the C6 grep pin: the App submit path is not hermetically
 * renderable without the full data stack, so the invariant is
 * pinned where it lives — the handler must never clear the term,
 * and the multi-match branch must still open the first match's
 * browser (the kept choice point, audit kept-list #8).
 */
const appSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src/ui/App.tsx'),
  'utf8',
)

describe('C10: the typed ZIP term survives a multi-match submit', () => {
  it('App never clears the search term', () => {
    expect(appSource).not.toContain("setTerm('')")
  })

  it('the submit handler still opens the first match for a non-ZIP term', () => {
    const submitStart = appSource.indexOf('function submit(')
    expect(submitStart).toBeGreaterThan(-1)
    const submitBody = appSource.slice(submitStart, submitStart + 2500)
    expect(submitBody).toContain('setChosenPlace(matches[0]!)')
    expect(submitBody).not.toContain("setTerm('')")
  })
})
