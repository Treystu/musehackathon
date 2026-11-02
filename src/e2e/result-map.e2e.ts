/**
 * Does the result map actually draw under a real answer?
 *
 * Hermetic Playwright suite (drive item 13 / plan P6), in the
 * ask-shell pattern: every external service is fixtured at the
 * network boundary — the intent route returns a recorded intent, the
 * Census API answers the sweep's chunk requests with recorded figures
 * for three Seattle ZCTAs, TIGERweb enumeration returns those same
 * ZCTAs, and TIGERweb geometry returns the committed probe fixture
 * (tests/fixtures/result-geometry-seattle.json). A geometry request
 * log pins the metric-switch rule in a real browser: switching the
 * metric re-colors and must not refetch.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

const ZCTAS = ['98101', '98103', '98115']
const RENT: Record<string, string> = { '98101': '2340', '98103': '1895', '98115': '890' }
const HOME: Record<string, string> = { '98101': '820000', '98103': '765000', '98115': '640000' }

const FIXTURE = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'result-geometry-seattle.json'), 'utf8')
const FIXTURE_FEATURES = (JSON.parse(FIXTURE) as { features: { properties: { ZCTA5: string } }[] }).features

const INTENT = {
  mode: 'sweep_filter',
  geographies: ZCTAS,
  metricKeys: ['median_gross_rent', 'median_home_value'],
  filters: [],
  clarificationNeeded: false,
}

let browser: Browser
const geometryRequests: string[] = []
let geometryStatus = 200

/** Answers one ACS chunk request in the API's array-of-arrays shape. */
function acsResponse(url: URL): string {
  const vars = (url.searchParams.get('get') ?? 'NAME').split(',')
  const forClause = decodeURIComponent(url.searchParams.get('for') ?? '')
  const asked = ZCTAS.filter((z) => forClause.includes(z))
  const valueFor = (variable: string, zcta: string): string => {
    if (variable === 'NAME') return `ZCTA5 ${zcta}`
    if (variable === 'B25064_001E') return RENT[zcta]!
    if (variable === 'B25064_001M') return '100'
    if (variable === 'B25077_001E') return HOME[zcta]!
    if (variable === 'B25077_001M') return '20000'
    if (variable === 'B19013_001E') return '90000'
    if (variable === 'B19013_001M') return '3000'
    if (variable.endsWith('M')) return '10'
    return '5000'
  }
  const header = [...vars, 'zip code tabulation area']
  const rows = asked.map((z) => [...vars.map((v) => valueFor(v, z)), z])
  return JSON.stringify([header, ...rows])
}

async function fixturePage(page: Page) {
  await page.route('**/api/muse/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/api/muse/intent')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ intent: INTENT }) })
      return
    }
    // Every other Muse route degrades benignly: the conversational
    // stack records not-run and the deterministic answer still composes.
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
  })
  await page.route('https://api.census.gov/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: acsResponse(new URL(route.request().url())),
    })
  })
  await page.route('https://tigerweb.geo.census.gov/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('returnGeometry') === 'true') {
      geometryRequests.push(route.request().url())
      if (geometryStatus !== 200) {
        await route.fulfill({ status: geometryStatus, contentType: 'text/plain', body: 'upstream failure' })
        return
      }
      const where = url.searchParams.get('where') ?? ''
      const asked: string[] = where.match(/\d{5}/g) ?? []
      const features = FIXTURE_FEATURES.filter((f) => asked.includes(f.properties.ZCTA5))
      await route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features }),
      })
      return
    }
    // Enumeration and every other TIGERweb read: the three fixture ZCTAs.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features: ZCTAS.map((z) => ({ attributes: { ZCTA5: z } })) }),
    })
  })
  await page.route(/https:\/\/(geocoding\.geo\.census\.gov|api\.cdc\.gov|.*arcgis\.com|geodata\.epa\.gov)\/.*/, (route) =>
    route.abort(),
  )
}

beforeAll(async () => {
  browser = await chromium.launch()
}, 120000)

afterAll(async () => {
  await browser?.close()
})

describe('e2e: result map under a verified answer', () => {
  it('draws the answer places, carries figures on the legend, and re-colors without a refetch on metric switch', async () => {
    geometryRequests.length = 0
    geometryStatus = 200
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    try {
      await context.addInitScript((key) => localStorage.setItem('civicscope.censusKey.v1', key), 'result-map-fixture-key')
      const page = await context.newPage()
      await fixturePage(page)
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })

      await page.getByLabel('Ask in plain language').fill('What is the rent in 98101, 98103 and 98115?')
      await page.getByRole('button', { name: 'Ask', exact: true }).click()

      const answerSection = page.locator('section[aria-label="Answer"]')
      await answerSection.locator('svg [data-result-place]').first().waitFor({ timeout: 120000 })
      const places = await answerSection.locator('svg [data-result-place]').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-result-place')),
      )
      expect(places.sort()).toEqual([...ZCTAS].sort())

      const cardText = await answerSection.innerText()
      expect(cardText).toContain('Highest median gross rent')
      expect(cardText).toContain('$2,340/mo')
      expect(cardText).toContain('Lowest median gross rent')
      expect(cardText).toContain('$890/mo')
      expect(geometryRequests.length, 'one batched geometry query for the whole answer').toBe(1)
      expect(geometryRequests[0]).toContain('maxAllowableOffset=0.0009')

      // Metric switch re-colors only: the geometry request log is the pin.
      await answerSection.locator('select').selectOption('median_home_value')
      await answerSection.getByText('Highest median home value').waitFor({ timeout: 30000 })
      expect(geometryRequests.length, 'switching the metric must not refetch geometry').toBe(1)

      // Hover a polygon: that place's card figures appear in the panel.
      // The event is dispatched on the element rather than hovered to
      // its bounding-box centre: a ZCTA polygon is irregular, its
      // bbox centre can fall outside the shape (or under a neighbour),
      // and Playwright's hover then never reaches this element — the
      // component test pins the same handler the same way.
      await answerSection
        .locator('svg [data-result-place="98103"]')
        .evaluate((el) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      const panel = page.locator('[data-testid="result-map-place-panel"]')
      await panel.waitFor({ timeout: 30000 })
      expect(await panel.innerText()).toContain('$765,000')
    } finally {
      await context.close()
    }
  }, 300000)

  it('geometry failure renders the one quiet line and no SVG in the answer', async () => {
    geometryRequests.length = 0
    geometryStatus = 500
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    try {
      await context.addInitScript((key) => localStorage.setItem('civicscope.censusKey.v1', key), 'result-map-fixture-key')
      const page = await context.newPage()
      await fixturePage(page)
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })

      await page.getByLabel('Ask in plain language').fill('What is the rent in 98101, 98103 and 98115?')
      await page.getByRole('button', { name: 'Ask', exact: true }).click()

      const answerSection = page.locator('section[aria-label="Answer"]')
      await page
        .getByText('The map for this answer could not be loaded.')
        .waitFor({ timeout: 180000 })
      expect(await answerSection.locator('svg').count()).toBe(0)
    } finally {
      geometryStatus = 200
      await context.close()
    }
  }, 300000)
})
