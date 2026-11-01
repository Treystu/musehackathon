/**
 * Drives the live deployed site in a real browser and verifies ZIP codes
 * actually resolve. This is the end-to-end check that matters: every other test
 * exercises a module, but only this one exercises what a user sees.
 *
 * Runs without a Census key, so it verifies geocoding and the shell. Assertions
 * that need figures skip rather than fail.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'https://civicscope.pages.dev'

/** Spread across the country, plus every range that has ever failed. */
const ZIPS = [
  '78701', '10001', '60601', '90210', '94110', '02134',
  '96813', '99501', '00901', '96910', '01002', '00716',
]

let browser: Browser
let context: BrowserContext
let page: Page

beforeAll(async () => {
  browser = await chromium.launch()
  context = await browser.newContext()
  page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
})

async function lookUp(zip: string): Promise<string> {
  await page.waitForSelector('#place', { state: 'visible', timeout: 60000 })
  const submit = page.getByRole('button', { name: 'Add to comparison' })
  expect(await submit.isEnabled(), 'ZIP lookup should remain available without a Census key').toBe(true)

  await page.fill('#place', zip)
  await submit.click()
  // Wait for either a result heading, an alert, or a settled state.
  await page
    .waitForFunction(
      () =>
        document.querySelector('main article') !== null ||
        document.querySelector('[role="alert"]') !== null,
      { timeout: 45000 },
    )
    .catch(() => {})
  return page.content()
}

describe('live site: ZIP codes resolve', () => {
  for (const zip of ZIPS) {
    it(`${zip} is accepted and shown as a comparison area`, async () => {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      const html = await lookUp(zip)

      // The failure mode that regressed repeatedly was a message claiming the ZIP
      // is not a US ZIP code. That must never appear for a real one.
      expect(html, `${zip} was rejected as not a US ZIP`).not.toContain('is not a US ZIP code')

      const alert = await page.locator('[role="alert"]').first().innerText().catch(() => '')
      expect(alert, `${zip} showed an error: ${alert}`).not.toMatch(/not a US ZIP/i)

      // It should now be selected for comparison.
      const selected = await page.locator('main article').count()
      expect(selected, `${zip} was not added to the comparison set`).toBeGreaterThan(0)
    }, 120000)
  }
})

describe('live site: a code with no Census record is reported honestly', () => {
  it('rejects a genuinely unassigned code rather than inventing an answer', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await lookUp('00000')
    const alert = await page.locator('[role="alert"]').first().innerText().catch(() => '')
    expect(alert).toMatch(/not a US ZIP/i)
  }, 120000)
})

describe('live site: shell integrity', () => {
  it('the methodology page documents sources, weights, and fair housing limits', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.click('button:has-text("Methodology")')
    await page.waitForTimeout(600)
    const text = await page.locator('body').innerText()
    expect(text).toMatch(/Fair Housing/i)
    expect(text).toMatch(/Census Bureau/i)
    // The scoring weights are published, which is the primary mitigation for a
    // ranking product and must not be reachable only from source code.
    expect(text).toMatch(/weight/i)
    expect(text).toMatch(/Affordability/i)
  }, 60000)

  it('the Fair Housing notice is present on the data surface', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await lookUp('78701')
    const text = await page.locator('body').innerText()
    expect(text).toMatch(/not an overall ranking or a recommendation/i)
    expect(text).toMatch(/Fair Housing Assistance Program/i)
    expect(text).toMatch(/Department of Housing/i)
  }, 120000)
})
