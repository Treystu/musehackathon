/**
 * Does the map actually draw?
 *
 * Unit tests prove the arithmetic. Only a real browser proves the canvas
 * rendered something, that the shapes are in the right places, and that a
 * visitor can read a figure off it. A blank or misprojected map would pass
 * every test in map-data.test.ts.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hexbin, hexRadius } from '../core/map/binning'
import { decodeCentroids } from '../core/map/centroids'
import { fitBase, projectAll, screenTransform } from '../core/map/projection'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
const KEY = process.env.CENSUS_KEY

let browser: Browser
let page: Page

/** Waits for the sweep to have produced a usable number of rows. */
async function waitForRows(timeoutMs = 300000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const n = await page.locator('table tbody tr').count()
    if (n > 20) return n
    await page.waitForTimeout(2000)
  }
  return page.locator('table tbody tr').count()
}

beforeAll(async () => {
  browser = await chromium.launch()
  page = await browser.newPage()
  const res = await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => null)
  if (!res || res.status() >= 400) throw new Error(`unreachable: ${BASE}`)
  if (KEY) await page.evaluate((k) => localStorage.setItem('civicscope.censusKey.v1', k), KEY)
}, 120000)

afterAll(async () => {
  await browser?.close()
})

const mapAsset = readFileSync(join(process.cwd(), 'public', 'map', 'zcta-centroids.bin'))
const mapFixture = decodeCentroids(
  mapAsset.buffer.slice(mapAsset.byteOffset, mapAsset.byteOffset + mapAsset.byteLength),
)
const puertoRicoZips = new Set(
  mapFixture
    .filter((point) => point.lon >= -67.35 && point.lon <= -65.55 && point.lat >= 17.85 && point.lat <= 18.55)
    .map((point) => point.zcta),
)

function puertoRicoCell(width: number) {
  const fit = fitBase(mapFixture)
  const projected = projectAll(fit, mapFixture)
  const viewport = { width, height: 560, scale: 1, offsetX: 0, offsetY: 0 }
  const { s, ox, oy } = screenTransform(viewport)
  const radius = hexRadius(viewport.scale)
  const pad = radius * 2
  const inputs = mapFixture.flatMap((point, index) => {
    if (!projected.ok[index]) return []
    const x = projected.xs[index]! * s + ox
    const y = projected.ys[index]! * s + oy
    if (x < -pad || x > width + pad || y < -pad || y > viewport.height + pad) return []
    return [{ x, y, value: puertoRicoZips.has(point.zcta) ? 30 : Number.NaN, zctas: [point.zcta] }]
  })

  const cell = hexbin(inputs, radius).find((bin) => bin.zctas.some((zip) => puertoRicoZips.has(zip)))
  if (!cell) throw new Error('The committed map fixture has no visible Puerto Rico cell.')
  return cell
}

describe.skipIf(!KEY)('the map view', () => {
  it('draws hexagons across the country rather than a blank canvas', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForRows()
    await page.click('nav[aria-label="Primary"] button:has-text("Map")')
    await page.waitForSelector('canvas', { timeout: 60000 })
    // The centroid fetch and the first paint are not instantaneous.
    await page.waitForTimeout(4000)

    const painted = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      if (!canvas) return { pixels: 0, colours: new Set<string>().size }
      const ctx = canvas.getContext('2d')!
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const colours = new Set<string>()
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue
        colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`)
      }
      return { pixels: colours.size, colours: colours.size }
    })

    // More than a handful of distinct colours means the ramp is actually being
    // applied across many bins, not one flat fill.
    expect(painted.colours, 'the canvas is blank or a single flat colour').toBeGreaterThan(3)
  }, 400000)

  it('publishes an equivalent of the map as text', async () => {
    // A canvas has no accessibility tree. If this text is missing, a screen
    // reader user gets silence from the map and only the table.
    const text = await page.locator('[role="status"][aria-live="polite"]').allInnerTexts()
    const combined = text.join(' ')
    expect(combined, 'no text equivalent for the map').toMatch(/map shows/i)
    expect(combined).toMatch(/screening table/i)
  }, 120000)

  it('names every legend step in text, not only in colour', async () => {
    const legend = await page.locator('#\\:r0\\:-legend, [id$="legend"]').first().innerText().catch(() => '')
    const body = legend || (await page.locator('body').innerText())
    expect(body, 'the legend does not state real values').toMatch(/to the highest|to \$/)
    // The absent category must be named, so "no data" is never just a colour.
    expect(body).toMatch(/no valid data available here/)
  }, 120000)

  it('carries the Fair Housing notice on the map surface', async () => {
    // A colour-coded housing map is exactly what the notice is for, so its
    // presence cannot be limited to the table view.
    const body = await page.locator('body').innerText()
    expect(body).toMatch(/steering/i)
    expect(body).toMatch(/hud\.gov|Department of Housing/i)
  }, 120000)

  it('pans and zooms from the keyboard', async () => {
    const before = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement
      return c.toDataURL().length
    })
    await page.focus('canvas')
    await page.keyboard.press('Equal')
    await page.waitForTimeout(600)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)
    const after = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement
      return c.toDataURL().length
    })
    // A different image length means the canvas repainted, which is the only
    // evidence available that the keyboard handlers fired.
    expect(after, 'the canvas did not change after zooming and panning').not.toBe(before)
  }, 120000)

  it('shows no sentinel or negative figure anywhere on the map', async () => {
    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(/-?\s?\$?\s?(666666666|999999999|888888888)\b/)
  }, 120000)
})

describe('e2e: map pointer cancellation', () => {
  it('allows a ZIP cell to be selected after a cancelled drag', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    try {
      await context.addInitScript((key) => localStorage.setItem('civicscope.censusKey.v1', key), 'map-fixture-key')
      const mapPage = await context.newPage()
      const fixtureUrl = new URL(BASE)
      await mapPage.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === fixtureUrl.origin) {
          await route.continue()
          return
        }

        if (url.hostname === 'tigerweb.geo.census.gov') {
          const isEnumeration =
            url.pathname.endsWith('/MapServer/2/query') && url.searchParams.get('outFields') === 'ZCTA5'
          const features = isEnumeration && url.searchParams.get('where')?.includes("'00000'")
            ? [...puertoRicoZips].map((zcta) => ({ attributes: { ZCTA5: zcta } }))
            : []
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ features }),
          })
          return
        }

        if (url.hostname === 'api.census.gov') {
          const variables = (url.searchParams.get('get') ?? 'NAME').split(',')
          const requested = url.searchParams.get('for')?.split(':')[1]?.split(',') ?? [...puertoRicoZips]
          const rows = requested
            .filter((zcta) => puertoRicoZips.has(zcta))
            .map((zcta) => variables.map((variable) =>
              variable === 'NAME' ? `ZCTA5 ${zcta}` : variable.endsWith('M') ? '2' : '30',
            ))
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([variables, ...rows]),
          })
          return
        }

        if (url.hostname === 'nominatim.openstreetmap.org') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
          return
        }

        await route.abort()
      })

      await mapPage.goto(BASE, { waitUntil: 'domcontentloaded' })
      await mapPage.locator('#main').waitFor({ state: 'visible' })
      expect(await mapPage.evaluate(() => localStorage.getItem('civicscope.censusKey.v1'))).toBe('map-fixture-key')
      const tourDismiss = mapPage.getByRole('button', { name: 'Not now', exact: true })
      if (await tourDismiss.count()) await tourDismiss.click()
      await mapPage.getByRole('heading', { name: 'Screen every ZIP code', exact: true }).waitFor({
        state: 'visible',
        timeout: 60000,
      })
      await mapPage.getByRole('button', { name: 'Map', exact: true }).click()

      const canvas = mapPage.locator('canvas')
      await canvas.waitFor({ state: 'visible', timeout: 60000 })
      await mapPage.waitForFunction(() => {
        const map = document.querySelector('canvas')
        return map !== null && map.toDataURL().length > 1000
      }, undefined, { timeout: 60000 })

      await canvas.scrollIntoViewIfNeeded()
      const initialBox = await canvas.boundingBox()
      if (!initialBox) throw new Error('The map canvas has no visible bounds.')
      const initialCell = puertoRicoCell(Math.round(initialBox.width))
      const initialX = initialBox.x + initialCell.cx
      const initialY = initialBox.y + initialCell.cy
      const tooltip = canvas.locator('xpath=..').locator('div.z-10')
      const hoverLabel = initialCell.count === 1 ? initialCell.zctas[0]! : `${initialCell.count} ZIP codes`
      await mapPage.mouse.move(initialX, initialY)
      await tooltip.waitFor({ state: 'visible', timeout: 5000 })
      expect(await tooltip.innerText()).toContain(hoverLabel)
      await mapPage.mouse.click(initialX, initialY)
      await mapPage.locator('#comparison-heading').waitFor({ state: 'visible', timeout: 5000 })
      await mapPage.getByRole('button', { name: 'Explain the selected map figures' }).waitFor({ timeout: 5000 })
      for (let index = 0; index < initialCell.zctas.length; index += 1) {
        await mapPage.getByRole('button', { name: 'Remove', exact: true }).first().click()
      }
      await mapPage.locator('#comparison-heading').waitFor({ state: 'hidden', timeout: 5000 })

      await canvas.scrollIntoViewIfNeeded()
      const box = await canvas.boundingBox()
      if (!box) throw new Error('The map canvas has no visible bounds after clearing the comparison.')
      const cell = puertoRicoCell(Math.round(box.width))
      const targetX = box.x + cell.cx
      const targetY = box.y + cell.cy
      const startX = box.x + box.width / 2
      const startY = box.y + box.height / 2
      await canvas.evaluate((map) => {
        ;(window as Window & { mapPointerId?: number }).mapPointerId = undefined
        ;(window as Window & { mapPointerMoves?: Array<{ pointerId: number; x: number; y: number }> }).mapPointerMoves = []
        ;(window as Window & { mapCanvasClicks?: number }).mapCanvasClicks = 0
        map.addEventListener('pointerdown', (event) => {
          const pointerEvent = event as PointerEvent
          ;(window as Window & { mapPointerId?: number }).mapPointerId = pointerEvent.pointerId
        }, { once: true })
        map.addEventListener('pointermove', (event) => {
          const pointerEvent = event as PointerEvent
          ;(window as Window & { mapPointerMoves?: Array<{ pointerId: number; x: number; y: number }> })
            .mapPointerMoves?.push({ pointerId: pointerEvent.pointerId, x: pointerEvent.clientX, y: pointerEvent.clientY })
        })
        map.addEventListener('click', () => {
          const target = window as Window & { mapCanvasClicks?: number }
          target.mapCanvasClicks = (target.mapCanvasClicks ?? 0) + 1
        })
      })
      await mapPage.mouse.move(startX, startY)
      await mapPage.mouse.down()
      await mapPage.mouse.move(startX + 24, startY + 12, { steps: 2 })

      const pointerId = await mapPage.evaluate(() =>
        (window as Window & { mapPointerId?: number }).mapPointerId,
      )
      expect(pointerId, 'the browser delivered the drag pointer').toBeDefined()
      const pointerMoves = await mapPage.evaluate(() =>
        (window as Window & { mapPointerMoves?: Array<{ pointerId: number; x: number; y: number }> })
          .mapPointerMoves ?? [],
      )
      expect(pointerMoves.some((move) => move.pointerId === pointerId && move.x >= startX + 4),
        'the browser delivered movement beyond the map drag threshold').toBe(true)
      await canvas.evaluate((map, id) => {
        map.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: id }))
        if (map.hasPointerCapture(id)) map.releasePointerCapture(id)
      }, pointerId)
      const pan = pointerMoves[pointerMoves.length - 1]!
      const panX = pan.x - startX
      const panY = pan.y - startY
      await mapPage.mouse.move(2, 2)
      await mapPage.mouse.up()
      expect(await mapPage.evaluate(() =>
        (window as Window & { mapCanvasClicks?: number }).mapCanvasClicks,
      ), 'ending the cancelled pointer off-canvas must not generate a map click').toBe(0)

      await mapPage.mouse.move(targetX + panX, targetY + panY)
      await tooltip.waitFor({ state: 'visible', timeout: 5000 })
      expect(await tooltip.innerText()).toMatch(/\d+ ZIP codes/)
      await mapPage.mouse.click(targetX + panX, targetY + panY)
      await mapPage.locator('#comparison-heading').waitFor({ state: 'visible', timeout: 5000 })
      expect(await mapPage.locator('#comparison-heading').innerText()).toMatch(/^Comparing [1-6] areas?$/)
    } finally {
      await context.close()
    }
  }, 120000)
})
