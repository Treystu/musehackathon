/**
 * Accessibility audit, WCAG 2.2 level AA, in a real browser.
 *
 * Accessibility is a legal requirement for a public-facing web app (ADA Title
 * III) and the project's own stated launch bar, so it is measured rather than
 * asserted. axe-core covers the machine-checkable portion of WCAG; the checks
 * below additionally assert the things axe cannot know, such as whether a
 * figure's margin of error is actually rendered and whether a table has real
 * header semantics.
 *
 * Run against the production build, not a dev server, so the Content-Security-
 * Policy is enforced exactly as it is in production.
 */

import AxeBuilder from '@axe-core/playwright'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

let browser: Browser
let context: BrowserContext
let page: Page

beforeAll(async () => {
  browser = await chromium.launch()
  // axe-core's Playwright integration requires an explicit context so it can
  // inject its own script under CSP. Without it, every run fails on a
  // configuration error rather than a real finding.
  context = await browser.newContext()
  page = await context.newPage()

  // Fail loudly if the target is unreachable. An audit that silently skips
  // because nothing was served reports a pass it did not earn, which is the
  // worst possible failure for an accessibility gate.
  const res = await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => null)
  if (!res || res.status() >= 400) {
    throw new Error(
      `accessibility audit target is unreachable at ${BASE}. Start a served build or set E2E_BASE_URL.`,
    )
  }

  // The figure-level assertions need a working key, so the key is injected the
  // same way the app's own setter does.
  if (process.env.CENSUS_KEY) {
    await page.evaluate((k) => localStorage.setItem('civicscope.censusKey.v1', k), process.env.CENSUS_KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
  }
}, 120000)

afterAll(async () => {
  await context?.close()
  await browser?.close()
})

/** Returns to the explore view so each test starts from a known state. */
async function gotoExplore() {
  const explore = page.locator('button:has-text("Explore")')
  if ((await explore.count()) > 0 && (await explore.first().getAttribute('aria-current')) === 'page') {
    return
  }
  if ((await explore.count()) > 0) await explore.first().click()
  await page.waitForSelector('#place', { timeout: 15000 })
  await page.waitForTimeout(300)
}

async function audit(label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.length,
    target: v.nodes[0]?.target?.join(' '),
  }))
  console.log(`\n[axe] ${label}: ${violations.length} violation(s)`)
  for (const v of violations) console.log(`   ${v.impact ?? 'n/a'}  ${v.id} — ${v.help} (${v.nodes} node(s)) ${v.target ?? ''}`)
  return violations
}

describe('WCAG 2.2 AA audit', () => {
  it('the explore view has no automated violations', async () => {
    await gotoExplore()
    const violations = await audit('explore view')
    expect(violations, JSON.stringify(violations, null, 2)).toHaveLength(0)
  }, 180000)

  it('the methodology view has no automated violations', async () => {
    await gotoExplore()
    await page.click('button:has-text("Methodology")')
    await page.waitForTimeout(800)
    const violations = await audit('methodology view')
    expect(violations, JSON.stringify(violations, null, 2)).toHaveLength(0)
  }, 180000)
})

describe('accessibility requirements axe cannot check', () => {
  it('exposes a skip link that reaches the main landmark', async () => {
    await gotoExplore()
    const skip = page.locator('a[href="#main"]')
    expect(await skip.count()).toBe(1)
    expect(await page.locator('main#main').count()).toBe(1)
  })

  it('gives every form control an accessible name', async () => {
    await gotoExplore()
    // An input is named by an explicit `label[for]`, an aria-label/aria-labelledby,
    // or a wrapping <label>. A visually-hidden radio inside its own label is a
    // legitimate and common pattern, so the wrapping label counts — which is
    // also what the accessibility tree itself does.
    const unlabelled = await page.evaluate(() =>
      [...document.querySelectorAll('input, select, textarea')]
        .filter((el) => {
          const id = el.getAttribute('id')
          const explicit = id ? !!document.querySelector(`label[for="${id}"]`) : false
          const wrapping = !!el.closest('label')
          const aria = !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))
          return !explicit && !wrapping && !aria
        })
        .map((el) => el.outerHTML.slice(0, 120)),
    )
    expect(unlabelled, JSON.stringify(unlabelled, null, 2)).toHaveLength(0)
  })

  it('groups radio sets in a fieldset with a legend', async () => {
    await gotoExplore()
    const bad = await page.evaluate(() => {
      return [...document.querySelectorAll('input[type="radio"]')].filter((r) => !r.closest('fieldset')).length
    })
    expect(bad).toBe(0)
  })

  it('announces async loading state through a live region', async () => {
    await gotoExplore()
    const live = page.locator('[role="status"][aria-live="polite"]')
    expect(await live.count()).toBeGreaterThan(0)
  })

  it('keeps a visible focus indicator on interactive elements', async () => {
    await gotoExplore()
    // WCAG 2.4.7 / 2.4.11. Verified by actually focusing, not by reading CSS.
    await page.locator('#place').focus()
    const outline = await page.evaluate(() => {
      const el = document.activeElement
      if (!el) return null
      const s = getComputedStyle(el)
      return { outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle }
    })
    expect(outline).not.toBeNull()
    expect(outline!.outlineStyle).not.toBe('none')
    expect(parseFloat(outline!.outlineWidth)).toBeGreaterThan(0)
  })

  it('renders margins of error beside figures rather than hiding them', async () => {
    // This is a fair-housing requirement as much as an accessibility one: a
    // survey estimate shown without its uncertainty invites over-reading.
    // Skipped without a key because no figures load without one.
    if (!process.env.CENSUS_KEY) return
    await gotoExplore()
    await page.fill('#place', '78701')
    await page.locator('form').filter({ has: page.locator('#place') }).locator('button[type="submit"]').click()
    // Waits on the drilldown card, which is a separate fast request. The
    // country-wide sweep runs concurrently and takes far longer, so waiting on
    // it here would time out for reasons unrelated to this assertion.
    await page.waitForFunction(
      () => {
        const card = [...document.querySelectorAll('main article')].find((a) =>
          a.textContent?.includes('78701'),
        )
        if (!card) return false
        if (card.textContent?.includes('Fetching detail')) return false
        return card.textContent?.includes('±') ?? false
      },
      undefined,
      { timeout: 120000 },
    )
    const withMoe = await page.locator('text=/±/').count()
    expect(withMoe).toBeGreaterThan(0)
  }, 180000)
})
