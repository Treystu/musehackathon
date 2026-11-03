import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ValidatedIntent } from '../../src/core/ai/provider'
import { ExplainBox } from '../../src/ui/ai/ExplainBox'
import { ExplainOnAsk } from '../../src/ui/ai/ExplainOnAsk'

const base: ValidatedIntent = {
  mode: 'lookup',
  geographies: ['Hilo'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

describe('ExplainBox', () => {
  it('renders validated prose with disclosure', () => {
    const html = renderToStaticMarkup(
      <ExplainBox title="Explanation" prose="The median gross rent is 1,200 ± 50." />,
    )
    expect(html).toContain('The median gross rent is 1,200')
    expect(html).toContain('This is a reading of the shown figures')
  })

  it('never renders withheld prose', () => {
    const html = renderToStaticMarkup(
      <ExplainBox title="Explanation" prose="Invented 9999" withheld />,
    )
    expect(html).toContain('Explanation withheld')
    expect(html).not.toContain('Invented 9999')
  })

  it('shows an empty state when no prose exists', () => {
    const html = renderToStaticMarkup(<ExplainBox title="Explanation" prose={null} />)
    expect(html).toContain('No explanation yet.')
  })
})

describe('ExplainOnAsk', () => {
  it('offers no manual explain action — the Ask surface is automatic or nothing', () => {
    // REVISED PIN (item-16 cure C7, 2026-11-02): this test used to
    // pin the manual "Explain these figures" button that appeared
    // when a host wired onExplain. C7 removed that variant so the
    // Ask surface behaves identically regardless of wiring; with no
    // provider, figures, or supplied explanation there is nothing
    // to render and no button to click.
    const html = renderToStaticMarkup(<ExplainOnAsk intent={base} />)
    expect(html).toBe('')
    expect(html).not.toContain('Explain these figures')
  })

  it('renders the explanation result on the Ask surface', () => {
    const html = renderToStaticMarkup(
      <ExplainOnAsk
        intent={base}
        explanation={{ prose: 'The median gross rent is 1,200.' }}
      />,
    )
    expect(html).toContain('The median gross rent is 1,200')
    expect(html).toContain('This is a reading of the shown figures')
  })

  it('withholds the action until clarification is resolved', () => {
    const html = renderToStaticMarkup(
      <ExplainOnAsk intent={{ ...base, clarificationNeeded: true }} />,
    )
    expect(html).toBe('')
  })

  it('renders nothing when there is no action or result', () => {
    expect(renderToStaticMarkup(<ExplainOnAsk intent={base} />)).toBe('')
  })
})
