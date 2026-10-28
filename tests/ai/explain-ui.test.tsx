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
  it('shows the explain action after clarification', () => {
    const html = renderToStaticMarkup(
      <ExplainOnAsk intent={base} onExplain={() => {}} />,
    )
    expect(html).toContain('Explain these figures')
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
      <ExplainOnAsk
        intent={{ ...base, clarificationNeeded: true }}
        onExplain={() => {}}
      />,
    )
    expect(html).toBe('')
  })

  it('renders nothing when there is no action or result', () => {
    expect(renderToStaticMarkup(<ExplainOnAsk intent={base} />)).toBe('')
  })
})
