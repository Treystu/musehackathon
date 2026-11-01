/**
 * What the app holds, against what the publisher says — on every CI run.
 *
 * The full audit in `tools/audit-all-data.mjs` compares all 33,772 areas and
 * finds zero defects, but it takes long enough that it is a release check
 * rather than a per-commit one. This is the version CI runs.
 *
 * The distinction that matters: a semantic review cannot catch a wrong number.
 * Nothing an LLM reads can tell whether 271,000 is the right median home value
 * or the wrong column. What catches it is comparing the figure against the
 * source, cell by cell, which is what this does.
 *
 * The sample is taken by taking every Nth ZCTA from the real national list, so
 * it is spread across the whole country rather than clustered at the
 * low-numbered end. A mis-mapped variable, a leaked sentinel, a percentage
 * parsed as a currency, a swapped column — every one of those is systematic and
 * shows up immediately at this sample size. A single wrong row would not, and
 * that is what the full audit is for.
 */
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173'
const KEY = process.env.CENSUS_KEY

/**
 * Every figure the nationwide screen fetches — all fifteen, since the v6/v7
 * figure set. Must equal SCREEN_VARS in src/core/plugins/acs.ts, and the gate
 * checks that it does. Until 2026-10-09 this compared only the five cost
 * columns, which meant ten fetched figures were displayed to users and
 * verified against the publisher by nobody; extending the map extended the
 * audit to everything the app claims.
 *
 * Margins are compared for the five medians the sweep carries margins for; the
 * ten context figures are fetched estimate-only by the screen (their margins
 * are drilldown-only), so there is nothing to compare and the audit says so
 * rather than inventing a column.
 */
const COLUMNS: Record<string, { est: string; moe?: string }> = {
  median_gross_rent: { est: 'B25064_001E', moe: 'B25064_001M' },
  median_rent_burden_pct: { est: 'B25071_001E', moe: 'B25071_001M' },
  median_home_value: { est: 'B25077_001E', moe: 'B25077_001M' },
  median_household_income: { est: 'B19013_001E', moe: 'B19013_001M' },
  households: { est: 'B25002_002E', moe: 'B25002_002M' },
  population: { est: 'B01003_001E' },
  owner_occupied: { est: 'B25003_002E' },
  renter_occupied: { est: 'B25003_003E' },
  vacant_units: { est: 'B25002_003E' },
  no_internet_access: { est: 'B28002_013E' },
  average_household_size: { est: 'B25010_001E' },
  median_age: { est: 'B01002_001E' },
  below_poverty_count: { est: 'B17001_002E' },
  bachelors_count: { est: 'B15003_022E' },
  commuting_workers: { est: 'B08303_001E' },
}

/*
 * Must equal ACS_SENTINELS in src/core/plugins/acs.ts — all five of them.
 *
 * -333333333 and -222222222 appear only on margin columns, which is exactly why
 * nothing caught them until an audit compared margins. The version of this set
 * that shipped with margin comparison yesterday carried only the three estimate
 * encodings, so ZCTA 01540's not-applicable rent-burden margin read as a real
 * number and the audit condemned the app for correctly showing no margin — a
 * phantom defect in the audit, not a wrong figure in the app. An audit that has
 * not been taught what a missing value looks like will condemn the code for
 * handling one, and this file's own history now records it twice.
 */
const SENTINELS = new Set([
  666666666,
  -666666666,
  999999999,
  -999999999,
  888888888,
  -888888888,
  333333333,
  -333333333,
  222222222,
  -222222222,
])

/** How many ZCTAs to compare. Two chunks keeps CI honest and affordable. */
const SAMPLE_SIZE = 1600

interface AppRow {
  zcta: string
  metrics: Record<string, number | null>
  moes: Record<string, number | null>
}

async function readAppRows(base: string): Promise<AppRow[]> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.evaluate((k) => localStorage.setItem('civicscope.censusKey.v1', k), KEY!)
    // A fresh sweep, so the comparison is against this build's own output rather
    // than something an earlier build left behind.
    await page.evaluate(() => indexedDB.deleteDatabase('civicscope-cache'))
    await page.reload({ waitUntil: 'domcontentloaded' })

    let loaded = 0
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(5000)
      const text = await page.locator('body').innerText()
      // Completion is announced by this sentence; the "N of 43" progress line is
      // *replaced* when the last chunk lands, so waiting for it never matches.
      const m = /Loaded ([\d,]+) ZIP codes/.exec(text)
      if (m?.[1]) {
        loaded = Number(m[1].replace(/,/g, ''))
        break
      }
    }
    expect(loaded, 'the country-wide sweep did not finish').toBeGreaterThan(33000)

    return await page.evaluate(
      () =>
        new Promise<AppRow[]>((resolve) => {
          const open = indexedDB.open('civicscope-cache', 2)
          open.onerror = () => resolve([])
          open.onsuccess = () => {
            const tx = open.result.transaction('sweep-chunks', 'readonly')
            const all = tx.objectStore('sweep-chunks').getAll()
            all.onerror = () => resolve([])
            all.onsuccess = () => {
              const rows: AppRow[] = []
              for (const rec of all.result ?? []) for (const r of rec.body ?? []) rows.push(r)
              resolve(rows)
            }
          }
        }),
    )
  } finally {
    await browser.close()
  }
}

describe.skipIf(!KEY)('what the app shows is what the Census Bureau says', () => {
  let appRows: AppRow[] = []
  let sample: string[] = []
  let compared = 0
  const defects: string[] = []
  let sentinelValuesMet = 0

  it('sweeps the country in a real browser', async () => {
    appRows = await readAppRows(BASE)
    // The Census Bureau publishes 33,791 ZCTAs; every one of them is on the
    // table, including those with no ACS coverage, which read as absent.
    expect(appRows.length).toBeGreaterThan(33000)
  }, 900000)

  it('agrees with the publisher, cell by cell, across the country', async () => {
    const all = appRows.map((r) => r.zcta).sort()
    const step = Math.max(1, Math.floor(all.length / SAMPLE_SIZE))
    sample = all.filter((_, i) => i % step === 0)
    expect(sample.length).toBeGreaterThan(500)

    const vars = Object.values(COLUMNS)
      .flatMap((c) => [c.est, c.moe].filter(Boolean))
      .join(',')
    for (let i = 0; i < sample.length; i += 800) {
      const part = sample.slice(i, i + 800)
      const url =
        `https://api.census.gov/data/2023/acs/acs5?get=NAME,${vars}` +
        `&for=${encodeURIComponent(`zip code tabulation area:${part.join(',')}`)}&key=${KEY}`
      let body: unknown
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(url)
          body = JSON.parse(await res.text())
          break
        } catch {
          if (attempt === 3) throw new Error(`Census did not answer for offset ${i}`)
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      }
      const parsed = body as { error?: unknown } | unknown[]
      expect((parsed as { error?: unknown }).error, `Census returned an error body at offset ${i}`).toBeUndefined()

      const head = (parsed as unknown[])[0] as string[]
      for (const raw of (parsed as unknown[]).slice(1) as unknown[][]) {
        const o = Object.fromEntries(head.map((k, idx) => [k, raw[idx]]))
        const zcta = String(o['zip code tabulation area'] ?? '').padStart(5, '0')
        const app = appRows.find((r) => r.zcta === zcta)
        expect(app, `the app does not hold ${zcta}`).toBeDefined()

        for (const [metric, col] of Object.entries(COLUMNS)) {
          const rawEst = o[col.est]
          let truth: number | null = null
          if (rawEst !== undefined && rawEst !== null && rawEst !== '') {
            const n = Number(rawEst)
            if (SENTINELS.has(n)) {
              sentinelValuesMet++
              truth = null
            } else if (Number.isFinite(n)) truth = n
          }
          compared++
          const shown = app!.metrics?.[metric] ?? null
          if (truth === null) {
            // A missing-data encoding must never become a figure.
            if (shown !== null) defects.push(`${zcta} ${metric}: app shows ${shown}, API has none`)
            continue
          }
          if (shown === null) {
            defects.push(`${zcta} ${metric}: API has ${truth}, app shows not yet imported`)
            continue
          }
          if (Math.abs(shown - truth) > Math.max(0.01, Math.abs(truth) * 1e-9)) {
            defects.push(`${zcta} ${metric}: app ${shown} vs API ${truth} (from ${col.est})`)
          }

          /*
           * The margin, compared where the sweep carries one. The screen fetches
           * margins only for the five medians; the ten context figures are
           * estimate-only on the screen, so there is no app margin to hold
           * against the publisher and the audit says so rather than reporting
           * thousands of phantom "dropped margin" defects for a column the
           * screen never claimed — the exact mistake this file's own history
           * records once making in the other direction.
           */
          if (col.moe) {
            const rawMoe = o[col.moe]
            let truthMoe: number | null = null
            if (rawMoe !== undefined && rawMoe !== null && rawMoe !== '') {
              const mn = Number(rawMoe)
              if (SENTINELS.has(mn)) truthMoe = null
              else if (Number.isFinite(mn)) truthMoe = mn
            }
            const shownMoe = app!.moes?.[metric] ?? null
            if (truthMoe !== null && shownMoe === null) {
              defects.push(`${zcta} ${metric}: API margin +/-${truthMoe}, app shows none`)
            } else if (truthMoe === null && shownMoe !== null) {
              defects.push(`${zcta} ${metric}: app margin +/-${shownMoe}, API has none`)
            } else if (truthMoe !== null && shownMoe !== null) {
              if (Math.abs(shownMoe - truthMoe) > Math.max(0.01, Math.abs(truthMoe) * 1e-9)) {
                defects.push(`${zcta} ${metric} margin: app ${shownMoe} vs API ${truthMoe}`)
              }
            }
          }
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }, 600000)

  it('found no figure the publisher does not agree with', () => {
    // Printed whether or not it passes, because a silent change in `compared`
    // would otherwise make this look like the same coverage it used to be.
    console.log(
      `    compared ${compared} cells across ${sample.length} ZIP codes; met ${sentinelValuesMet} missing-data encodings; ${defects.length} defects`,
    )
    expect(defects.slice(0, 12).join('\n'), 'figures disagree with the publisher').toBe('')
    expect(defects).toHaveLength(0)
    expect(compared).toBeGreaterThan(1000)
  })

  it('never shows a negative figure, which no estimate here can be', () => {
    let negatives = 0
    for (const row of appRows) {
      for (const v of Object.values(row.metrics ?? {})) {
        if (typeof v === 'number' && v < 0) negatives++
      }
    }
    expect(negatives).toBe(0)
  })
})
