/**
 * End-to-end verification in a real browser, using the user's own Census key.
 *
 * The Census API answers HTTP 200 with an HTML error page for every failure
 * mode, so nothing about the sweep can be verified from a plain fetch without a
 * real key. This runs the actual app in Chromium, injects a key into
 * localStorage exactly as the app's own code does, and asserts on what the user
 * would see.
 *
 * The key is never written to this file. Supply it with:
 *   CENSUS_KEY=<40 chars> npm run test:e2e
 *
 * Without that variable the suite skips rather than failing, so it is safe to
 * run in CI where no key exists.
 */

import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const KEY = process.env.CENSUS_KEY
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

// Two ZIP codes chosen to be unambiguously different in every metric we assert.
const ZIPS = ['78701', '60601']

let browser: Browser
let page: Page

async function searchFor(zip: string) {
  await page.fill('#place', zip)
  await page.locator('form').filter({ has: page.locator('#place') }).locator('button[type="submit"]').click()
}

beforeAll(async () => {
  browser = await chromium.launch()
  const context = await browser.newContext()
  page = await context.newPage()

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  ;(page as Page & { __errors?: string[] }).__errors = errors

  // Count real network traffic to the Census API, which is what the
  // "sorting is local" assertion actually depends on.
  page.on('request', (r) => {
    if (r.url().includes('api.census.gov')) censusRequests++
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  if (KEY) {
    // Inject the key the same way the app's own setter does, so the test
    // exercises the real storage path.
    await page.evaluate((k) => localStorage.setItem('civicscope.censusKey.v1', k), KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
  }
}, 120000)

afterAll(async () => {
  await browser?.close()
})

describe('e2e: application loads', () => {
  it('renders the shell and the search control', async () => {
    expect(await page.locator('h1').innerText()).toMatch(/CivicScope/i)
    expect(await page.locator('#place').count()).toBe(1)
    expect(await page.locator('button:has-text("Methodology")').count()).toBe(1)
  }, 60000)
})

describe('e2e: keyless ZIP guidance', () => {
  it('keeps a second ZIP’s school outcome when the first same-state lookup is removed', async () => {
    const context = await browser.newContext()
    try {
      const keylessPage = await context.newPage()
      const places = {
        '35950': { lat: '34.26', lon: '-86.2', school: 'Albertville High School', ncessch: '010000500871', rateId: '10000500871', rate: 92 },
        '35203': { lat: '33.5', lon: '-86.8', school: 'Birmingham High School', ncessch: '010000500872', rateId: '10000500872', rate: 88 },
      }
      let geocodeRequests = 0
      let outcomeRequests = 0
      let releaseOutcomes!: () => void
      let startFirstOutcome!: () => void
      let startSecondOutcome!: () => void
      const outcomeGate = new Promise<void>((resolve) => { releaseOutcomes = resolve })
      const firstOutcomeStarted = new Promise<void>((resolve) => { startFirstOutcome = resolve })
      const secondOutcomeStarted = new Promise<void>((resolve) => { startSecondOutcome = resolve })
      const unexpectedRemoteRequests: string[] = []
      await context.route('**/*', async (route) => {
        const requestUrl = new URL(route.request().url())
        if (requestUrl.origin === new URL(BASE).origin) {
          await route.continue()
          return
        }

        if (requestUrl.hostname === 'tigerweb.geo.census.gov') {
          const isGeocode = requestUrl.pathname.endsWith('/MapServer/2/query')
          const zip = requestUrl.searchParams.get('where')?.match(/ZCTA5='(\d{5})'/)?.[1]
          const place = zip ? places[zip as keyof typeof places] : undefined
          if (isGeocode && place) geocodeRequests += 1
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              features: isGeocode && place
                ? [{ attributes: { ZCTA5: zip, NAME: `ZCTA5 ${zip}`, CENTLAT: place.lat, CENTLON: place.lon } }]
                : [],
            }),
          })
          return
        }

        if (requestUrl.hostname === 'nces.ed.gov') {
          const isSchoolLocations = requestUrl.pathname.endsWith(
            '/EDGE_GEOCODE_PUBLICSCH_1920/MapServer/0/query',
          )
          const bounds = requestUrl.searchParams.get('geometry')?.split(',').map(Number)
          const centerLon = bounds?.length === 4 ? (bounds[0]! + bounds[2]!) / 2 : Number.NaN
          const place = Object.values(places).find((candidate) => Math.abs(centerLon - Number(candidate.lon)) < 0.1)
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              features: isSchoolLocations && place
                ? [{ attributes: {
                  NCESSCH: place.ncessch,
                  NAME: place.school,
                  OPSTFIPS: '01',
                  LAT: String(Number(place.lat) + 0.0001),
                  LON: String(Number(place.lon) + 0.0001),
                  SCHOOLYEAR: '2019-2020',
                } }]
                : [],
            }),
          })
          return
        }

        if (requestUrl.hostname === 'educationdata.urban.org') {
          outcomeRequests += 1
          if (outcomeRequests === 1) startFirstOutcome()
          else startSecondOutcome()
          await outcomeGate
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              results: Object.values(places).map((place) => ({
                ncessch: place.rateId,
                fips: 1,
                year: 2019,
                cohort_num: 84,
                grad_rate_low: 86,
                grad_rate_high: 94,
                grad_rate_midpt: place.rate,
              })),
              next: null,
            }),
          })
          return
        }

        if (requestUrl.hostname === 'data.cdc.gov' || requestUrl.hostname === 'data.cityofnewyork.us') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
          return
        }

        if (requestUrl.hostname === 'geodata.epa.gov') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ features: [] }),
          })
          return
        }

        unexpectedRemoteRequests.push(requestUrl.toString())
        await route.abort()
      })
      await keylessPage.goto(BASE, { waitUntil: 'domcontentloaded' })
      await keylessPage.getByRole('button', { name: 'Not now' }).click()

      const guidance = keylessPage.getByRole('heading', { name: 'What you can do without a key', exact: true })
      const funding = keylessPage.getByRole('heading', { name: 'This tool is free, and stays free', exact: true })
      const guidanceText = guidance.locator('xpath=..')
      expect(await guidance.count()).toBe(1)
      expect(await funding.count()).toBe(1)
      expect(await guidanceText.innerText()).toContain('ZIP lookup')
      expect(await guidanceText.innerText()).not.toContain('Add a ZIP code above')

      await keylessPage.fill('#place', '35950')
      await keylessPage.locator('form').filter({ has: keylessPage.locator('#place') }).locator('button[type="submit"]').click()
      await keylessPage.getByRole('heading', { name: 'Comparing 1 area', exact: true }).waitFor({ timeout: 60000 })
      await Promise.race([
        firstOutcomeStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('First school outcome request did not start')), 15000)),
      ])

      await keylessPage.fill('#place', '35203')
      await keylessPage.locator('form').filter({ has: keylessPage.locator('#place') }).locator('button[type="submit"]').click()
      await keylessPage.getByRole('heading', { name: 'Comparing 2 areas', exact: true }).waitFor({ timeout: 60000 })
      await Promise.race([
        secondOutcomeStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Second school outcome request was incorrectly shared')), 15000)),
      ])

      const removedArticle = keylessPage.locator('main article').filter({ hasText: '35950' })
      await removedArticle.getByRole('button', { name: 'Remove' }).click()
      await keylessPage.getByRole('heading', { name: 'Comparing 1 area', exact: true }).waitFor({ timeout: 60000 })
      releaseOutcomes()

      const article = keylessPage.locator('main article').filter({ hasText: '35203' })
      await keylessPage.waitForFunction(() => {
        const card = [...document.querySelectorAll('main article')].find((entry) => entry.textContent?.includes('35203'))
        return Boolean(card) && card!.textContent!.includes('Birmingham High School') && !card!.textContent!.includes('Fetching detail')
      }, undefined, { timeout: 60000 })
      const outcome = article.getByRole('heading', {
        name: 'Birmingham High School — graduation rate midpoint (2019 ACGR)',
        exact: true,
      })
      await outcome.waitFor()
      const outcomeCard = outcome.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
      expect(await outcomeCard.locator('p').first().innerText()).toBe('88%')
      await outcomeCard.getByRole('button', { name: 'Where this number comes from' }).click()
      expect(await outcomeCard.innerText()).toContain('86–94% band')
      expect(await article.getByRole('status').count()).toBe(0)
      expect(await keylessPage.locator('main article').count()).toBe(1)
      expect(geocodeRequests).toBe(2)
      expect(outcomeRequests).toBe(2)
      expect(await keylessPage.evaluate(() => localStorage.getItem('civicscope.censusKey.v1'))).toBeNull()
      expect(unexpectedRemoteRequests).toEqual([])
      expect(await guidance.count()).toBe(1)
      expect(await funding.count()).toBe(1)
      expect(await guidanceText.innerText()).toContain('ZIP lookup')
      expect(await guidanceText.innerText()).not.toContain('Add a ZIP code above')
    } finally {
      await context.close()
    }
  }, 120000)
})

describe('e2e: deterministic screening and explain surfaces', () => {
  it('keeps ZIP order, renders Explain on the loaded views, and sends AI requests only to the same-origin proxy', async () => {
    const context = await browser.newContext()
    const fixtureRows = [
      { zcta: '10003', rent: '2400' },
      { zcta: '10001', rent: '1800' },
      { zcta: '10002', rent: '1200' },
    ]

    try {
      await context.addInitScript(() => {
        localStorage.setItem('civicscope.censusKey.v1', 'sort-fixture-key')
        localStorage.setItem('civicscope.similarity.v1.cutoff', '1')
      })
      const sortPage = await context.newPage()
      const appOrigin = new URL(BASE).origin
      // The AI path is a fixture at the network boundary, same as every other
      // source here. The prose carries no numerals so the validator's job is
      // not what this test is measuring; meta-client.test.ts owns that.
      const askIntent = {
        mode: 'lookup',
        geographies: ['10002'],
        metricKeys: ['median_gross_rent'],
        filters: [],
        clarificationNeeded: false,
      }
      const askProse = 'The figures shown are estimates from the Census Bureau, and the margins of error are not reported for these areas.'
      await sortPage.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === appOrigin && url.pathname.startsWith('/api/muse/')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              url.pathname.endsWith('/intent')
                ? { intent: askIntent }
                : { prose: askProse },
            ),
          })
          return
        }
        if (url.origin === appOrigin) {
          await route.continue()
          return
        }

        if (url.hostname === 'tigerweb.geo.census.gov' && url.pathname.endsWith('/MapServer/2/query')) {
          const range = url.searchParams.get('where')?.match(/'(\d{5})'.*'(\d{5})'/)
          const features = fixtureRows
            .filter(({ zcta }) => !range || (zcta >= range[1]! && zcta <= range[2]!))
            .map(({ zcta }) => ({ attributes: { ZCTA5: zcta } }))
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ features }),
          })
          return
        }

        if (url.hostname === 'api.census.gov') {
          const variables = (url.searchParams.get('get') ?? 'NAME').split(',')
          const requested = new Set(url.searchParams.get('for')?.split(':')[1]?.split(',') ?? [])
          const rows = fixtureRows
            .filter(({ zcta }) => requested.has(zcta))
            .map(({ zcta, rent }) => [
              ...variables.map((variable) =>
                variable === 'NAME' ? `ZCTA5 ${zcta}` : variable === 'B25064_001E' ? rent : '1',
              ),
              zcta,
            ])
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([[...variables, 'zip code tabulation area'], ...rows]),
          })
          return
        }

        await route.abort()
      })

      await sortPage.goto(BASE, { waitUntil: 'domcontentloaded' })
      const tourDismiss = sortPage.getByRole('button', { name: 'Not now', exact: true })
      if (await tourDismiss.count()) await tourDismiss.click()

      const table = sortPage.getByRole('table', { name: /US ZIP code tabulation areas/ })
      await table.waitFor({ state: 'visible', timeout: 60000 })
      await sortPage.waitForFunction(
        () => document.querySelectorAll('table tbody th[scope="row"] span.font-mono').length === 3,
      )

      const readZipOrder = () => table.locator('tbody th[scope="row"] span.font-mono').allInnerTexts()
      expect(await readZipOrder()).toEqual(['10001', '10002', '10003'])
      expect(await table.getByRole('columnheader', { name: 'ZIP & location' }).getAttribute('aria-sort')).toBe('ascending')

      const sortPresets = sortPage.locator('fieldset').first()
      await sortPresets.getByText('Median rent', { exact: true }).click()
      expect(await sortPresets.getByRole('radio', { name: 'Median rent' }).isChecked()).toBe(true)

      expect(await table.getByRole('button', { name: "Explain this row's figures" }).count()).toBe(3)
      const actionRowHeight = await table.locator('tbody tr').first().evaluate((row) => row.getBoundingClientRect().height)
      expect(actionRowHeight).toBe(53)
      expect(await readZipOrder()).toEqual(['10002', '10001', '10003'])

      const rentHeader = table.getByRole('columnheader', { name: 'Median rent' })
      expect(await rentHeader.getAttribute('aria-sort')).toBe('ascending')
      await rentHeader.getByRole('button', { name: 'Median rent' }).click()
      expect(await rentHeader.getAttribute('aria-sort')).toBe('descending')
      expect(await readZipOrder()).toEqual(['10003', '10001', '10002'])
      expect(await sortPresets.getByRole('radio', { name: 'Median rent' }).isChecked()).toBe(true)

      await sortPage.getByText('Find similar ZIP codes (off by default)', { exact: true }).click()
      await sortPage.getByRole('button', { name: 'Turn on similar-ZIP search' }).click()
      await sortPage.locator('#similarity-origin').fill('10002')

      const similarity = sortPage.locator('details').filter({ has: sortPage.locator('#similarity-origin') })
      const matches = similarity.locator('ul > li')
      await sortPage.waitForFunction(() => {
        const panel = document.querySelector('#similarity-origin')?.closest('details')
        return panel?.querySelectorAll('ul > li').length === 2
      })
      const resultRows = await matches.all()
      expect(resultRows).toHaveLength(2)
      for (const [index, row] of resultRows.entries()) {
        const labels = row.locator('.min-w-0 > span')
        expect(await labels.count()).toBe(2)
        expect(await labels.nth(0).innerText()).toBe(['10001', '10003'][index])
        expect(await labels.nth(1).innerText()).toBe(['distance 0.25', 'distance 0.50'][index])
        expect(await row.getByRole('button', { name: 'Compare' }).count()).toBe(1)
        expect(await row.getByRole('button', { name: /^Explain \d{5}$/ }).count()).toBe(1)
      }

      await resultRows[0]!.getByRole('button', { name: /^Explain \d{5}$/ }).click()
      await similarity.getByRole('button', { name: 'Explain this similarity result' }).waitFor()

      // A row action and the shared comparison action both consume the same
      // locally loaded figures; the default provider remains a safe empty stub.
      await table.locator('tbody tr').filter({ hasText: '10002' }).getByRole('button', { name: 'Compare' }).click()
      const detail = sortPage.locator('main article').filter({ hasText: '10002' }).first()
      await detail.getByRole('button', { name: "Explain this area's figures" }).waitFor()

      await sortPage.getByRole('button', { name: 'Explore', exact: true }).click()
      await sortPage.getByRole('textbox', { name: 'Ask in plain language' }).fill('rent in 10002')
      await sortPage.getByRole('button', { name: 'Ask', exact: true }).click()
      await sortPage.getByText('lookup', { exact: true }).waitFor()
      expect(await sortPage.getByRole('button', { name: 'Remove place 10002' }).count()).toBe(1)
      expect(await sortPage.getByRole('button', { name: 'Remove measure median_gross_rent' }).count()).toBe(1)
      const askExplain = sortPage.getByRole('button', { name: 'Explain these figures' })
      await askExplain.waitFor()
      await askExplain.click()
      await sortPage.getByText(askProse, { exact: true }).waitFor()

      await sortPage.getByLabel('Name for this comparison').fill('Fixture shortlist')
      await sortPage.getByRole('button', { name: 'Save', exact: true }).click()
      await sortPage.getByRole('button', { name: 'Explain this saved comparison' }).waitFor()

      await table.locator('tbody tr').filter({ hasText: '10001' }).getByRole('button', { name: 'Compare' }).click()
      await sortPage.getByRole('button', { name: 'Explain the shared figures' }).waitFor()

      // The live client is proxy-first: every AI call is same-origin, and no
      // visitor key (there is none stored here) could reach another origin.
      const providerRequests = await sortPage.evaluate(() => performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('/api/muse/')))
      expect(providerRequests.length).toBeGreaterThan(0)
      for (const request of providerRequests) {
        expect(new URL(request).origin, request).toBe(appOrigin)
      }
      expect(providerRequests.some((name) => name.includes('api.meta.ai'))).toBe(false)
    } finally {
      await context.close()
    }
  }, 120000)
})

describe('e2e: comparison during a partial sweep', () => {
  it('renders one comparison while the next chunk is pending', async () => {
    const context = await browser.newContext()
    const fixtureZctas = Array.from({ length: 801 }, (_, index) => String(10001 + index).padStart(5, '0'))
    let sweepRequests = 0
    let resolveSecondChunkStarted!: () => void
    const secondChunkStarted = new Promise<void>((resolve) => {
      resolveSecondChunkStarted = resolve
    })
    let releaseSecondChunk!: () => void
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve
    })

    try {
      await context.addInitScript(() => localStorage.setItem('civicscope.censusKey.v1', 'partial-sweep-fixture-key'))
      const partialPage = await context.newPage()
      const appOrigin = new URL(BASE).origin
      await partialPage.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === appOrigin) {
          await route.continue()
          return
        }

        if (url.hostname === 'tigerweb.geo.census.gov' && url.pathname.endsWith('/MapServer/2/query')) {
          const where = url.searchParams.get('where') ?? ''
          const exactZip = where.match(/ZCTA5='(\d{5})'/)?.[1]
          if (exactZip) {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                features: [
                  {
                    attributes: {
                      ZCTA5: exactZip,
                      NAME: `ZCTA5 ${exactZip}`,
                      CENTLAT: '40.7506',
                      CENTLON: '-73.9972',
                    },
                  },
                ],
              }),
            })
            return
          }

          const range = where.match(/'([\d]{5})'.*'([\d]{5})'/)
          const features = fixtureZctas
            .filter((zcta) => !range || (zcta >= range[1]! && zcta <= range[2]!))
            .map((zcta) => ({ attributes: { ZCTA5: zcta } }))
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ features }),
          })
          return
        }

        if (url.hostname === 'api.census.gov') {
          sweepRequests += 1
          if (sweepRequests === 2) {
            resolveSecondChunkStarted()
            await secondChunkGate
          }

          const variables = (url.searchParams.get('get') ?? 'NAME').split(',')
          const requested = url.searchParams.get('for')?.split(':')[1]?.split(',') ?? []
          const rows = requested
            .filter((zcta) => /^\d{5}$/.test(zcta))
            .map((zcta) => [...variables.map((variable) => (variable === 'NAME' ? `ZCTA5 ${zcta}` : '1')), zcta])
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([[...variables, 'zip code tabulation area'], ...rows]),
          })
          return
        }

        await route.abort()
      })

      await partialPage.goto(BASE, { waitUntil: 'domcontentloaded' })
      await secondChunkStarted
      await partialPage.getByRole('heading', { name: 'Screen every ZIP code', exact: true }).waitFor()
      await partialPage.getByText('801 areas loaded', { exact: false }).waitFor()
      await partialPage.getByText(/1 of 2 areas.*801 ZIP codes ready/).waitFor()

      const table = partialPage.getByRole('table', { name: /US ZIP code tabulation areas/ })
      const firstZipRow = table.locator('tbody tr').first()
      expect(await firstZipRow.locator('th[scope="row"] span.font-mono').innerText()).toBe('10001')
      await firstZipRow.getByRole('button', { name: 'Compare', exact: true }).click()

      const comparisonHeading = partialPage.getByRole('heading', { name: 'Comparing 1 area', exact: true })
      await comparisonHeading.first().waitFor()
      expect(await comparisonHeading.count()).toBe(1)
      const comparison = partialPage.locator('section[aria-labelledby="comparison-heading"]')
      const selectedZipHeading = comparison.getByRole('heading', { level: 3, name: /10001/ })
      await selectedZipHeading.waitFor()
      expect(await selectedZipHeading.count()).toBe(1)

      const sweepLoading = partialPage.locator('section[role="status"][aria-busy="true"]')
      releaseSecondChunk()
      await sweepLoading.waitFor({ state: 'detached' })
      const sweepReady = partialPage
        .locator('p[role="status"][aria-live="polite"]')
        .filter({ hasText: /^Loaded 801 ZIP codes(?: for the whole country)?\.$/ })
      await sweepReady.waitFor()
      expect(await sweepReady.innerText()).toMatch(/^Loaded 801 ZIP codes(?: for the whole country)?\.$/)
      expect(await comparisonHeading.count()).toBe(1)
      expect(await selectedZipHeading.count()).toBe(1)
    } finally {
      releaseSecondChunk()
      await context.close()
    }
  }, 120000)
})

describe('e2e: deterministic comparison matrix', () => {
  it('shows shared ACS figures and margins under each selected ZIP', async () => {
    const context = await browser.newContext()
    const fixtures = {
      '10001': { rent: '1800', rentMoe: '50', homeValue: '-666666666', homeValueMoe: '12000', lat: '40.7506', lon: '-73.9972' },
      '94103': { rent: '2200', rentMoe: '75', homeValue: '900000', homeValueMoe: '18000', lat: '37.7725', lon: '-122.4092' },
    }
    const unexpectedRemoteRequests: string[] = []
    const browserErrors: string[] = []

    try {
      await context.addInitScript(() => localStorage.setItem('civicscope.censusKey.v1', 'comparison-matrix-fixture-key'))
      const matrixPage = await context.newPage()
      matrixPage.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`))
      matrixPage.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`)
      })
      const appOrigin = new URL(BASE).origin
      await matrixPage.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === appOrigin) {
          await route.continue()
          return
        }

        if (url.hostname === 'tigerweb.geo.census.gov') {
          if (url.pathname.endsWith('/MapServer/2/query')) {
            const zip = url.searchParams.get('where')?.match(/ZCTA5='(\d{5})'/)?.[1]
            const place = zip && fixtures[zip as keyof typeof fixtures]
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                features: place
                  ? [{ attributes: { ZCTA5: zip, NAME: `ZCTA5 ${zip}`, CENTLAT: place.lat, CENTLON: place.lon } }]
                  : [],
              }),
            })
            return
          }

          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [] }) })
          return
        }

        if (url.hostname === 'api.census.gov') {
          const variables = (url.searchParams.get('get') ?? 'NAME').split(',')
          const requested = url.searchParams.get('for')?.split(':')[1]?.split(',') ?? []
          const rows = requested
            .filter((zip) => zip in fixtures)
            .map((zip) => {
              const fixture = fixtures[zip as keyof typeof fixtures]
              const values: Record<string, string> = {
                NAME: `ZCTA5 ${zip}`,
                B25064_001E: fixture.rent,
                B25064_001M: fixture.rentMoe,
                B25077_001E: fixture.homeValue,
                B25077_001M: fixture.homeValueMoe,
              }
              return [...variables.map((variable) => values[variable] ?? '1'), zip]
            })
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([[...variables, 'zip code tabulation area'], ...rows]),
          })
          return
        }

        if (
          url.hostname === 'nces.ed.gov' &&
          url.pathname.endsWith('/EDGE_GEOCODE_PUBLICSCH_1920/MapServer/0/query')
        ) {
          const bounds = url.searchParams.get('geometry')?.split(',').map(Number)
          const nyc = fixtures['10001']!
          const includesNyc = bounds?.length === 4 &&
            Number(nyc.lon) >= bounds[0]! && Number(nyc.lon) <= bounds[2]! &&
            Number(nyc.lat) >= bounds[1]! && Number(nyc.lat) <= bounds[3]!
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              features: includesNyc ? [{ attributes: {
                NCESSCH: '360010000001',
                NAME: 'NYC Fixture High School',
                OPSTFIPS: '36',
                LAT: '40.7507',
                LON: '-73.9971',
                SCHOOLYEAR: '2019-2020',
              } }] : [],
            }),
          })
          return
        }

        if (url.hostname === 'educationdata.urban.org') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              count: 1,
              next: null,
              results: url.searchParams.get('fips') === '36' ? [{
                ncessch: '360010000001',
                fips: 36,
                year: 2019,
                school_name: 'Portal fixture name',
                cohort_num: 84,
                grad_rate_low: 90,
                grad_rate_high: 94,
                grad_rate_midpt: 92,
              }] : [],
            }),
          })
          return
        }

        if (url.hostname === 'geodata.epa.gov' || url.hostname === 'nces.ed.gov') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [] }) })
          return
        }

        if (url.hostname === 'data.cityofnewyork.us') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{
              dbn: '01M292',
              school_name: 'NYC Fixture High School',
              total_students: '430',
              graduation_rate: '0.92',
              attendance_rate: '0.90',
              latitude: '40.7507',
              longitude: '-73.9971',
              grades2019: '9-12',
              finalgrades: '12',
            }]),
          })
          return
        }

        if (url.hostname === 'data.cdc.gov') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
          return
        }

        unexpectedRemoteRequests.push(url.toString())
        await route.abort()
      })

      await matrixPage.goto(`${BASE}/?z=10001,94103`, { waitUntil: 'domcontentloaded' })

      const matrix = matrixPage.getByRole('table', {
        name: /published measures available for all selected areas/i,
      })
      await matrix.waitFor({ state: 'visible', timeout: 60000 })
      const columns = matrix.getByRole('columnheader')
      expect(await columns.nth(1).innerText()).toContain('10001')
      expect(await columns.nth(2).innerText()).toContain('94103')

      const rentRow = matrix.locator('tbody tr').filter({ hasText: 'Median gross rent' })
      expect(await rentRow.count()).toBe(1)
      expect(await rentRow.locator('th[scope="row"]').innerText()).toContain('Median gross rent')
      const rentValues = await rentRow.locator('td').allInnerTexts()
      expect(rentValues).toHaveLength(2)
      expect(rentValues[0]).toMatch(/\$1,800\/mo\s*±\$50/)
      expect(rentValues[1]).toMatch(/\$2,200\/mo\s*±\$75/)

      const homeValueRow = matrix.locator('tbody tr').filter({ hasText: 'Median home value' })
      expect(await homeValueRow.count()).toBe(1)
      const homeValues = await homeValueRow.locator('td').allInnerTexts()
      expect(homeValues).toHaveLength(2)
      expect(homeValues[0]).toBe('no valid data available here')
      expect(homeValues[1]).toMatch(/\$900,000\s*±\$18,000/)

      const nycArticle = matrixPage.locator('article').filter({ hasText: '10001' })
      const nycEnrollment = nycArticle.getByRole('heading', {
        name: 'NYC Fixture High School — enrolled students',
        exact: true,
      })
      await nycEnrollment.waitFor()
      expect(await nycEnrollment.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]').innerText()).toContain('430')

      const nationalAcgr = nycArticle.getByRole('heading', {
        name: 'NYC Fixture High School — graduation rate midpoint (2019 ACGR)',
        exact: true,
      })
      await nationalAcgr.waitFor()
      const acgrCard = nationalAcgr.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
      expect(await acgrCard.locator('p').first().innerText()).toBe('92%')
      await acgrCard.getByRole('button', { name: 'Where this number comes from' }).click()
      expect(await acgrCard.innerText()).toContain('90–94% band')
      expect(await acgrCard.innerText()).toContain('2019 ACGR; 2019–20 NCES EDGE locations')
      expect(await nycArticle.innerText()).toContain('up to eight nearest public schools within 3 km')
      expect(unexpectedRemoteRequests).toEqual([])
      expect(browserErrors).toEqual([])
    } finally {
      await context.close()
    }
  }, 120000)
})

describe('e2e: per-ZIP EPA geography in comparison', () => {
  it('keeps each EPA value beside the block group for its own ZIP', async () => {
    const context = await browser.newContext()
    try {
      const comparisonPage = await context.newPage()
      const errors: string[] = []
      const pointFixtures = {
        '10001': { lat: 40.7506, lon: -73.9972, geoid: '360610103001', state: '36', county: '061' },
        '94103': { lat: 37.7725, lon: -122.4092, geoid: '060750178022', state: '06', county: '075' },
      }
      const censusRequestsByZip = new Map<string, string>()
      const epaRequestsByGeometry = new Map<string, string>()
      const unexpectedRemoteRequests: string[] = []
      comparisonPage.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
      comparisonPage.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`)
      })
      const appOrigin = new URL(BASE).origin
      await comparisonPage.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === appOrigin) {
          await route.continue()
          return
        }

        if (url.hostname === 'tigerweb.geo.census.gov') {
          if (url.pathname.endsWith('/MapServer/2/query')) {
            const zip = url.searchParams.get('where')?.match(/\bZCTA5\s*=\s*'(\d{5})'/)?.[1]
            const point = zip && pointFixtures[zip as keyof typeof pointFixtures]
            if (zip && point) censusRequestsByZip.set(zip, url.toString())
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                features: point
                  ? [{ attributes: { ZCTA5: zip, NAME: `ZCTA5 ${zip}`, CENTLAT: String(point.lat), CENTLON: String(point.lon) } }]
                  : [],
              }),
            })
            return
          }

          if (url.pathname.endsWith('/MapServer/8/query')) {
            const geometry = url.searchParams.get('geometry')
            const point = Object.values(pointFixtures).find((candidate) =>
              geometry === `${candidate.lon},${candidate.lat}`,
            )
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                features: point
                  ? [{ attributes: { GEOID: point.geoid.slice(0, 11), BASENAME: '', STATE: point.state, COUNTY: point.county } }]
                  : [],
              }),
            })
            return
          }
        }

        if (url.hostname === 'geodata.epa.gov' && url.pathname.endsWith('/MapServer/1/query')) {
          const geometry = url.searchParams.get('geometry')
          const entry = Object.entries(pointFixtures).find(([, point]) =>
            geometry === `${point.lon.toFixed(5)},${point.lat.toFixed(5)}`,
          )
          if (geometry) epaRequestsByGeometry.set(geometry, url.toString())
          const point = entry?.[1]
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              features: point
                ? [{ attributes: {
                    GEOID20: point.geoid,
                    NatWalkInd: 18.7,
                    D1A: 17.4,
                    D2B_E5MIXA: 0.68,
                    D3B: 135.5,
                    D4A: 151.55,
                    D5AR: 142219,
                  } }]
                : [],
            }),
          })
          return
        }

        if (url.hostname === 'nces.ed.gov') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [] }) })
          return
        }

        if (url.hostname === 'data.cityofnewyork.us' || url.hostname === 'data.cdc.gov') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
          return
        }

        unexpectedRemoteRequests.push(url.toString())
        await route.abort()
      })
      await comparisonPage.goto(`${BASE}/?z=10001,94103`, { waitUntil: 'domcontentloaded' })

      const table = comparisonPage.getByRole('table', {
        name: /published measures available for all selected areas/i,
      })
      await table.waitFor({ state: 'visible', timeout: 60000 })

      await comparisonPage.waitForFunction(() => {
        const rows = [...document.querySelectorAll('table tbody tr')].filter((candidate) =>
          candidate.textContent?.includes('Block group'),
        )
        return rows.length === 6 && rows.every((row) => {
          const cells = [...row.querySelectorAll('td')]
          return cells.length === 2 &&
            cells[0]?.textContent?.includes('360610103001') &&
            !cells[0]?.textContent?.includes('060750178022') &&
            cells[1]?.textContent?.includes('060750178022') &&
            !cells[1]?.textContent?.includes('360610103001')
        })
      }, undefined, { timeout: 120000 })

      const epaRows = table.locator('tbody tr').filter({ hasText: 'Block group' })
      expect(await epaRows.count()).toBe(6)
      for (const row of await epaRows.all()) {
        expect(await row.locator('th[scope="row"]').innerText()).not.toContain('Block group')
        const [manhattanCell, sanFranciscoCell] = await row.locator('td').allInnerTexts()
        expect(manhattanCell).toContain('360610103001')
        expect(manhattanCell).not.toContain('060750178022')
        expect(sanFranciscoCell).toContain('060750178022')
        expect(sanFranciscoCell).not.toContain('360610103001')
      }

      const epaMetricLabels = [
        'EPA walkability index at the ZIP point',
        'Residential density (housing units per acre)',
        'Five-category employment mix (index)',
        'Weighted street-intersection density (per square mile)',
        'Distance to nearest transit stop (meters)',
        'Jobs reachable within 45 minutes by car (weighted)',
      ]
      const detailArticles = comparisonPage.locator('section[aria-labelledby="comparison-heading"] article')
      const requestUrlsByZip = new Map<string, string>()
      for (const zip of ['10001', '94103']) {
        const point = pointFixtures[zip as keyof typeof pointFixtures]
        const censusRequest = new URL(censusRequestsByZip.get(zip) ?? 'http://missing.invalid')
        expect(censusRequestsByZip.has(zip), `Census point query captured for ZIP ${zip}`).toBe(true)
        expect(censusRequest.searchParams.get('where')).toBe(`ZCTA5='${zip}'`)
        expect(censusRequest.searchParams.get('outFields')).toBe('ZCTA5,NAME,CENTLAT,CENTLON')
        expect(censusRequest.searchParams.get('returnGeometry')).toBe('false')

        const geometry = `${point.lon.toFixed(5)},${point.lat.toFixed(5)}`
        const requestUrl = epaRequestsByGeometry.get(geometry)
        expect(requestUrl, `EPA request captured for ZIP ${zip}`).toBeDefined()
        requestUrlsByZip.set(zip, requestUrl!)
        const query = new URL(requestUrl!)
        expect(query.searchParams.get('geometry'), `${zip} EPA point`).toBe(geometry)
        expect(query.searchParams.get('where')).toBe('1=1')
        expect(query.searchParams.get('geometryType')).toBe('esriGeometryPoint')
        expect(query.searchParams.get('inSR')).toBe('4326')
        expect(query.searchParams.get('spatialRel')).toBe('esriSpatialRelIntersects')
        expect(query.searchParams.get('outFields')).toBe('GEOID20,NatWalkInd,D1A,D2B_E5MIXA,D3B,D4A,D5AR')
        expect(query.searchParams.get('returnGeometry')).toBe('false')
        expect(query.searchParams.get('f')).toBe('json')

        const article = detailArticles.filter({ hasText: zip })
        expect(await article.count()).toBe(1)
        for (const label of epaMetricLabels) {
          const card = article.getByRole('heading', { name: label, exact: true }).locator('xpath=../../..')
          await card.getByRole('button', { name: 'Where this number comes from' }).click()
          const citation = card.getByRole('link', { name: 'U.S. EPA Smart Location Database Version 3.0 (2021)' })
          expect(await citation.getAttribute('href'), `${zip} ${label} citation`).toBe(requestUrl)
        }
      }
      expect(requestUrlsByZip.get('10001')).not.toBe(requestUrlsByZip.get('94103'))
      expect(unexpectedRemoteRequests).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  }, 180000)
})

describe.skipIf(!KEY)('e2e: country-wide sweep with a real key', () => {
  it('loads a national set of ZIP codes in one request', async () => {
    await page.waitForSelector('#screen-heading', { timeout: 120000 })
    const nationalStatus = page
      .locator('[role="status"][aria-live="polite"]')
      .filter({ hasText: /^Loaded [\d,]+ ZIP codes for the whole country\.$/ })
      .first()
    await nationalStatus.waitFor({ state: 'attached', timeout: 180000 })

    const text = await nationalStatus.innerText()
    const count = text.match(/^Loaded ([\d,]+) ZIP codes for the whole country\.$/)
    const n = Number(count?.[1]?.replace(/,/g, '') ?? 0)
    // A national sweep must cover tens of thousands of areas, not a handful.
    expect(n).toBeGreaterThan(30000)

    expect(await page.getByRole('radio', { name: 'ZIP code order' }).isChecked()).toBe(true)
    const table = page.getByRole('table', { name: /US ZIP code tabulation areas/ })
    expect(await table.getByRole('columnheader', { name: 'ZIP & location' }).getAttribute('aria-sort')).toBe('ascending')
    const visibleZips = await table.locator('tbody > tr:not([aria-hidden="true"]) th[scope="row"] span.font-mono').allInnerTexts()
    expect(visibleZips.length).toBeGreaterThan(1)
    expect(visibleZips).toEqual([...visibleZips].sort())
  }, 240000)

  it('shows household counts that differ between ZIP codes', async () => {
    // This is the regression this whole suite exists for: household counts were
    // read from B25001 (all housing units, including vacant homes), and the
    // same value appeared regardless of which ZIP was searched.
    const settle = (zip: string) =>
      page.waitForFunction(
        (z) => {
          const card = [...document.querySelectorAll('main article')].find((a) =>
            a.textContent?.includes(z),
          )
          return Boolean(card) && !card?.textContent?.includes('Fetching detail')
        },
        zip,
        { timeout: 120000 },
      )

    await searchFor(ZIPS[0]!)
    await settle(ZIPS[0]!)
    const first = await readFigure(ZIPS[0]!, 'Households')
    expect(first, `no households figure for ${ZIPS[0]}`).not.toBeNull()

    await searchFor(ZIPS[1]!)
    await settle(ZIPS[1]!)
    const second = await readFigure(ZIPS[1]!, 'Households')

    expect(second, `no households figure for ${ZIPS[1]}`).not.toBeNull()
    // A residential Austin ZIP and a dense Chicago one cannot have identical
    // household counts. If this fails, values are not varying by area.
    expect(first).not.toBe(second)
    expect(
      await page.getByRole('table', {
        name: /published measures available for all selected areas/i,
      }).count(),
    ).toBe(1)
  }, 300000)

  it('renders real published figures with their margin of error', async () => {
    // Spot-checks the shape of what a user sees, so a wrong table or a
    // suppressed column cannot pass unnoticed.
    await searchFor('78701')
    await page.waitForFunction(
      () => {
        const card = [...document.querySelectorAll('main article')].find((a) => a.textContent?.includes('78701'))
        return Boolean(card) && !card?.textContent?.includes('Fetching detail')
      },
      undefined,
      { timeout: 120000 },
    )
    const card = page.locator('main article').first()
    const text = await card.innerText()

    // Median rent and home value, plus the actual district staffing measures,
    // are present as formatted figures rather than mislabeled finance data.
    expect(text).toMatch(/Median gross rent/)
    expect(text).toMatch(/\$[\d,]+/)
    expect(text).toMatch(/Teachers in district/)
    // Margins of error must be rendered, not hidden.
    expect(text).toMatch(/±/)
  }, 300000)

  it('sorts the screen locally, without further requests', async () => {
    // Sorting the 33k-row table is a local operation over data already in
    // memory, so it must not touch the network.
    //
    // The count is only taken once the sweep has genuinely finished. Waiting on
    // a "Loaded" string is not enough: the app re-renders progress while late
    // chunks are still landing, and a request arriving inside the measurement
    // window is indistinguishable from one the sort caused. This waits for the
    // progress line to disappear, then for the row count to stop changing, so a
    // race with the sweep is reported as a race rather than as a network call
    // from the sort.
    await page
      .waitForFunction(
        () => !/\d+ of 43 areas/.test(document.body.innerText ?? ''),
        undefined,
        { timeout: 400000 },
      )
      .catch(() => undefined)

    let previous = -1
    for (let i = 0; i < 20; i++) {
      const rows = await page.locator('table tbody tr').count()
      if (rows === previous) break
      previous = rows
      await page.waitForTimeout(1500)
    }
    await page.waitForTimeout(3000)

    const before = await censusRequestCount()
    await page.click('table button:has-text("Median rent")')
    await page.waitForTimeout(2500)
    const after = await censusRequestCount()
    expect(after, `sorting issued ${after - before} Census request(s)`).toBe(before)
    expect(await page.getByRole('radio', { name: 'Median rent' }).isChecked()).toBe(true)
  }, 500000)
})

/**
 * Reads a named figure from the comparison card.
 *
 * The value is a sibling paragraph of the metric's heading, not part of the
 * heading's own text, so the heading is located first and its card is then read.
 */
async function readFigure(zip: string, label: string): Promise<number | null> {
  const card = page.locator('main article').filter({ hasText: zip }).first()
  const heading = card.locator('h3', { hasText: new RegExp(`^${label}`) }).first()
  if ((await heading.count()) === 0) return null
  // The figure sits in the element immediately after its heading.
  const text = await heading.locator('xpath=following-sibling::*[1]').innerText().catch(() => '')
  const cleaned = text.replace(/[^\d.]/g, '')
  return cleaned ? Number(cleaned) : null
}

/**
 * Counts requests actually made to the Census API.
 *
 * An earlier version of this counted console errors, which proves nothing: the
 * assertion it guarded could never fail. Request counting is done by observing
 * the network, so it measures the thing being claimed.
 */
let censusRequests = 0
async function censusRequestCount(): Promise<number> {
  return censusRequests
}
