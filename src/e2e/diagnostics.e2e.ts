/**
 * F7 diagnostics on a served build.
 *
 * The unit tests prove the builder cannot carry injected text; this test proves
 * the shipped bundle, the real Functions routes, and the browser download path
 * agree with that. Markers are planted in the two places a careless exporter
 * would reach for — the visitor's Meta key slot and the Ask field — and the
 * downloaded artifact is read back and searched.
 *
 * Requires a served build. With `wrangler pages dev` the diagnostics route is
 * present; on a static host the artifact honestly reports it unavailable.
 */
import { readFileSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
const SENTINEL = process.env.DIAG_SENTINEL ?? ''
const KEY_MARKER = 'SENTINEL-key-marker-never-export'

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch()
  page = await browser.newPage()
  const response = await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => null)
  if (!response || response.status() >= 400) {
    throw new Error(`diagnostics target is unreachable at ${BASE}. Serve a build first.`)
  }
})

afterAll(async () => {
  await browser?.close()
})

it('downloads observed diagnostics without the key or the question', async () => {
  const queryMarker = `SENTINEL question ${Date.now()}`
  await page.getByLabel('Ask in plain language').fill(queryMarker)
  await page.evaluate((marker) => {
    localStorage.setItem('civicscope.metaKey.v1', marker)
  }, KEY_MARKER)

  await page.getByRole('button', { name: 'Methodology', exact: true }).click()
  await page.getByRole('heading', { name: 'Diagnostics' }).waitFor()
  expect(await page.getByText(/stay in this browser/).count()).toBeGreaterThan(0)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download diagnostics' }).click(),
  ])
  const artifactPath = await download.path()
  expect(artifactPath).toBeTruthy()
  const text = readFileSync(artifactPath as string, 'utf8')

  // Neither marker may appear, and a configured test key must not either.
  expect(text).not.toContain(queryMarker)
  expect(text).not.toContain(KEY_MARKER)
  if (SENTINEL) expect(text).not.toContain(SENTINEL)

  const artifact = JSON.parse(text)
  expect(artifact.schema).toBe('civicscope.diagnostics.v1')
  expect(Number.isNaN(Date.parse(artifact.generatedAt))).toBe(false)
  expect(artifact.origin).toBe(new URL(BASE).origin)
  // A static host has no Functions and must say so; a served Functions build
  // must report. Either is honest, but the artifact may not invent the other.
  expect(['reported', 'unavailable']).toContain(artifact.server.outcome)
  expect(Array.isArray(artifact.unknowns)).toBe(true)
  expect(typeof artifact.local.withholds.invented_numeral).toBe('number')

  if (artifact.server.outcome === 'reported') {
    expect(typeof artifact.server.sharedKeyPresent).toBe('boolean')
    expect(artifact.unknowns).not.toContain('server-diagnostics-unavailable')
    // The probe shape is accepted by the route and rejected by its validator,
    // so a keyed deployment reports refused_shape and a keyless one no_shared_key.
    const expected = artifact.server.sharedKeyPresent ? 'refused_shape' : 'no_shared_key'
    expect(artifact.routes.intent).toEqual({
      status: artifact.routes.intent.status,
      outcome: expected,
    })
    expect(artifact.routes.explain).toEqual({
      status: artifact.routes.explain.status,
      outcome: expected,
    })
  } else {
    expect(artifact.server.sharedKeyPresent).toBeNull()
    expect(artifact.server.requests).toBeNull()
    expect(artifact.unknowns).toContain('server-diagnostics-unavailable')
    expect(artifact.unknowns).toContain('shared-key-state-unknown')
  }

  console.log(
    'diagnostics e2e:',
    JSON.stringify({
      origin: artifact.origin,
      server: artifact.server.outcome,
      sharedKeyPresent: artifact.server.sharedKeyPresent,
      commit: artifact.server.deployment.commit,
      intent: artifact.routes.intent,
      explain: artifact.routes.explain,
      unknowns: artifact.unknowns,
    }),
  )
})
