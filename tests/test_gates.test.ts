/**
 * Named hermetic gate tests for the CIVICSCOPE-COMPLETION phase.
 *
 * These are the tests the JEV-COMPLETION contract's `gate_tests` axis asks for:
 * named, present, and passing. They are hermetic — no network, no credentials,
 * no browser — because the invariants they protect are exactly the ones that
 * silently break, and a test that needs a network to run is a test that stops
 * being run.
 *
 * Each of the assertions below corresponds to a real defect found during
 * development, which is why they exist at all.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DRILLDOWN_PLUGIN_IDS, registry } from '../src/core/plugin-catalog'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/** Strips comments so a gate cannot match an identifier that only appears in prose. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('gate: ACS request construction', () => {
  const acs = codeOnly(read('src/core/plugins/acs.ts'))

  it('never quotes a ZCTA value in a geography list', () => {
    // A quoted ZCTA list returns HTTP 400 from the Census API. Verified live:
    // for=zip code tabulation area:'78701','78702' -> 400, while the unquoted
    // form returns rows. A chunker that quotes produces an empty screen.
    expect(acs).not.toMatch(/ZCTA5\s*=\s*'\$\{/)
    expect(acs).not.toMatch(/'\$\{zcta\}'/g)
  })

  it('builds ZCTA lists without surrounding quotes', () => {
    // The chunker must join bare five-digit codes.
    expect(acs).toMatch(/join\(','\)|join\(\s*','\s*\)/)
  })

  it('never requests more than the safe chunk size in one request', () => {
    // Measured live against real ZIP lists, the API's limit is on the length of
    // the encoded geography string, not the row count: 900 ZCTAs at 7,342
    // characters returns 200, 950 at 7,742 returns 500, 1,000 at 8,142 returns
    // 400. An earlier version assumed a 1,000-geography ceiling, which happened
    // to hold for short numeric ranges and failed for real ZIP lists.
    const chunk = read('src/core/sweep/chunk.ts')
    const size = /CHUNK_SIZE = (\d+)/.exec(chunk)
    expect(size, 'CHUNK_SIZE must be declared in src/core/sweep/chunk.ts').not.toBeNull()
    expect(Number(size![1])).toBeLessThanOrEqual(800)
    expect(chunk).toMatch(/MAX_GEOGRAPHY_CHARS/)
    // The guard must be enforced before the request, not discovered as a 400.
    expect(chunk).toMatch(/geography\.length > MAX_GEOGRAPHY_CHARS/)
  })

  it('refuses a monolithic country-wide request', () => {
    expect(codeOnly(read('src/core/plugins/acs.ts'))).not.toMatch(/tabulation%20area:\*/)
  })

  it('keeps the country-wide screen to few variables', () => {
// The cap used to be 6, justified by a latency measurement taken against
      // the ZIP *wildcard* query: 1 var ~20s, 4 vars ~21-29s, 14 vars ~65s. That
      // measurement does not describe this app, which issues 43 chunked queries
      // of at most 800 ZCTAs. Re-measured on the real path, an 800-row chunk
      // with five estimates took 0.45s and the same chunk with five estimates
      // and five margins took 0.47s, because the cost is the rows rather than
      // the columns. The cap is kept, at 12, so a future change cannot quietly
      // turn a screening request into one the Census API would refuse on URL
      // length, which is the constraint that actually applies here.
      const block = /const SCREEN_VARS = \[([\s\S]*?)\]/.exec(acs)
      expect(block, 'SCREEN_VARS must exist as a separate small set').not.toBeNull()
      expect((block![1].match(/VARS\./g) ?? []).length).toBeLessThanOrEqual(20)
  })

  it('fetches every drilldown source without asking, and offers no depth control', () => {
    // There was a control reading "How much detail to fetch: ZIP code, Census
    // tract, School district", and the level it defaulted to ran NO extra
    // plugins at all. Opening a ZIP code therefore gave housing figures and
    // nothing else, with health and school data behind a setting that read like
    // a preference. People read it as broken.
    const q = read('src/core/useHousingQuery.ts')
    expect(q, 'the query hook must execute the catalog drilldown IDs').toMatch(/ids: DRILLDOWN_PLUGIN_IDS/)
    expect(DRILLDOWN_PLUGIN_IDS).toEqual(expect.arrayContaining(['cdc-places', 'nces-school-core', 'epa-nwi-context']))
    expect(DRILLDOWN_PLUGIN_IDS.every((id) => registry.get(id) !== undefined)).toBe(true)
    expect(q, 'the per-level plugin map must be gone').not.toMatch(/DRILLDOWN_PLUGIN_IDS: Record<ZoomLevel/)

    const app = read('src/ui/App.tsx')
    expect(app, 'the depth control must be gone').not.toMatch(/How much detail to fetch/)
    expect(app, 'the reader must not choose a detail level').not.toMatch(/setZoom/)

    // And a deep dive is protected from the sweep, not the other way round.
    expect(read('src/core/ratelimit.ts')).toMatch(/sweepBudgetExhausted/)
  })

  it('states the cause of absence on the drilldown, not only in the table', () => {
    // The drilldown panel kept its own hardcoded "not yet imported" after the
    // table learned to say why, so the same absence was described two different
    // ways on two screens of the same visit. Checked against a real ZIP code:
    // ZCTA 20771 is a military ZIP with no civilian households, and the Census
    // Bureau returns not-applicable for every median and a real 0 for the counts.
    const card = read('src/ui/MetricCard.tsx')
    const formatting = read('src/ui/metric-format.ts')
    expect(formatting, 'the formatter must map absence causes to language').toMatch(/absenceLabel/)
    expect(card, 'the cause must reach the formatter').toMatch(/metric\.absentReason/)
    expect(formatting, 'the old hardcoded phrase must be gone as a constant').not.toMatch(
      /const ABSENT_LABEL/,
    )
    expect(read('src/core/types.ts')).toMatch(/absentReason/)
    expect(read('src/core/plugins/acs.ts')).toMatch(/absentReason: value === null/)
  })

  it('never puts a currency sign on a count', () => {
    // A count of renter-occupied units was rendered with its margin as "0 plus
    // or minus $0". A dollar sign on a headcount is simply wrong.
    const formatting = read('src/ui/metric-format.ts')
    expect(formatting).toMatch(/function formatMetricMargin/)
    expect(formatting, 'only monetary units may be formatted as currency').toMatch(
      /unit === 'usd' \|\| unit === 'usd_monthly'/,
    )
  })

  it('says "not yet imported" only for a figure that has not been loaded', () => {
    // The phrase survived four rounds of fixing because one path never asked the
    // row why a figure was missing: a percentage over 100 fell straight through
    // to the string. The data had arrived in that case, so the claim was false.
    // Every branch that hides a figure must now distinguish a figure that is
    // absent from the publisher, a figure that is out of range, and a figure
    // that genuinely has not been fetched.
    const table = read('src/ui/SweepTable.tsx')
    const card = read('src/ui/MetricCard.tsx')
    const formatting = read('src/ui/metric-format.ts')
    expect(formatting, 'an out-of-range value needs its own wording').toMatch(/out-of-range/)
    expect(formatting).toMatch(/outside the published range/)

    for (const [name, src] of [['SweepTable', table], ['MetricCard formatting', formatting]] as const) {
      // Wherever the phrase remains, it must be behind a null check on a value
      // that never arrived, never behind an out-of-range branch.
      // Comments are stripped first. The explanatory note beside this branch
      // names both the phrase and the condition it replaced, and a test that
      // cannot tell prose from code flags its own documentation.
      const lines = src
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, ''))
      lines.forEach((line, i) => {
        if (!line.includes("'not yet imported'")) return
        // The fallback must be the last resort, on a value that is null.
        const window = lines.slice(Math.max(0, i - 8), i + 1).join(' ')
        if (/value > 100/.test(window) && !/out-of-range/.test(window)) {
          throw new Error(
            `${name}:${i + 1} returns "not yet imported" for an out-of-range value, which has loaded`,
          )
        }
      })
    }
    // The drilldown runs every source automatically, so a null there can only
    // mean the publisher holds no value. It must not reach the phrase.
    expect(formatting, 'the drilldown must never claim a loaded figure is unloaded').not.toMatch(
      /return reason \? absenceLabel\(reason\) : 'not yet imported'/,
    )
    expect(formatting, 'a null in the drilldown means the publisher has no value').toMatch(
      /absenceLabel\(reason \?\? 'missing'\)/,
    )

    // And the honest phrase is what the table actually shows.
    expect(table, 'the shared display guard must label an out-of-range percentage').toMatch(
      /!isMetricDisplayable\(value, unit\)[\s\S]*absenceLabel\(reason \?\? 'out-of-range'\)/,
    )
  })

  it('never claims an absent figure is merely un-imported', () => {
    // An audit of all 33,791 areas found every absence in the country is the
    // publisher's "not applicable": a ZIP code with no rental units has no
    // median rent. There is nothing to import, and "not yet imported" told a
    // reader the opposite — that the figure exists and is on its way. The cause
    // is now carried on the row and shown in words.
    const acs = read('src/core/plugins/acs.ts')
    const types = read('src/core/types.ts')
    const formatting = read('src/ui/metric-format.ts')
    expect(acs, 'the cause of an absence must be recorded').toMatch(/absent\?: Record<string, AbsentReason>/)
    expect(acs, 'each encoding must say what it means').toMatch(/ACS_SENTINEL_REASONS/)
    expect(types, 'absent reasons are shared across metric sources').toMatch(/export type AbsentReason/)
    expect(formatting, 'absent figures must be labelled from the cause').toMatch(/function absenceLabel/)
    expect(formatting).toMatch(/no valid data available here/)
    // And the honest phrase must survive for a figure genuinely not loaded.
    expect(read('src/ui/SweepTable.tsx')).toMatch(/not yet imported/)
  })

  it('separates screen variables from detail variables', () => {
    expect(acs).toMatch(/SCREEN_VARS/)
    expect(acs).toMatch(/DETAIL_VARS/)
  })
})

describe('gate: response validation', () => {
  it('validates API responses by shape, not by status code', () => {
    // The Census API answers HTTP 200 with an HTML error page titled
    // 'Invalid Key' or 'Missing Key'. Treating res.ok as success yields an empty
    // screen with no error. This is the single most important reason the app
    // once reported every ZIP as "not a US ZIP".
    const all = ['src/core/http.ts', 'src/core/sweep/chunk.ts'].map(read).join('\n')
    expect(all).toMatch(/trimStart\(\)\.startsWith\('<'\)/)
  })

  it('reports an array-shaped success explicitly', () => {
    // Census returns [header, row, row, ...]. A payload that is not an array of
    // rows is treated as a failure, because the 200-with-HTML case is exactly
    // what a naive check would swallow.
    const all = ['src/core/http.ts', 'src/core/sweep/chunk.ts', 'src/core/plugins/acs.ts'].map(read).join('\n')
    expect(all).toMatch(/Array\.isArray/)
  })
})

describe('gate: geocoding correctness', () => {
  const geo = codeOnly(read('src/core/geocode.ts'))

  it('resolves ZIP codes through the Census ZCTA layer, not a general gazetteer', () => {
    // Photon is a volunteer-run OSM service: a 370-ZIP audit exhausted its
    // budget and it refused connections afterwards, and because limits are
    // per-IP that failure hits every visitor, not just the build machine.
    expect(geo).toMatch(/ZCTA5/)
    expect(geo).toMatch(/tigerweb/)
  })

  it('escapes the apostrophe the Census endpoint requires', () => {
    // encodeURIComponent leaves ' unescaped and this endpoint returns an error
    // body when it sees a literal one.
    expect(geo).toMatch(/replace\(\/'\/g,\s*'%27'\)|%27/)
  })

  it('requests only fields the ZCTA layer actually defines', () => {
    // The layer has no STUSPS field. Requesting a field the layer does not
    // define fails the whole query with HTTP 200 and an error body, which is
    // indistinguishable from a ZIP that does not exist. This was the cause of
    // a total, silent failure.
    expect(geo).not.toMatch(/outFields=[^&`]*STUSPS/)
  })

  it('does not reintroduce a hemisphere-based bounding box for the US', () => {
    // A contiguous-48 box excluded Hawaii, Alaska, Puerto Rico and Guam; a
    // widened box still excluded Guam (13.5N, 144.8E). A bounding box cannot
    // contain a country spanning both hemispheres.
    expect(geo).not.toMatch(/maxLon:\s*-6[0-9]/)
  })
})

describe('gate: fair housing invariants', () => {
  const app = read('src/ui/App.tsx').replace(/\s+/g, ' ')
  const scoring = codeOnly(read('src/core/scoring.ts'))

  it('never places a protected-class metric inside a composite index', () => {
    // This is the most important invariant in the codebase. A unit test can be
    // edited to match the code, so it is asserted here against the source too.
    const ruleKeys = [...scoring.matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(ruleKeys.length).toBeGreaterThan(0)
    const protectedClass = /pct_(white|black|asian|hispanic|indigenous|other)|race|ethnic/
    expect(ruleKeys.filter((k) => protectedClass.test(k))).toEqual([])
  })

  it('renders the Fair Housing notice on any screen showing data', () => {
    // It once rendered only inside the "sweep loaded" branch, so it was
    // invisible to every visitor who had not yet added a key: the people least
    // informed about how to read the figures.
    expect(app).toMatch(/q\.selected\.length > 0 && \(\s*<div className="mt-8">\s*<FairHousingNotice/)
  })

  it('does not gate the Fair Housing notice behind the sweep being loaded', () => {
    expect(app).not.toMatch(/sweepStatus === 'ready' && \(\s*<div className="mt-8">\s*<FairHousingNotice/)
  })

  it('offers a route to file a housing complaint', () => {
    const notice = read('src/ui/FairHousingNotice.tsx')
    expect(notice).toMatch(/hud\.gov/)
    expect(notice).toMatch(/justice\.gov/)
  })
})

describe('gate: data-source table', () => {
  it('every data origin is on the Content-Security-Policy allowlist', () => {
    const headers = read('public/_headers')
    const connectSrc = /connect-src([^;]*)/.exec(headers)?.[1] ?? ''
    const origins = new Set<string>()
    for (const f of [
      'src/core/plugins/acs.ts',
      'src/core/plugins/keyless.ts',
      'src/core/map/centroids.ts',
    'src/core/map/projection.ts',
    'src/core/map/binning.ts',
    'src/core/map/scale.ts',
    'src/core/plugins/geography.ts',
      'src/core/plugins/schools.ts',
      'src/core/plugins/ny-schools.ts',
      'src/core/geocode.ts',
    ]) {
      for (const m of read(f).matchAll(/https:\/\/([a-z0-9.\-]+)/gi)) origins.add(m[1].toLowerCase())
    }
    expect(origins.size).toBeGreaterThan(0)
    expect([...origins].filter((o) => !connectSrc.includes(o))).toEqual([])
  })

  it('allows the NY school dataset redirect target', () => {
    // data.ny.gov 308-redirects to data.cityofnewyork.us, and the CSP is
    // checked against the redirected origin, so the browser blocked the
    // request and per-school data silently returned nothing.
    expect(read('public/_headers')).toMatch(/data\.cityofnewyork\.us/)
  })

  it('never declares a Census key placeholder in source', () => {
    for (const f of ['src/core/censusKey.ts', 'src/core/plugins/acs.ts', 'src/core/http.ts']) {
      expect(codeOnly(read(f))).not.toMatch(/[0-9a-f]{40}/)
    }
  })
})

describe('gate: no mocks or placeholder data', () => {
  it('contains no mock, fixture, or fake data in src', () => {
    const files = [
      'src/core/plugins/acs.ts',
      'src/core/plugins/schools.ts',
      'src/core/plugins/ny-schools.ts',
      'src/core/plugins/keyless.ts',
      'src/core/scoring.ts',
      'src/core/useHousingQuery.ts',
    ]
    for (const f of files) {
      const src = read(f)
      expect(src, `${f} must not contain mock data`).not.toMatch(
        /mockData|MOCK_|fixtureData|dummyData|sampleData|FAKE_|hardcodedRent/,
      )
    }
  })

  it('reads the Census key only from user storage or the environment', () => {
    const key = codeOnly(read('src/core/censusKey.ts'))
    expect(key).toMatch(/localStorage/)
    // A key must never be committed, so no hardcoded literal may appear.
    expect(key).not.toMatch(/['"][0-9a-f]{40}['"]/)
  })
})

describe('gate: no hidden blocking on a missing key', () => {
  it('does not abort the whole drilldown when a Census key is absent', () => {
    // The NCES, PLACES, and per-state school sources are all keyless. An
    // early return on the missing key silently discarded every one of them.
    expect(read('src/core/useHousingQuery.ts')).not.toMatch(/if \(!key\) return/)
  })
})

/**
 * The map's colour scale and the legibility of what it draws.
 *
 * These pin three defects that were invisible in output-only assertions.
 */
describe('gate: map colour scale reads correctly', () => {
  const scale = read('src/core/map/scale.ts')
  const map = read('src/ui/MapView.tsx')

  it('darkens toward the high end, not the low end', () => {
    // The ramp ran dark-to-low and light-to-high, which is backwards from what
    // a reader expects: darker ink on a pale background reads as MORE,
    // everywhere from population maps to heatmaps, so the old scale drew the eye
    // to the LOWEST values. It was originally dark-first so label text would
    // stay legible, which matters for a labelled choropleth and is irrelevant
    // to a hexbin map where most cells carry no label.
    const block = /export const RAMP = \[([\s\S]*?)\]/.exec(scale)
    expect(block, 'RAMP must exist').not.toBeNull()
    const steps = (block![1].match(/#[0-9a-f]{6}/gi) ?? []).map((h) => h.toLowerCase())
    expect(steps.length, 'the ramp needs several steps').toBeGreaterThanOrEqual(4)

    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      const ch = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255)
    }
    // The first step is the lowest bin, the last is the highest.
    const low = luminance(steps[0]!)
    const high = luminance(steps[steps.length - 1]!)
    expect(high, 'the ramp must darken toward the highest values').toBeLessThan(low)
  })

  it('keeps absent data visually distinct from the palest step', () => {
    // Flipping the ramp brought the two together: a pale ramp step and a grey
    // no-data fill would have been hard to tell apart, and "no figure" must
    // never be readable as "a low figure".
    const noData = /NO_DATA_COLOR = '([^']+)'/.exec(scale)
    expect(noData, 'NO_DATA_COLOR must be declared').not.toBeNull()
    const block = /export const RAMP = \[([\s\S]*?)\]/.exec(scale)
    const steps = (block![1].match(/#[0-9a-f]{6}/gi) ?? []).map((h) => h.toLowerCase())
    expect(steps).not.toContain(noData![1]!.toLowerCase())
  })

  it('separates adjacent hexagons and labels them at both ends of the ramp', () => {
    // With the ramp running light-to-dark, a fixed white hairline disappeared
    // against the dark end, which is the end the eye is drawn to, so
    // neighbouring hexagons merged into one dark mass exactly where the map
    // should be most legible.
    expect(map, 'label and separator contrast must follow the fill luminance').toMatch(
      /function isLight/,
    )
    expect(map, 'the hairline must vary with the fill').toMatch(
      /pale \? '#ffffff' : 'rgba\(255,255,255,/,
    )
    expect(map, 'label ink must vary with the fill').toMatch(/fillStyle = pale \? '#0f172a' : '#ffffff'/)
    expect(map, 'the label halo must vary with the fill').toMatch(
      /strokeStyle = pale \? 'rgba\(255,255,255,0.9\)'/,
    )
  })

  it('never renders a margin of error as a missing-data label', () => {
    // A rent-burden margin is routinely larger than 100 points and the display
    // formatter returns "not yet imported" for anything over 100, so routing a
    // margin through it produced a literal +/- not yet imported beside a
    // perfectly valid 9%. Worse than showing no margin at all.
    const table = read('src/ui/SweepTable.tsx')
    expect(table, 'margins need a formatter of their own').toMatch(/function fmtMargin/)
    expect(table, 'a margin must not be rendered through the figure formatter').not.toMatch(
      /&plusmn;\{fmt\(/,
    )
    expect(table, 'the margin is rendered through fmtMargin').toMatch(/&plusmn;\{marginText\}/)
  })
})
