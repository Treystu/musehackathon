import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

let browser: Browser
let page: Page
let releaseIntent: (() => void) | null = null

/**
 * Terminal focus placement pin (a11y cure D2, 2026-11-03).
 *
 * The ask-submit lockout (owner ruling, 2026-11-02) removes the Ask
 * button from the DOM for the run's whole span. A keyboard submit
 * therefore drops focus to the body the moment the run starts —
 * measured on the served production build (judge-a11y DOM audit):
 * focus sat on body at submit, through the run, and at the terminal,
 * with nothing placing it on the answer. The cure leaves the lockout
 * untouched and moves focus to the answer region when the run
 * settles, but only from the body — focus the reader placed anywhere
 * else is never taken. This pin drives exactly the measured path:
 * focus the submit button, submit by keyboard, watch focus sit on
 * the body while the intent response is held at the network
 * boundary, then release and require focus to land on the terminal's
 * answer region.
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
          geographies: ['96778'],
          metricKeys: ['median_gross_rent'],
          filters: [],
          clarificationNeeded: false,
        },
      }),
    })
  })
  await page.route('**/api/muse/explain', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prose: 'The estimate is uncertain because the margin is wide.' }),
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

it('lands focus on the answer region at the terminal of a keyboard-submitted run', async () => {
  await page.getByRole('textbox', { name: 'Ask in plain language' }).fill('What is the rent in Pahoa?')
  // Scoped to main (item 18 S1): the header pill is also named "Ask".
  const submit = page.locator('main').getByRole('button', { name: 'Ask', exact: true })
  await submit.focus()
  await page.keyboard.press('Enter')
  // The lockout takes the focused button out of the DOM: the submit
  // control is gone and focus has dropped to the body — the defect's
  // signature, reproduced before the cure's half is exercised.
  await page.waitForFunction(
    () => document.querySelector('main form button[type="submit"]') === null,
    undefined,
    { timeout: 10000 },
  )
  await page.waitForFunction(() => document.activeElement === document.body, undefined, {
    timeout: 10000,
  })
  releaseIntent?.()
  // Terminal: the lock is released and a terminal artifact renders;
  // focus must land on its answer region without further input.
  await page.waitForFunction(
    () => document.activeElement?.hasAttribute('data-answer-region') ?? false,
    undefined,
    { timeout: 30000 },
  )
  const landed = await page.evaluate(() => {
    const el = document.activeElement
    return {
      region: el?.hasAttribute('data-answer-region') ?? false,
      text: (el?.textContent ?? '').slice(0, 120),
    }
  })
  expect(landed.region).toBe(true)
  // The hermetic terminal is whichever artifact the aborted Census
  // load produces — the composed card or the note in the card's shell
  // ("The country-wide data could not be loaded…"); both carry the
  // Answer heading, and the pin's subject is the focus landing, not
  // which of the two the load's failure path selects.
  expect(landed.text).toContain('Answer')
}, 120000)

it('dismisses the mic consent panel with exactly one click or key press (D3)', async () => {
  // D3 (2026-11-03): a live hosted-browser run reported "Not now"
  // needing two clicks. The dismissal path in source is a single
  // setAsking(false), and a seven-style hermetic reproduction on the
  // served build (role click, coordinate click, touch tap, immediate
  // click, Enter, Space, screenshot-then-tap) dismissed in one click
  // every time — the reported mechanism does not reproduce in the
  // product. This pin stands as the checked invariant: one click
  // dismisses, and so does one Enter on the focused button. A future
  // build that breaks either reopens D3 with this pin as the evidence.
  const panel = page.locator('[aria-label="Microphone consent"]')
  const mic = page.getByRole('button', { name: 'Speak a question' })
  await mic.click()
  await panel.waitFor({ state: 'visible', timeout: 10000 })
  await page.getByRole('button', { name: 'Not now' }).click()
  await page.waitForTimeout(400)
  expect(await panel.count()).toBe(0)
  await mic.click()
  await panel.waitFor({ state: 'visible', timeout: 10000 })
  await page.getByRole('button', { name: 'Not now' }).focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  expect(await panel.count()).toBe(0)
}, 120000)
