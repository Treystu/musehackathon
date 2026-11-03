import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

let browser: Browser
let page: Page
const requests: string[] = []
let intentBody: Record<string, unknown> | null = null

const INTENT = {
  mode: 'lookup',
  geographies: ['96778'],
  metricKeys: ['median_gross_rent'],
  filters: [],
  clarificationNeeded: false,
}

beforeAll(async () => {
  browser = await chromium.launch()
  page = await browser.newPage()
  page.on('request', (request) => requests.push(request.url()))

  // The AI path is served by a fixture at the network boundary, which is the
  // only place a browser test can stand without a key or credits. Everything
  // else external is refused so a failure here is never an upstream outage.
  await page.route('**/api/muse/intent', async (route) => {
    intentBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ intent: INTENT }),
    })
  })
  await page.route('**/api/muse/explain', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prose: 'The estimate is uncertain because the margin is wide.' }),
    })
  })
  await page.route(/https:\/\/(api\.census\.gov|geocoding\.geo\.census\.gov|api\.cdc\.gov|.*arcgis\.com)\/.*/, (route) =>
    route.abort(),
  )
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
})

afterAll(async () => {
  await browser?.close()
})

it('mounts the text-only Ask surface', async () => {
  expect(await page.getByRole('heading', { name: 'Ask CivicScope' }).count()).toBe(1)
  expect(await page.getByRole('textbox', { name: 'Ask in plain language' }).count()).toBe(1)
  expect(await page.getByRole('button', { name: /mic|transcribe|record/i }).count()).toBe(0)
  // Nothing runs before the reader asks.
  expect(await page.getByRole('button', { name: 'Run this request' }).count()).toBe(0)
})

it('parses a real query through the live client and shows the validated intent', async () => {
  await page.getByLabel('Ask in plain language').fill('What is the rent in Pahoa?')
  // Scoped to main (item 18 S1): the header pill is also named "Ask".
  await page.locator('main').getByRole('button', { name: 'Ask', exact: true }).click()

  // Plain-language labels (owner finding F-B, 2026-11-02), as in
  // app.e2e.ts: plain mode name and measure label, never raw keys.
  await page.getByText('Look up a place', { exact: true }).waitFor()
  expect(await page.getByRole('button', { name: 'Remove place 96778' }).count()).toBe(1)
  expect(await page.getByRole('button', { name: 'Remove measure Median gross rent' }).count()).toBe(1)

  // The proxy is same-origin and carries the query; no key is in the body.
  expect(intentBody).not.toBeNull()
  expect(intentBody!.queryText).toBe('What is the rent in Pahoa?')
  expect(JSON.stringify(intentBody)).not.toMatch(/authorization|api[_-]?key/i)

  // Auto-run (2026-11-01): there is no Run step any more.
  expect(await page.getByRole('button', { name: 'Run this request' }).count()).toBe(0)
})

it('auto-runs the intent into the comparison on submit, no Run click', async () => {
  // selectPlace records the selection before any fetch, and the URL state
  // follows the selection, so this is a real assertion with the network down.
  await page.waitForFunction(() => window.location.search.includes('z=96778'))
  expect(requests.some((url) => url.includes('/api/muse/'))).toBe(true)
})
