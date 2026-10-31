import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BriefingPanel } from '../../src/ui/ai/BriefingPanel'

describe('BriefingPanel', () => {
  it('renders nothing without an action or a result', () => {
    const html = renderToStaticMarkup(<BriefingPanel />)
    expect(html).toBe('')
  })

  it('shows the brief action for the current view', () => {
    const html = renderToStaticMarkup(<BriefingPanel onBrief={() => {}} />)
    expect(html).toContain('Brief this view')
  })

  it('renders pack prose with the standing disclosure', () => {
    const html = renderToStaticMarkup(
      <BriefingPanel briefing={{ prose: 'The median gross rent is 1,200.' }} />,
    )
    expect(html).toContain('Briefing pack')
    expect(html).toContain('The median gross rent is 1,200.')
    expect(html).toContain('This is a reading of the shown figures')
  })

  it('never renders withheld prose', () => {
    const html = renderToStaticMarkup(
      <BriefingPanel briefing={{ prose: 'Invented 9999', withheld: true }} />,
    )
    expect(html).toContain('Explanation withheld')
    expect(html).not.toContain('Invented 9999')
  })

  it('shows a route failure in plain words', () => {
    const html = renderToStaticMarkup(
      <BriefingPanel
        briefing={{ error: 'A figure in this view failed source verification, so no pack was generated.' }}
      />,
    )
    expect(html).toContain('failed source verification')
    expect(html).not.toContain('house-disclosure')
  })
})
