/**
 * The first-run experience, in a real browser.
 *
 * Almost everything here is a property of the rendered accessibility tree and
 * cannot be checked by a unit test: whether `<dialog>.showModal()` actually
 * produced a modal, whether focus is trapped inside it, whether Escape reaches the
 * browser's own cancel handler. Asserting the JSX was written correctly would
 * prove nothing about whether any of that works.
 *
 * The dismissal behaviour is tested by reloading against the same profile, because
 * "already seen" is the state every returning visitor is in and the state a first
 * visit can never re-enter.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
const TOUR = 'dialog'
/** The permanent control in the header, present on every view at every time. */
const HEADER_BUTTON = 'header button:has-text("How this works")'
/**
 * The first-visit notice card that used to stand on every task surface.
 * Owner phone review 2026-11-02 removed it: the shared-key fact now lives
 * behind the Ask pill's wording-helper tip and on the Methodology view, so
 * this selector must match nothing, on a first visit and on later ones.
 */
const NOTICE = 'main aside'
/** The Ask pill's help tip, whose panel carries the Census-key fact. */
const WORDING_TIP = 'button[aria-label="About the wording helper"]'

let browser: Browser
let context: BrowserContext
let page: Page

/** Loads with no stored tour flag, which is a genuine first visit. */
async function firstVisit() {
  await page.evaluate(() => localStorage.removeItem('civicscope.toured.v1'))
  await page.reload({ waitUntil: 'domcontentloaded' })
}

beforeAll(async () => {
  browser = await chromium.launch()
  context = await browser.newContext()
  page = await context.newPage()

  const res = await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => null)
  if (!res || res.status() >= 400) {
    throw new Error(`tour target unreachable at ${BASE}. Start a served build or set E2E_BASE_URL.`)
  }
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
})

describe('e2e: first run', () => {
  it('does not block the search box on arrival', async () => {
    await firstVisit()

    // The point of the redesign. A modal on first paint covered the one control
    // that works without a Census key, and made every other browser test fail
    // because it could not type into it. Nothing may be modal until asked for.
    expect(await page.locator(`${TOUR}[open]`).count()).toBe(0)

    // And the notice itself must not intercept: a reader can simply type.
    expect(await page.locator('#place').count()).toBe(1)
    await page.fill('#place', '78701')
    expect(await page.locator('#place').inputValue()).toBe('78701')
  }, 60000)

  it('stands no notice card on the task surface; the key fact sits behind the pill tip', async () => {
    await firstVisit()

    // Explain-nothing (owner phone review, 2026-11-02): no standing card.
    // The fact the card used to carry — that the full 33,791-ZIP load runs
    // on a Census key — is one tap away in the Ask pill's help tip instead.
    expect(await page.locator(NOTICE).count()).toBe(0)

    const tip = page.locator(WORDING_TIP)
    await tip.click()
    const panelId = await tip.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    const panel = page.locator(`[id="${panelId}"]`)
    await panel.waitFor({ state: 'visible', timeout: 20000 })

    const text = await panel.innerText()
    expect(text).toMatch(/33,791/)
    expect(text).toMatch(/Census API key|shared Census key/)

    // Unpin it again so later tests start from the plain surface.
    await tip.click()
  }, 60000)

  it('opens a real modal dialog when asked', async () => {
    await firstVisit()
    await page.locator(HEADER_BUTTON).click()

    const dialog = page.locator(TOUR)
    await dialog.waitFor({ state: 'visible', timeout: 20000 })

    // `open` plus `:modal` is what gives us the focus trap and page inertness.
    expect(await dialog.evaluate((el: HTMLDialogElement) => el.open)).toBe(true)
    expect(await dialog.evaluate((el: HTMLDialogElement) => el.matches(':modal'))).toBe(true)

    const labelled = await dialog.evaluate((el: HTMLDialogElement) => ({
      labelledBy: el.getAttribute('aria-labelledby'),
      describedBy: el.getAttribute('aria-describedby'),
      step: el.textContent ?? '',
    }))
    expect(labelled.labelledBy).toBeTruthy()
    expect(labelled.describedBy).toBeTruthy()
    expect(labelled.step).toMatch(/Step 1 of 3/)

    // And no standing notice appears alongside it, on any visit.
    expect(await page.locator(NOTICE).count()).toBe(0)
  }, 60000)

  it('never lets focus reach a control behind the modal', async () => {
    /*
     * Measured, not assumed. Tabbing through the dialog cycles
     * `Skip -> Next -> <body> -> Skip`, and the `<body>` step is the wrap boundary:
     * Chromium parks focus on the document for one keystroke before moving it to
     * the first focusable inside the dialog again. An earlier version of this test
     * asserted `document.activeElement` was inside the dialog at every sample and
     * failed on that boundary — reporting a WCAG failure that did not exist.
     *
     * The property that matters is the one asserted here: focus may pass through
     * the document, but must never land on a control *outside* the dialog. That is
     * what `showModal()` guarantees and what a hand-rolled modal gets wrong.
     */
    const escaped: string[] = []
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      const outside = await page.evaluate(() => {
        const d = document.querySelector('dialog[open]')
        const a = document.activeElement
        if (!d || !a || a === document.body || a === document.documentElement) return null
        if (d.contains(a)) return null
        return `${a.tagName}: ${(a.textContent ?? '').trim().slice(0, 40)}`
      })
      if (outside) escaped.push(`tab ${i + 1} -> ${outside}`)
    }
    expect(escaped, `focus escaped the modal: ${escaped.join('; ')}`).toEqual([])
  }, 60000)

  it('advances through the steps and reports progress', async () => {
    const dialog = page.locator(TOUR)
    expect(await dialog.innerText()).toMatch(/Step 1 of 3/)

    await dialog.locator('button:has-text("Next")').click()
    expect(await dialog.innerText()).toMatch(/Step 2 of 3/)
    // The copy must state the privacy property, not gesture at it.
    expect(await dialog.innerText()).toMatch(/stored only in this browser/)

    await dialog.locator('button:has-text("Next")').click()
    expect(await dialog.innerText()).toMatch(/Step 3 of 3/)

    // Back is absent on the first step and present afterwards.
    expect(await dialog.locator('button:has-text("Back")').count()).toBe(1)
    await dialog.locator('button:has-text("Back")').click()
    expect(await dialog.innerText()).toMatch(/Step 2 of 3/)
  }, 60000)

  it('closes on Escape and records that it has been seen', async () => {
    // Escape is the browser's own cancel path on a modal dialog; if this works it
    // means no custom key handling is needed for the most-used dismissal route.
    const dialog = page.locator(TOUR)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden', timeout: 10000 })
    expect(await page.evaluate(() => localStorage.getItem('civicscope.toured.v1'))).toBe('true')
  }, 60000)

  it('does not reappear on a later visit, and stays reachable on demand', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)

    expect(await page.locator(NOTICE).count(), 'the notice interrupted a returning visitor').toBe(0)
    expect(await page.locator(`${TOUR}[open]`).count()).toBe(0)

    // The permanent way back in. Without it, dismissal would be permanent and the
    // orientation would be unreachable for anyone who closed it too early.
    await page.locator(HEADER_BUTTON).click()
    const dialog = page.locator(TOUR)
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    expect(await dialog.evaluate((el: HTMLDialogElement) => el.open)).toBe(true)

    await dialog.locator('button:has-text("Skip")').click()
    await dialog.waitFor({ state: 'hidden', timeout: 10000 })
    expect(await page.evaluate(() => localStorage.getItem('civicscope.toured.v1'))).toBe('true')
  }, 60000)

  it('offers only 44px-or-taller controls inside the dialog', async () => {
    // WCAG 2.2 target size minimum is 24px, but this project standardises on
    // 44px, so the tour must not be the one place that is quietly smaller.
    await page.locator(HEADER_BUTTON).click()
    const dialog = page.locator(TOUR)
    await dialog.waitFor({ state: 'visible', timeout: 10000 })

    const small = await dialog
      .locator('button')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({ text: (n.textContent ?? '').trim(), h: n.getBoundingClientRect().height })).filter((b) => b.h < 44),
      )
    expect(small, `controls under 44px: ${JSON.stringify(small)}`).toEqual([])
  }, 60000)
})
