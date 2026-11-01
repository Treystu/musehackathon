import { describe, expect, it, vi } from 'vitest'
import { scoreBoth } from '../src/core/scoring'
import { SORTABLE_METRIC_KEYS } from '../src/core/sortable-surface'
import { SIMILARITY_METRICS } from '../src/core/similarity'
import {
  EPA_SLD_QUERY,
  EPA_SLD_LAYER,
  EPA_SLD_SOURCE,
  epaNwiContextPlugin,
  epaNwiPointUrl,
  parseEpaSldPointResponse,
} from '../src/core/plugins/epa-nwi'
import { formatMetricValue } from '../src/ui/metric-format'

const attributes = {
  GEOID20: '060750201001',
  NatWalkInd: 18.7,
  D1A: 17.4,
  D2B_E5MIXA: 0.68,
  D3B: 135.5,
  D4A: 151.55,
  D5AR: 142219,
}
const sampleRequestUrl = epaNwiPointUrl(37.7749, -122.4194)

describe('EPA Smart Location Database context', () => {
  it('queries only the curated fields from the official point service', () => {
    const url = new URL(sampleRequestUrl)

    expect(url.origin + url.pathname).toBe(EPA_SLD_QUERY)
    expect(url.searchParams.get('where')).toBe('1=1')
    expect(url.searchParams.get('geometry')).toBe('-122.41940,37.77490')
    expect(url.searchParams.get('geometryType')).toBe('esriGeometryPoint')
    expect(url.searchParams.get('inSR')).toBe('4326')
    expect(url.searchParams.get('spatialRel')).toBe('esriSpatialRelIntersects')
    expect(url.searchParams.get('outFields')).toBe('GEOID20,NatWalkInd,D1A,D2B_E5MIXA,D3B,D4A,D5AR')
    expect(url.searchParams.get('returnGeometry')).toBe('false')
    expect(url.searchParams.get('f')).toBe('json')
  })

  it('parses walkability and representative density, diversity, design, transit, and access measures', () => {
    const result = parseEpaSldPointResponse({ features: [{ attributes }] }, sampleRequestUrl)

    expect(result?.geoid).toBe('060750201001')
    expect(result?.metrics.map(({ key, value }) => [key, value])).toEqual([
      ['epa_natwalkind_at_zip_point', 18.7],
      ['epa_residential_density', 17.4],
      ['epa_employment_mix', 0.68],
      ['epa_street_intersection_density', 135.5],
      ['epa_distance_to_transit_m', 151.55],
      ['epa_jobs_accessible_by_auto', 142219],
    ])

    for (const metric of result?.metrics ?? []) {
      expect(metric.source.publisher).toBe('U.S. Environmental Protection Agency')
      expect(metric.source.dataset).toBe('Smart Location Database Version 3.0')
      expect(metric.source.vintage).toBe('2021 release; 2019 block-group IDs; input years vary')
      expect(metric.geographyContext).toBe(
        'Block group 060750201001 contains this ZIP’s Census-geocoded point; this is not a ZIP-wide average.',
      )
      expect(metric.note).not.toContain('060750201001')
      expect(metric.note).toContain('2021 release')
    }
    expect(result?.metrics.map(({ unit }) => unit)).toEqual([
      'index', 'number', 'index', 'number', 'number', 'count',
    ])
    expect(result?.metrics.map(({ displayPrecision }) => displayPrecision)).toEqual([1, 1, 2, 1, 1, undefined])
    expect(result?.metrics.map(({ note }) => note).join(' ')).toContain('2018 ACS five-year')
    expect(result?.metrics.map(({ note }) => note).join(' ')).toContain('2017 Census LEHD')
    expect(result?.metrics.map(({ note }) => note).join(' ')).toContain('2018 HERE Maps NAVSTREETS')
    expect(result?.metrics.map(({ note }) => note).join(' ')).toContain('2020 GTFS and CTOD')
    expect(result?.metrics[5]?.note).toContain('2020 TravelTime routing and 2017 Census LEHD jobs')
    expect(formatMetricValue(result!.metrics[1]!)).toBe('17.4')
    expect(formatMetricValue(result!.metrics[2]!)).toBe('0.68')
    expect(formatMetricValue(result!.metrics[4]!)).toBe('151.6')
  })

  it('suppresses missing, boundary-ambiguous, malformed-geography, and error responses', () => {
    expect(parseEpaSldPointResponse({ features: [] }, sampleRequestUrl)).toBeNull()
    expect(parseEpaSldPointResponse({ features: [{ attributes }, { attributes }] }, sampleRequestUrl)).toBeNull()
    expect(parseEpaSldPointResponse({ features: [{ attributes: { ...attributes, GEOID20: 'bad' } }] }, sampleRequestUrl)).toBeNull()
    expect(() => parseEpaSldPointResponse({ error: { code: 400, message: 'bad query' } }, sampleRequestUrl)).toThrow(/400/)
  })

  it('preserves zero, suppresses EPA sentinels, and rejects impossible indicator ranges', () => {
    const result = parseEpaSldPointResponse({
      features: [{
        attributes: {
          ...attributes,
          NatWalkInd: 1,
          D1A: 0,
          D2B_E5MIXA: 1,
          D4A: -99999,
          D5AR: 99999,
        },
      }],
    }, sampleRequestUrl)

    expect(result?.metrics[0]).toMatchObject({ value: 1 })
    expect(result?.metrics[1]).toMatchObject({ value: 0 })
    expect(result?.metrics[2]).toMatchObject({ value: 1 })
    expect(result?.metrics[4]).toMatchObject({ value: null, absentReason: 'not-applicable' })
    expect(result?.metrics[5]).toMatchObject({ value: null, absentReason: 'not-applicable' })

    const invalid = parseEpaSldPointResponse({
      features: [{ attributes: { ...attributes, NatWalkInd: 0, D2B_E5MIXA: 1.2, D3B: -3 } }],
    }, sampleRequestUrl)
    expect(invalid?.metrics[0]).toMatchObject({ value: null, absentReason: 'out-of-range' })
    expect(invalid?.metrics[2]).toMatchObject({ value: null, absentReason: 'out-of-range' })
    expect(invalid?.metrics[3]).toMatchObject({ value: null, absentReason: 'out-of-range' })
  })

  it('keeps every EPA metric detail-only and out of composites', () => {
    const result = parseEpaSldPointResponse({ features: [{ attributes }] }, sampleRequestUrl)!
    expect(epaNwiContextPlugin.category).toBe('environment')
    expect(epaNwiContextPlugin.geography).toBe('blockgroup')
    expect(epaNwiContextPlugin.legal.notice).toContain('not ZIP-wide averages')
    expect(EPA_SLD_SOURCE.url).toBe(EPA_SLD_LAYER)

    for (const metric of result.metrics) {
      expect(SORTABLE_METRIC_KEYS).not.toContain(metric.key)
      expect(SIMILARITY_METRICS).not.toContain(metric.key)
    }
    expect(scoreBoth(result.metrics).every((composite) => composite.score === null)).toBe(true)
  })

  it('remains a keyless detail-only plugin', () => {
    expect(epaNwiContextPlugin.minZoom).toBe(4)
    expect(epaNwiContextPlugin.requiresCensusKey).toBeUndefined()
  })

  it('links every metric to the exact point request made for its ZIP', async () => {
    const points = [
      { zip: '10001', lat: 40.7506, lon: -73.9972, geoid: '360610103001' },
      { zip: '94103', lat: 37.7725, lon: -122.4092, geoid: '060750178022' },
    ]
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      const point = points[requests.length - 1]!
      return new Response(JSON.stringify({
        features: [{ attributes: { ...attributes, GEOID20: point.geoid } }],
      }), { headers: { 'content-type': 'application/json' } })
    }))

    try {
      for (const point of points) {
        const metrics = await epaNwiContextPlugin.fetch({
          geo: { zip: point.zip, name: point.zip, lat: point.lat, lon: point.lon },
          zoom: 4,
          signal: new AbortController().signal,
        })
        const requestUrl = requests.at(-1)!
        const query = new URL(requestUrl)

        expect(query.searchParams.get('geometry')).toBe(`${point.lon.toFixed(5)},${point.lat.toFixed(5)}`)
        expect(query.searchParams.get('outFields')).toBe('GEOID20,NatWalkInd,D1A,D2B_E5MIXA,D3B,D4A,D5AR')
        expect(query.searchParams.get('geometryType')).toBe('esriGeometryPoint')
        expect(query.searchParams.get('inSR')).toBe('4326')
        expect(query.searchParams.get('spatialRel')).toBe('esriSpatialRelIntersects')
        expect(query.searchParams.get('returnGeometry')).toBe('false')
        expect(query.searchParams.get('f')).toBe('json')
        expect(metrics).toHaveLength(6)
        expect(metrics.map((metric) => metric.source.url)).toEqual(Array(6).fill(requestUrl))
      }

      expect(requests).toHaveLength(points.length)
      expect(requests[0]).not.toBe(requests[1])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
