import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

let browser: Browser
let page: Page
let releaseIntent: (() => void) | null = null

/**
 * The conversational frame's behaviour pin (plan C6/C12): during a
 * deferred run the Ask surface shows the acknowledgment line + the
 * thinking indicator (aria-live "Working on it"); at the terminal
 * state the indicator is gone. The intent route is held open at the
 * network boundary so the working state is observable, then released
 * with a clarification intent (a terminal state that needs no sweep
 * data).
 */
beforeAll(async () => {
  browser = await chromium.launch()
  page = await browser.newPage()
  await page.route('**/api/muse/intent', async (route) => {
    await new Promise<void>((resolve) => {
      releaseIntent = resolve
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        intent: {
          mode: 'lookup',
          geographies: [],
          metricKeys: [],
          filters: [],
          clarificationNeeded: true,
        },
      }),
    })
  })
  await page.route(
    /https:\/\/(api\.census\.gov|geocoding\.geo\.census\.gov|api\.cdc\.gov|.*arcgis\.com)\/.*/,
    (route) => route.abort(),
  )
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
})

afterAll(async () => {
  await browser?.close()
})

it('shows ack + thinking indicator during a deferred run, gone at the terminal state', async () => {
  await page.getByRole('textbox', { name: 'Ask in plain language' }).fill('What is the rent like?')
  // Scoped to main (item 18 S1): the header pill is also named "Ask".
  await page.locator('main').getByRole('button', { name: 'Ask', exact: true }).click()
  // Working state: one ack line from the annex set + the indicator.
  await page.getByText(/Sure thing|On it|Let me look into that/).first().waitFor({ timeout: 10000 })
  expect(await page.getByText('Working on it').count()).toBeGreaterThan(0)
  releaseIntent?.()
  // Terminal state (clarification): the indicator is gone.
  await page.getByText('More detail is needed before anything runs').waitFor({ timeout: 15000 })
  expect(await page.getByText('Working on it').count()).toBe(0)
})
