/**
 * The donation route, pinned.
 *
 * This exists because the funding section previously had no route at all: it was
 * built around an Open Collective slug that was never set, and the gate caught
 * that only by pattern-matching the word "opencollective" in the source. A check
 * that passes on the word rather than on a working link is satisfied by a dead
 * one, which is the shape of claim this repository keeps refusing to make.
 *
 * So the routes are asserted as data: three, https, on the three expected hosts,
 * each with the attributes a new-tab payment link needs to be safe.
 */
import { describe, expect, it } from 'vitest'

import { DONATION_ROUTES } from '../src/ui/Funding'

const EXPECTED_HOSTS = ['paypal.me', 'venmo.com', 'cash.app']

describe('donation route', () => {
  it('offers exactly the three routes the author uses elsewhere', () => {
    // Same links as Treystu/Omada-Logger-Viz. If these ever change, they should
    // change in both places deliberately rather than drifting apart silently.
    expect(DONATION_ROUTES.map((r) => r.href)).toEqual([
      'https://www.paypal.me/LBallek',
      'https://venmo.com/u/lucas-ballek',
      'https://cash.app/$luball',
    ])
  })

  it('has no duplicate or empty href', () => {
    const hrefs = DONATION_ROUTES.map((r) => r.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    for (const href of hrefs) {
      expect(href.trim().length).toBeGreaterThan(0)
      expect(() => new URL(href)).not.toThrow()
    }
  })

  it('is https on the expected hosts, so no route is a plaintext or off-domain link', () => {
    for (const route of DONATION_ROUTES) {
      const url = new URL(route.href)
      expect(url.protocol, route.href).toBe('https:')
      expect(EXPECTED_HOSTS, route.href).toContain(url.hostname.replace(/^www\./, ''))
    }
  })

  it('labels every route, because an unlabelled link is not a usable payment route', () => {
    for (const route of DONATION_ROUTES) {
      expect(route.label.trim().length).toBeGreaterThan(0)
    }
  })
})