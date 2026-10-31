// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXPLAIN_VIEW_CLASSES,
  type ExplainViewClass,
} from '../../src/core/ai/explain-view'
import { createStubProvider, type MuseProvider } from '../../src/core/ai/provider'
import { ExplainOnView } from '../../src/ui/ai/ExplainOnView'
import type { FigureInput } from '../../src/ui/ai/FigureCard'

const RENT: FigureInput = {
  key: 'median_gross_rent',
  value: 1450,
  marginOfError: 85,
  source: 'ACS 5-year estimates',
  publisher: 'U.S. Census Bureau',
  dataset: 'ACS',
  table: 'B25064',
  vintage: '2023',
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(viewClass: ExplainViewClass, provider: MuseProvider) {
  act(() => {
    root.render(
      <ExplainOnView viewClass={viewClass} figures={[RENT]} provider={provider} />,
    )
  })
}

async function clickExplain() {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Explain these figures',
  )
  if (!button) throw new Error('explain button not rendered')
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ExplainOnView', () => {
  for (const viewClass of EXPLAIN_VIEW_CLASSES) {
    it(`explains the ${viewClass} view with disclosure after the click`, async () => {
      render(
        viewClass,
        createStubProvider({
          async explain() {
            return { prose: 'The median gross rent is 1,450, plus or minus 85.' }
          },
        }),
      )
      expect(container.textContent).not.toContain('1,450, plus or minus 85')
      await clickExplain()
      expect(container.textContent).toContain(
        'The median gross rent is 1,450, plus or minus 85.',
      )
      expect(container.textContent).toContain(
        'This is a reading of the shown figures',
      )
      // The figures behind the explanation render with provenance.
      expect(container.textContent).toContain('B25064')
    })
  }

  it('never renders withheld wording on a view', async () => {
    render(
      'comparison',
      createStubProvider({
        async explain() {
          return { prose: 'Invented 9999 wording.' }
        },
      }),
    )
    await clickExplain()
    expect(container.textContent).toContain('Explanation withheld')
    expect(container.textContent).not.toContain('Invented 9999')
    expect(container.textContent).toContain('This is a reading of the shown figures')
  })

  it('renders nothing when the view has no figures', () => {
    act(() => {
      root.render(
        <ExplainOnView
          viewClass="sweep"
          figures={[]}
          provider={createStubProvider()}
        />,
      )
    })
    expect(container.textContent).toBe('')
  })
})
