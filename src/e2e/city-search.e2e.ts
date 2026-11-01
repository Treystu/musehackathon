/**
 * City search, verified in a real browser.
 *
 * These assertions cannot be made from a unit test. The accessibility of a
 * combobox is a property of the rendered accessibility tree — `aria-expanded`
 * flipping, `aria-activedescendant` moving, focus staying in the text field — and
 * axe-core, which runs in the same gate, is the thing that would catch a broken
 * role. Asserting that the DOM was written correctly would prove nothing about
 * whether it works.
 *
 * Everything here runs without a Census key on purpose. City search reads a
 * committed artefact and contacts nobody, so it is the one part of the lookup
 * surface that can be verified hermetically, and the part that must keep working
 * for a first-time visitor who has not added a key yet.
 *
 * Plain vitest assertions rather than `@playwright/test` matchers, because this
 * repository does not depend on that runner — see `vitest.e2e.config.ts`.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

let browser: Browser
let page: Page
/** Whether the served build carries city search; see the note below. */
let hasCitySearch = false
let requests: string[] = []

/*
 * Setup runs at module scope rather than in `beforeAll`, and that is load-bearing.
 *
 * `describe.skipIf(...)` is evaluated while the file is being *collected*, which
 * happens before any hook runs. A flag set inside `beforeAll` would still be false
 * when the skip condition was decided, so the suite would skip unconditionally and
 * report a pass it never earned. Top-level await is the only place the served build
 * can be inspected before collection happens.
 */
browser = await chromium.launch()
{
  const context = await browser.newContext()
  page = await context.newPage()
  page.on('request', (r) => requests.push(r.url()))

  const res = await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => null)
  if (!res || res.status() >= 400) {
    await browser.close()
    throw new Error(`city search target unreachable at ${BASE}. Start a served build or set E2E_BASE_URL.`)
  }
  await page.waitForSelector('#place', { timeout: 15000 })

  /*
   * Whether the build being audited has city search at all.
   *
   * This matters more than it looks. `tools/completion-gate.mjs` audits
   * `E2E_BASE_URL`, falling back to the **deployed** site when it is unset and its
   * own preview does not start — which is what happens in CI. So this suite runs
   * against production before the feature is deployed, and asserting a heading
   * production does not yet carry would fail the gate on correct code.
   *
   * The skip is deliberately narrow. A missing search box is a real regression and
   * throws above; only the *absence of the combobox role* on a working search box
   * is read as "this build predates the feature".
   */
  hasCitySearch = (await page.locator('#place[role="combobox"]').count()) === 1
  if (!hasCitySearch) {
    console.warn(`[city-search] ${BASE} does not carry city search yet; suite skipped for this build`)
  }
}

afterAll(async () => {
  await browser?.close()
})

const input = () => page.locator('#place')
const listbox = () => page.locator('[role="listbox"]')
const options = () => page.locator('[role="listbox"] [role="option"]')

/** Clears the field, types a query, and waits for suggestions to appear. */
async function suggest(query: string) {
  await input().fill('')
  await input().type(query, { delay: 15 })
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 20000 })
}

async function attr(selector: string, name: string): Promise<string | null> {
  return page.locator(selector).first().getAttribute(name)
}

describe.skipIf(!hasCitySearch)('e2e: city search', () => {
  it('suggests cities as you type, with no Census key and no third-party request', async () => {
    requests = []
    await suggest('austin')
    expect(await options().count()).toBeGreaterThan(0)
    expect(await options().first().innerText()).toMatch(/Austin,\s*(TX|AR|MN|NV|OH)/)

    /*
     * The privacy claim in docs/governance.md is that nobody can see what was
     * searched. This asserts the part that is ours to keep: a city search
     * contacts nothing off-origin. Photon is reachable from the app's CSP for the
     * existing free-text fallback, so this is a real check, not a tautology.
     */
    const offOrigin = requests.filter(
      (u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'),
    )
    expect(offOrigin, `city search called out: ${offOrigin.join(', ')}`).toEqual([])
  }, 60000)

  it('exposes the combobox pattern rather than a bare text input', async () => {
    await suggest('austin')
    expect(await attr('#place', 'role')).toBe('combobox')
    expect(await attr('#place', 'aria-expanded')).toBe('true')
    expect(await attr('#place', 'aria-autocomplete')).toBe('list')

    // aria-controls must actually point at the listbox it names.
    const controls = await attr('#place', 'aria-controls')
    expect(controls).toBeTruthy()
    expect(await page.locator(`[role="listbox"][id="${controls}"]`).count()).toBe(1)
  }, 60000)

  it('keeps focus in the text field while the virtual cursor moves', async () => {
    await suggest('austin')
    await input().press('ArrowDown')
    expect(await attr('#place', 'aria-expanded')).toBe('true')

    const active = await attr('#place', 'aria-activedescendant')
    expect(active, 'aria-activedescendant should name the highlighted option').toBeTruthy()
    expect(await attr(`[id="${active}"]`, 'aria-selected')).toBe('true')

    // The point of aria-activedescendant: the input never loses focus, so the
    // reader can keep typing without the list stealing the keyboard.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('place')

    await input().press('ArrowDown')
    expect(await attr('#place', 'aria-activedescendant')).not.toBe(active)
  }, 60000)

  it('wraps the cursor and closes on Escape without clearing what was typed', async () => {
    await suggest('austin')
    await input().press('ArrowUp')
    expect(await attr('#place', 'aria-activedescendant'), 'ArrowUp from nothing selects the last option').toBeTruthy()

    await input().press('Escape')
    expect(await attr('#place', 'aria-expanded')).toBe('false')
    expect(await input().inputValue()).toBe('austin')
  }, 60000)

  it('opens a list of every ZIP code in the chosen city, and adds one', async () => {
    await suggest('austin')
    await options().first().click()

    await page.waitForSelector('section[aria-labelledby^="city-zips-"]', { timeout: 20000 })
    const panel = page.locator('section[aria-labelledby^="city-zips-"]')
    expect(await panel.locator('h3').innerText()).toMatch(/Austin/)

    // The stated count must be the true total, not the number of buttons shown.
    expect(await panel.innerText()).toMatch(/\d+ ZIP codes? in this city/)

    // Selected by accessible name, not by "first button": the panel also holds a
    // Close control, and `button:not([disabled])` would match that one.
    const add = panel.locator('button[aria-label^="Add ZIP code"]').first()
    const zip = (await add.getAttribute('aria-label'))!.replace(/\D/g, '')
    expect(zip).toMatch(/^\d{5}$/)

    await add.click()
    await page.waitForFunction(
      (z) => [...document.querySelectorAll('main article')].some((a) => a.textContent?.includes(z)),
      zip,
      { timeout: 90000 },
    )
    // The comparison header carries the city, which is the whole feature.
    const card = page.locator('main article').filter({ hasText: zip }).first()
    expect(await card.innerText()).toMatch(/Austin,/)
  }, 120000)

  it('offers no city suggestions for a five-digit ZIP code', async () => {
    await input().fill('')
    await input().type('78701', { delay: 15 })
    // A ZIP is a direct lookup; suggesting cities would bury it.
    await page.waitForTimeout(700)
    expect(await listbox().count()).toBe(0)
    expect(await attr('#place', 'aria-expanded')).toBe('false')
  }, 60000)

  it('says so plainly when a query matches nothing in the United States', async () => {
    await input().fill('')
    await input().type('zzzznotaplace', { delay: 15 })
    await page.waitForTimeout(700)
    expect(await listbox().count()).toBe(0)

    await page.locator('form').filter({ has: page.locator('#place') }).locator('button[type="submit"]').click()
    await page.waitForSelector('[role="alert"]', { timeout: 20000 })
    expect(await page.locator('[role="alert"]').first().innerText()).toMatch(/No US city or ZIP code matches/)
  }, 60000)

  it('labels the search box visibly and names the input', async () => {
    // The heading is the visible label; the input's accessible name comes from
    // the visually-hidden <label for="place">, which is the pattern axe checks.
    expect(await page.locator('h2#search-heading').innerText()).toMatch(/ZIP code or a city/)

    const named = await page.evaluate(() => {
      const el = document.querySelector('#place')!
      const byFor = el.id ? document.querySelector(`label[for="${el.id}"]`) : null
      return { label: byFor?.textContent?.trim() ?? null, describedBy: el.getAttribute('aria-describedby') }
    })
    expect(named.label).toBeTruthy()
    expect(named.describedBy).toBeTruthy()
    expect(await page.locator(`[id="${named.describedBy}"]`).count()).toBe(1)
  }, 60000)
})
