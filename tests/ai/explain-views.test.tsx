import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ViewFigure } from '../../src/ui/ai/ViewFigure'
import type { FigureInput } from '../../src/ui/ai/FigureCard'

const figure: FigureInput = {
  key: 'median_gross_rent',
  value: 1450,
  marginOfError: 85,
  source: 'ACS 5-year estimates',
  publisher: 'U.S. Census Bureau',
  dataset: 'ACS',
  table: 'B25064',
  vintage: '2023',
  derivation: 'rent = annual rent / 12',
}

describe('ViewFigure capability', () => {
  it('retains MOE, provenance, vintage, and derivation', () => {
    const html = renderToStaticMarkup(<ViewFigure figure={figure} />)
    expect(html).toContain('1,450')
    expect(html).toContain('± 85')
    expect(html).toContain('ACS 5-year estimates')
    expect(html).toContain('U.S. Census Bureau')
    expect(html).toContain('B25064')
    expect(html).toContain('2023')
    expect(html).toContain('How this figure was derived')
    expect(html).toContain('rent = annual rent / 12')
  })

  it('does not add an AI surface when no explanation is supplied', () => {
    const html = renderToStaticMarkup(<ViewFigure figure={figure} />)
    expect(html).not.toContain('This is a reading of the shown figures')
  })

  it('renders explained wording with the standing disclosure', () => {
    const html = renderToStaticMarkup(
      <ViewFigure
        figure={figure}
        explanation={{ prose: 'The median gross rent is 1,450 ± 85.' }}
      />,
    )
    expect(html).toContain('The median gross rent is 1,450')
    expect(html).toContain('This is a reading of the shown figures')
  })

  it('never renders withheld wording', () => {
    const html = renderToStaticMarkup(
      <ViewFigure
        figure={figure}
        explanation={{ prose: 'Invented 9999', withheld: true }}
      />,
    )
    expect(html).toContain('Explanation withheld')
    expect(html).not.toContain('Invented 9999')
  })
})
