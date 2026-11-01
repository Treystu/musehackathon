import { describe, expect, it, vi } from 'vitest'
import { registry, isSchoolPlugin } from '../src/core/plugin-catalog'
import { nySchoolPlugin } from '../src/core/plugins/ny-schools'
import {
  nationalSchoolOutcomesPlugin,
  parseNearbyPublicSchools,
  PUBLIC_SCHOOL_LOCATIONS_QUERY,
  SCHOOL_ACGR_ENDPOINT,
  schoolAcgrUrl,
  schoolLocationsUrl,
} from '../src/core/plugins/school-outcomes'

describe('nationwide EDFacts school outcomes', () => {
  it('builds a bounded NCES location query and an all-students ACGR query', () => {
    const location = new URL(schoolLocationsUrl(34.26, -86.2))
    expect(location.origin + location.pathname).toBe(PUBLIC_SCHOOL_LOCATIONS_QUERY)
    expect(location.searchParams.get('geometryType')).toBe('esriGeometryEnvelope')
    expect(location.searchParams.get('inSR')).toBe('4326')
    expect(location.searchParams.get('spatialRel')).toBe('esriSpatialRelIntersects')
    expect(location.searchParams.get('outFields')).toBe('NCESSCH,NAME,OPSTFIPS,LAT,LON,SCHOOLYEAR')
    expect(location.searchParams.get('returnGeometry')).toBe('false')
    expect(location.searchParams.get('f')).toBe('json')

    const exactLatitudeEdge = (3000 / 6_371_000) * (180 / Math.PI)
    const equatorBounds = new URL(schoolLocationsUrl(0, 0)).searchParams.get('geometry')!.split(',').map(Number)
    expect(equatorBounds[1]).toBeLessThanOrEqual(-exactLatitudeEdge)
    expect(equatorBounds[3]).toBeGreaterThanOrEqual(exactLatitudeEdge)

    const highLatitudeBounds = new URL(schoolLocationsUrl(60, 0)).searchParams.get('geometry')!.split(',').map(Number)
    const exactLongitudeEdge = exactLatitudeEdge / Math.cos(Math.PI / 3)
    expect(highLatitudeBounds[0]).toBeLessThanOrEqual(-exactLongitudeEdge)
    expect(highLatitudeBounds[2]).toBeGreaterThanOrEqual(exactLongitudeEdge)

    const outcomes = new URL(schoolAcgrUrl(1))
    expect(outcomes.origin + outcomes.pathname).toBe(SCHOOL_ACGR_ENDPOINT)
    expect(outcomes.searchParams.get('fips')).toBe('1')
    for (const filter of ['race', 'disability', 'econ_disadvantaged', 'foster_care', 'homeless', 'lep']) {
      expect(outcomes.searchParams.get(filter)).toBe('99')
    }
  })

  it('joins nearby schools by NCES ID and omits missing or suppressed outcomes', async () => {
    const requests: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requests.push(url)

      if (url.origin + url.pathname === PUBLIC_SCHOOL_LOCATIONS_QUERY) {
        return new Response(JSON.stringify({
          features: [
            { attributes: {
              NCESSCH: '010000500871',
              NAME: 'Albertville High School',
              OPSTFIPS: '01',
              LAT: 34.261,
              LON: -86.206,
              SCHOOLYEAR: '2019-2020',
            } },
            { attributes: {
              NCESSCH: '010000500870',
              NAME: 'Albertville Middle School',
              OPSTFIPS: '01',
              LAT: 34.2605,
              LON: -86.205,
              SCHOOLYEAR: '2019-2020',
            } },
            { attributes: {
              NCESSCH: '010000500874',
              NAME: 'School Without an Outcome Row',
              OPSTFIPS: '01',
              LAT: 34.2615,
              LON: -86.2055,
              SCHOOLYEAR: '2019-2020',
            } },
            { attributes: {
              NCESSCH: '010000500875',
              NAME: 'School with an Unbounded Rate',
              OPSTFIPS: '01',
              LAT: 34.27,
              LON: -86.206,
              SCHOOLYEAR: '2019-2020',
            } },
            { attributes: {
              NCESSCH: '010000500872',
              NAME: 'Old Location Record',
              OPSTFIPS: '01',
              LAT: 34.26,
              LON: -86.2,
              SCHOOLYEAR: '2018-2019',
            } },
            { attributes: {
              NCESSCH: '010000500873',
              NAME: 'Far Away High School',
              OPSTFIPS: '01',
              LAT: 34.31,
              LON: -86.2,
              SCHOOLYEAR: '2019-2020',
            } },
          ],
        }), { headers: { 'content-type': 'application/json' } })
      }

      if (url.origin + url.pathname === SCHOOL_ACGR_ENDPOINT) {
        return new Response(JSON.stringify({
          count: 4,
          next: null,
          previous: null,
          results: [
            {
              ncessch: '10000500871',
              fips: 1,
              year: 2019,
              school_name: 'Portal name is not used for the join',
              cohort_num: 84,
              grad_rate_low: 90,
              grad_rate_high: 94,
              grad_rate_midpt: 92,
            },
            {
              ncessch: '10000500870',
              fips: 1,
              year: 2019,
              cohort_num: 13,
              grad_rate_low: null,
              grad_rate_high: null,
              grad_rate_midpt: -3,
            },
            {
              ncessch: '10000500875',
              fips: 1,
              year: 2019,
              school_name: 'School with an Unbounded Rate',
              cohort_num: 102,
              grad_rate_low: null,
              grad_rate_high: null,
              grad_rate_midpt: 88,
            },
            {
              ncessch: '10000500999',
              fips: 1,
              year: 2019,
              cohort_num: 100,
              grad_rate_midpt: 99,
            },
          ],
        }), { headers: { 'content-type': 'application/json' } })
      }

      throw new Error(`Unexpected URL ${url}`)
    }))

    try {
      const metrics = await nationalSchoolOutcomesPlugin.fetch({
        geo: { name: 'Albertville, AL', lat: 34.26, lon: -86.2 },
        zoom: 4,
        signal: new AbortController().signal,
      })

      expect(requests).toHaveLength(2)
      expect(requests[0]!.origin + requests[0]!.pathname).toBe(PUBLIC_SCHOOL_LOCATIONS_QUERY)
      expect(requests[1]!.searchParams.get('fips')).toBe('1')
      expect(metrics).toHaveLength(2)
      expect(metrics.map((metric) => metric.key).sort()).toEqual([
        'edfacts_2019_acgr_10000500871',
        'edfacts_2019_acgr_10000500875',
      ])
      expect(metrics[0]).toMatchObject({
        key: 'edfacts_2019_acgr_10000500871',
        label: 'Albertville High School — graduation rate midpoint (2019 ACGR)',
        value: 92,
        unit: 'percent',
        geographyContext: expect.stringMatching(/m from the selected location/),
        quality: { derived: false },
        source: {
          publisher: 'U.S. Department of Education, EDFacts; Urban Institute; NCES EDGE',
          vintage: '2019 ACGR; 2019–20 NCES EDGE locations',
          url: requests[1]!.toString(),
        },
      })
      expect(metrics[0]!.note).toContain('90–94% band')
      expect(metrics[0]!.note).toContain('missing, not-applicable, and suppressed records are omitted')
      expect(metrics.find((metric) => metric.key === 'edfacts_2019_acgr_10000500875')?.note)
        .toContain('The Portal supplied no low/high bounds')
      expect(metrics.map((metric) => metric.label)).not.toContain('Albertville Middle School — graduation rate midpoint (2019 ACGR)')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('includes a school exactly on the 3 km boundary and excludes one just outside', () => {
    const atBoundary = (3000 / 6_371_000) * (180 / Math.PI)
    const justOutside = (3001 / 6_371_000) * (180 / Math.PI)
    const schools = parseNearbyPublicSchools({
      features: [
        { attributes: {
          NCESSCH: '010000500871', NAME: 'Boundary School', OPSTFIPS: '01',
          LAT: atBoundary, LON: 0, SCHOOLYEAR: '2019-2020',
        } },
        { attributes: {
          NCESSCH: '010000500872', NAME: 'Outside School', OPSTFIPS: '01',
          LAT: justOutside, LON: 0, SCHOOLYEAR: '2019-2020',
        } },
      ],
    }, 0, 0)

    expect(schools.map((school) => school.name)).toEqual(['Boundary School'])
  })

  it('rejects an NCES response that omits the features field', async () => {
    const requests: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(new URL(String(input)))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }))

    try {
      await expect(nationalSchoolOutcomesPlugin.fetch({
        geo: { name: 'Test location', lat: 0, lon: 0 },
        zoom: 4,
        signal: new AbortController().signal,
      })).rejects.toThrow(/NCES EDGE.*features/i)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.origin + requests[0]!.pathname).toBe(PUBLIC_SCHOOL_LOCATIONS_QUERY)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('skips missing coordinates without a request and accepts the valid origin point', async () => {
    const requests: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(new URL(String(input)))
      return new Response(JSON.stringify({ features: [] }), { headers: { 'content-type': 'application/json' } })
    }))

    try {
      const missing = await nationalSchoolOutcomesPlugin.fetch({
        geo: { name: 'No point' },
        zoom: 4,
        signal: new AbortController().signal,
      })
      expect(missing).toEqual([])
      expect(requests).toHaveLength(0)

      const origin = await nationalSchoolOutcomesPlugin.fetch({
        geo: { name: 'Origin', lat: 0, lon: 0 },
        zoom: 4,
        signal: new AbortController().signal,
      })
      expect(origin).toEqual([])
      expect(requests).toHaveLength(1)
      expect(requests[0]!.origin + requests[0]!.pathname).toBe(PUBLIC_SCHOOL_LOCATIONS_QUERY)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns no outcomes when the portal response has an empty state result set', async () => {
    const requests: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requests.push(url)
      const body = url.origin + url.pathname === PUBLIC_SCHOOL_LOCATIONS_QUERY
        ? { features: [{ attributes: {
            NCESSCH: '170993006459',
            NAME: 'Noble St Chtr-Muchin College Prep',
            OPSTFIPS: '17',
            LAT: 41.885,
            LON: -87.622,
            SCHOOLYEAR: '2019-2020',
          } }] }
        : { count: 0, next: null, previous: null, results: [] }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }))

    try {
      const metrics = await nationalSchoolOutcomesPlugin.fetch({
        geo: { name: 'Chicago, IL', lat: 41.885, lon: -87.622 },
        zoom: 4,
        signal: new AbortController().signal,
      })

      expect(metrics).toEqual([])
      expect(requests).toHaveLength(2)
      expect(requests[1]!.searchParams.get('fips')).toBe('17')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('joins schools across state boundaries and preserves nearest-first order when state responses finish out of order', async () => {
    const completedFips: string[] = []
    const requests: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requests.push(url)

      if (url.origin + url.pathname === PUBLIC_SCHOOL_LOCATIONS_QUERY) {
        return new Response(JSON.stringify({
          features: [
            { attributes: {
              NCESSCH: '060000500872', NAME: 'Farther California School', OPSTFIPS: '06',
              LAT: 0.02, LON: 0, SCHOOLYEAR: '2019-2020',
            } },
            { attributes: {
              NCESSCH: '010000500871', NAME: 'Nearest Alabama School', OPSTFIPS: '01',
              LAT: 0.01, LON: 0, SCHOOLYEAR: '2019-2020',
            } },
          ],
        }), { headers: { 'content-type': 'application/json' } })
      }

      const fips = url.searchParams.get('fips')!
      if (fips === '1') await new Promise((resolve) => setTimeout(resolve, 750))
      completedFips.push(fips)
      const schoolId = fips === '1' ? '10000500871' : '60000500872'
      const midpoint = fips === '1' ? 87 : 95
      return new Response(JSON.stringify({
        next: null,
        results: [{ ncessch: schoolId, fips: Number(fips), year: 2019, grad_rate_midpt: midpoint }],
      }), { headers: { 'content-type': 'application/json' } })
    }))

    try {
      const metrics = await nationalSchoolOutcomesPlugin.fetch({
        geo: { name: 'State boundary point', lat: 0, lon: 0 },
        zoom: 4,
        signal: new AbortController().signal,
      })

      expect(completedFips).toEqual(['6', '1'])
      expect(requests.filter((url) => url.origin + url.pathname === SCHOOL_ACGR_ENDPOINT)
        .map((url) => url.searchParams.get('fips')).sort()).toEqual(['1', '6'])
      expect(metrics.map((metric) => metric.label)).toEqual([
        'Nearest Alabama School — graduation rate midpoint (2019 ACGR)',
        'Farther California School — graduation rate midpoint (2019 ACGR)',
      ])
      expect(metrics.map((metric) => metric.value)).toEqual([87, 95])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows at most the eight nearest schools with reportable outcomes', async () => {
    const nearbySchools = Array.from({ length: 10 }, (_, index) => {
      const ncessch = `0100005${String(index + 1).padStart(5, '0')}`
      return {
        ncessch,
        attributes: {
          NCESSCH: ncessch,
          NAME: `Fixture School ${index + 1}`,
          OPSTFIPS: '01',
          LAT: 34.1 + index * 0.0001,
          LON: -86.3,
          SCHOOLYEAR: '2019-2020',
        },
      }
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const body = url.origin + url.pathname === PUBLIC_SCHOOL_LOCATIONS_QUERY
        ? { features: nearbySchools }
        : {
            next: null,
            results: nearbySchools.map(({ ncessch }, index) => ({
              ncessch: ncessch.replace(/^0+/, ''),
              fips: 1,
              year: 2019,
              grad_rate_midpt: 80 + index,
            })),
          }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }))

    try {
      const metrics = await nationalSchoolOutcomesPlugin.fetch({
        geo: { name: 'Fixture point', lat: 34.1, lon: -86.3 },
        zoom: 4,
        signal: new AbortController().signal,
      })
      expect(metrics).toHaveLength(8)
      expect(metrics.map((metric) => metric.label)).toEqual(
        nearbySchools.slice(0, 8).map(({ attributes }) => `${attributes.NAME} — graduation rate midpoint (2019 ACGR)`),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the national plugin keyless and keeps the existing NYC school source registered', () => {
    expect(nationalSchoolOutcomesPlugin.requiresCensusKey).toBeUndefined()
    expect(nationalSchoolOutcomesPlugin.geography).toBe('school')
    expect(nationalSchoolOutcomesPlugin.legal?.notice).toContain('within 3 km')
    expect(isSchoolPlugin(nationalSchoolOutcomesPlugin.id)).toBe(true)
    expect(registry.get(nationalSchoolOutcomesPlugin.id)).toBe(nationalSchoolOutcomesPlugin)
    expect(registry.get(nySchoolPlugin.id)).toBe(nySchoolPlugin)
    expect(nySchoolPlugin.id).toBe('nyc-doe-school-detail')
    expect(nySchoolPlugin.stateCode).toBe('NY')
  })
})
