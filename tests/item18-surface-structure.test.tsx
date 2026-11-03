/**
 * Item 18 approved subset pins (surface-structure evaluation,
 * 2026-11-02, section 4 — Option 2, AI-frame-first):
 *
 *  - S1: Ask is named the product front door in the header navigation
 *    order (first pill, labelled "Ask") and in the GuidedTour's first
 *    step. The landing state does not change — the view id behind the
 *    pill is still 'explore' and the mode still starts at 'ask'.
 *  - S2: the Map tab is the item-17c session-results view only. Its
 *    duplicate search panel and its separate Comparison mount are
 *    off; the national hex overview (MapView) is demoted to the
 *    session-results empty state's one-click "See the whole country"
 *    reveal — passed in as a prop, never standing tab content, and
 *    MapView itself stays in the tree.
 *  - S3: Explore-the-data is demoted in billing only: it keeps its
 *    secondary underline tab and every internal mount (SweepTable,
 *    SimilarityPanel, SavedSearches, the search panel) exactly as
 *    shipped, and it no longer stands in the header as a co-equal
 *    product.
 *
 * Component behaviour that needs a DOM is pinned in
 * tests/ai/session-persistence-ui.test.tsx (the overview link's
 * click); these are the source-level and static-render pins, in the
 * map-and-data-surfaces pattern.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { GuidedTour } from '../src/ui/GuidedTour'
import { SessionMapView } from '../src/ui/map/SessionMapView'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const app = read('src/ui/App.tsx')

/** The App source of one view branch, from its marker to the next branch. */
function branch(marker: string, next: string): string {
  const start = app.indexOf(marker)
  const end = app.indexOf(next, start)
  expect(start, `branch marker ${marker}`).toBeGreaterThan(-1)
  expect(end, `branch end ${next}`).toBeGreaterThan(start)
  return app.slice(start, end)
}

describe('S1/S3: header billing — Ask first, Explore demoted to the underline level', () => {
  it('the header nav order is Ask, Map, Methodology, on the unchanged view ids', () => {
    const nav = app.slice(app.indexOf('<nav aria-label="Primary">'), app.indexOf('</nav>'))
    const askAt = nav.indexOf("['explore', 'Ask']")
    const mapAt = nav.indexOf("['map', 'Map']")
    const methodologyAt = nav.indexOf("['methodology', 'Methodology']")
    expect(askAt).toBeGreaterThan(-1)
    expect(mapAt).toBeGreaterThan(askAt)
    expect(methodologyAt).toBeGreaterThan(mapAt)
    // Explore no longer stands in the header as a co-equal product.
    expect(nav).not.toContain("'Explore']")
    expect(nav).not.toContain('>Explore<')
  })

  it('the landing state is unchanged: explore view, ask mode (no routing or state change)', () => {
    expect(app).toContain("useState<View>('explore')")
    expect(app).toContain("useState<'ask' | 'data'>('ask')")
  })

  it('Explore-the-data keeps only its secondary underline billing, labels unchanged', () => {
    expect(app).toContain("['ask', 'Ask a question']")
    expect(app).toContain("['data', 'Explore the data']")
  })

  it('the GuidedTour names Ask as the front door in its first step', () => {
    const html = renderToStaticMarkup(<GuidedTour open={false} onDismiss={() => {}} />)
    expect(html).toContain('Ask first')
    expect(html).toContain('Ask is the front door')
    // S3 in tour wording: the data surface is named as support, one
    // click away, not as a co-equal product.
    expect(html).toContain('under Explore the data')
  })
})

describe('S2: the Map tab is the session-results view only', () => {
  // The branch runs to the explore branch's mode-switch comment: the
  // overview prop's own ternaries contain the same ") : (" text as
  // the view ternary, so the comment is the reliable boundary.
  const mapBranch = branch("view === 'map'", 'The mode switch (redesign, 2026-11-01)')

  it('mounts SessionMapView and passes the hex overview in as its empty-state reveal', () => {
    expect(mapBranch).toContain('<SessionMapView')
    expect(mapBranch).toContain('overview={')
    expect(mapBranch).toContain('<MapView')
  })

  it('carries no duplicate search panel and no second Comparison mount', () => {
    expect(mapBranch).not.toContain('{searchPanel}')
    expect(mapBranch).not.toContain('<Comparison')
  })

  it('the search panel and Comparison still stand exactly where the frame keeps them', () => {
    // The panel's one remaining mount is Explore-the-data; Comparison
    // keeps its two frame mounts (the sweep section and the Ask-mode
    // result region). S2 removed mounts from the Map tab only — the
    // components and their other mounts are untouched.
    expect(app.match(/\{mode === 'data' && searchPanel\}/g)).toHaveLength(1)
    expect(app.match(/<Comparison/g)).toHaveLength(2)
    const exploreBranch = branch('The mode switch (redesign, 2026-11-01)', '</main>')
    expect(exploreBranch).toContain('<SweepTable')
    expect(exploreBranch).toContain('<SimilarityPanel')
    expect(exploreBranch).toContain('<SavedSearches')
  })

  it('the empty state renders the one-click overview link, and not the overview itself', () => {
    const html = renderToStaticMarkup(
      <SessionMapView
        answer={null}
        questionText={null}
        overview={<p>hex overview placeholder</p>}
      />,
    )
    expect(html).toContain('Ask a question and its map appears here')
    expect(html).toContain('See the whole country')
    // Demoted, not standing: the overview surface is absent until
    // the click (the click itself is pinned in the jsdom suite).
    expect(html).not.toContain('hex overview placeholder')
  })

  it('MapView and its interactions stay in the tree (demoted, not deleted)', () => {
    expect(read('src/ui/MapView.tsx')).toContain('export function MapView')
    expect(read('src/ui/map-interactions.ts')).toContain('useMapCanvasInteractions')
  })
})
