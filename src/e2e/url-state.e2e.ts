/**
 * URL-carried comparisons, in a real browser, without a Census key.
 *
 * The unit tests prove the codec; what only a browser can prove is that the
 * wiring does what the design says: a link pre-selects on arrival, the URL
 * follows later selections without piling up history, and a malformed parameter
 * still loads a working site. Everything here is keyless, because the comparison
 * header and the place mapping both work without one.
 *
 * Each test gets a fresh browser context. An earlier version shared one page
 * across all four, and the tests interfered: navigation history accumulated
 * across tests and a strict history-count assertion measured the wrong thing.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch()
  const probe = await browser.newContext().then((c) => c.newPage())
  const res = await probe.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => null)
  if (!res || res.status() >= 400) {
    throw new Error(`url-state target unreachable at ${BASE}. Start a served build or set E2E_BASE_URL.`)
  }
  await probe.context().close()
}, 120000)

afterAll(async () => {
  await browser?.close()
})

/** A fresh page for one test: no shared history, no shared app state. */
async function freshPage(): Promise<Page> {
  const context: BrowserContext = await browser.newContext()
  return context.newPage()
}

/** Waits until the comparison holds a card naming this ZIP code. */
async function waitForCard(page: Page, zip: string, timeout = 60000) {
  await page.waitForFunction(
    (z) => [...document.querySelectorAll('main article')].some((a) => a.textContent?.includes(z)),
    zip,
    { timeout },
  )
}

describe('e2e: URL-carried comparison', () => {
  it('pre-selects the ZIP codes a shared link names, on arrival', async () => {
    const page = await freshPage()
    await page.goto(`${BASE}/?z=78701,10001`, { waitUntil: 'domcontentloaded' })
    await waitForCard(page, '78701')
    await waitForCard(page, '10001')
    // And the reader sees where each area is, not just a number.
    const card = page.locator('main article').filter({ hasText: '78701' }).first()
    expect(await card.innerText()).toMatch(/Austin/)
    await page.context().close()
  }, 90000)

  it('carries a later addition in the URL, without adding history entries', async () => {
    const page = await freshPage()
    await page.goto(`${BASE}/?z=78701`, { waitUntil: 'domcontentloaded' })
    await waitForCard(page, '78701')
    const historyBefore = await page.evaluate(() => window.history.length)

    await page.fill('#place', '10001')
    await page.locator('form').filter({ has: page.locator('#place') }).locator('button[type="submit"]').click()
    await waitForCard(page, '10001')
    expect(await page.evaluate(() => window.location.search)).toContain('z=10001,78701')

    // replaceState, not pushState: adding an area adds no history entry, so
    // pressing Back leaves the site rather than replaying the selection.
    const historyAfter = await page.evaluate(() => window.history.length)
    expect(historyAfter).toBe(historyBefore)
    await page.context().close()
  }, 120000)

  it('drops a malformed parameter silently and loads a working site', async () => {
    const page = await freshPage()
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(e.message))
    await page.goto(`${BASE}/?z=banana,78701,nonsense`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#place', { timeout: 20000 })
    // The valid entry was kept; the nonsense was not.
    await waitForCard(page, '78701')
    expect(errs).toEqual([])
    // And the address bar no longer carries the garbage.
    expect(await page.evaluate(() => window.location.search)).not.toContain('banana')
    await page.context().close()
  }, 90000)

  it('clears the parameter when the last area is removed', async () => {
    const page = await freshPage()
    await page.goto(`${BASE}/?z=78701`, { waitUntil: 'domcontentloaded' })
    await waitForCard(page, '78701')
    await page.locator('main article button:has-text("Remove")').first().click()
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 0, undefined, {
      timeout: 60000,
    })
    expect(await page.evaluate(() => window.location.search)).not.toContain('z=')
    await page.context().close()
  }, 90000)
})
