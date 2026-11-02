import { describe, expect, it } from 'vitest'

import {
  buildResultGeometryUrl,
  capResultZctas,
  loadCountyOutlineGeometry,
  loadResultGeometry,
  parseResultGeometry,
  ResultGeometryError,
  RESULT_GEOMETRY_CAP,
  RESULT_GEOMETRY_OFFSET_DEGREES,
  RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES,
  RESULT_GEOMETRY_RETRY_OFFSET_DEGREES,
  type ResultGeometryFetcher,
} from './result-geometry'

/**
 * Hermetic pins for the result-map geometry loader. The query shape is
 * the P6 probe's corrected one (probe RESULTS.md, 2026-11-02): offset
 * in DEGREES under outSR=4326 — the spec-literal 250 must never
 * reappear, because it collapses polygons to ~4-vertex blobs.
 */

const SEATTLE_3 = ['98101', '98102', '98103']

function geojsonFor(zctas: readonly string[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: zctas.map((z) => ({
      type: 'Feature',
      properties: { ZCTA5: z },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-122.3, 47.6], [-122.2, 47.6], [-122.2, 47.7], [-122.3, 47.6]]],
      },
    })),
  })
}

function recordingFetcher(responses: (url: string) => { text: string; status: number }) {
  const urls: string[] = []
  const fetcher: ResultGeometryFetcher = async (url) => {
    urls.push(url)
    return responses(url)
  }
  return { urls, fetcher }
}

describe('buildResultGeometryUrl — the probe-corrected query', () => {
  it('pins every parameter, including the 0.0009 degree offset literal', () => {
    const url = buildResultGeometryUrl(SEATTLE_3)
    expect(url).toContain('maxAllowableOffset=0.0009')
    expect(url).not.toContain('maxAllowableOffset=250')
    expect(url).toContain('geometryPrecision=3')
    expect(url).toContain('outFields=ZCTA5')
    expect(url).toContain('returnGeometry=true')
    expect(url).toContain('outSR=4326')
    expect(url).toContain('f=geojson')
    expect(RESULT_GEOMETRY_OFFSET_DEGREES).toBe(0.0009)
  })

  it('batches all ZCTAs into one IN clause with %27-encoded apostrophes', () => {
    const url = buildResultGeometryUrl(SEATTLE_3)
    expect(url).toContain(`ZCTA5%20IN%20(%2798101%27%2C%2798102%27%2C%2798103%27)`)
    // No bare apostrophe survives anywhere in the query string.
    expect(url.split('?')[1]).not.toContain("'")
    expect(url.match(/query\?/g)).toHaveLength(1)
  })

  it('carries exactly the whitelisted field list — one bad field fails the whole TIGERweb query', () => {
    const url = buildResultGeometryUrl(SEATTLE_3)
    const outFields = new URL(url).searchParams.get('outFields')
    expect(outFields).toBe('ZCTA5')
  })
})

describe('capResultZctas', () => {
  it('enforces the 25 cap, dedupes, and drops malformed codes', () => {
    const many = Array.from({ length: 40 }, (_, i) => String(98101 + i))
    const capped = capResultZctas([...many, '98101', 'bad', '1234'])
    expect(capped).toHaveLength(RESULT_GEOMETRY_CAP)
    expect(capped).toHaveLength(25)
    expect(new Set(capped).size).toBe(25)
  })
})

describe('parseResultGeometry', () => {
  it('maps features by ZCTA and reports a requested-but-absent ZCTA as missing', () => {
    const parsed = parseResultGeometry(geojsonFor(['98101', '98103']), SEATTLE_3)
    expect([...parsed.features.keys()].sort()).toEqual(['98101', '98103'])
    expect(parsed.missing).toEqual(['98102'])
    expect(parsed.bytes).toBeGreaterThan(0)
  })

  it('throws a named error on the HTTP-200 error body (the geocode trap)', () => {
    expect(() => parseResultGeometry(JSON.stringify({ error: { code: 400, message: 'bad field' } }), SEATTLE_3)).toThrow(
      ResultGeometryError,
    )
  })

  it('throws on malformed GeoJSON rather than returning a partial map', () => {
    expect(() => parseResultGeometry('{"type":"FeatureCollection"', SEATTLE_3)).toThrow(ResultGeometryError)
    expect(() => parseResultGeometry('{"type":"Feature"}', SEATTLE_3)).toThrow(ResultGeometryError)
  })

  it('keeps MultiPolygon geometry intact', () => {
    const multi = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { ZCTA5: '95060' },
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [[[-122, 37], [-121.9, 37], [-122, 37]]],
              [[[-122.1, 37.1], [-122, 37.1], [-122.1, 37.1]]],
            ],
          },
        },
      ],
    })
    const parsed = parseResultGeometry(multi, ['95060'])
    expect(parsed.features.get('95060')?.geometry.type).toBe('MultiPolygon')
    expect(parsed.missing).toEqual([])
  })
})

describe('loadResultGeometry — budget, retry, failure', () => {
  it('accepts an in-budget payload in exactly one fetch', async () => {
    const { urls, fetcher } = recordingFetcher(() => ({ text: geojsonFor(SEATTLE_3), status: 200 }))
    const result = await loadResultGeometry(SEATTLE_3, { fetcher })
    expect(urls).toHaveLength(1)
    expect(result.simplified).toBe(false)
    expect(result.features.size).toBe(3)
  })

  it('retries exactly once at the larger offset when the payload breaches the budget, and flags simplified', async () => {
    const big = geojsonFor(SEATTLE_3) + ' '.repeat(RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES)
    const { urls, fetcher } = recordingFetcher((url) =>
      url.includes(`maxAllowableOffset=${RESULT_GEOMETRY_RETRY_OFFSET_DEGREES}`)
        ? { text: geojsonFor(SEATTLE_3), status: 200 }
        : { text: big, status: 200 },
    )
    const result = await loadResultGeometry(SEATTLE_3, { fetcher })
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('maxAllowableOffset=0.0045')
    expect(result.simplified).toBe(true)
  })

  it('throws after a second breach — the quiet-line fallback path, never a heavy map', async () => {
    const big = geojsonFor(SEATTLE_3) + ' '.repeat(RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES)
    const { fetcher } = recordingFetcher(() => ({ text: big, status: 200 }))
    await expect(loadResultGeometry(SEATTLE_3, { fetcher })).rejects.toThrow(ResultGeometryError)
  })

  it('throws on a non-200 status', async () => {
    const { fetcher } = recordingFetcher(() => ({ text: 'nope', status: 500 }))
    await expect(loadResultGeometry(SEATTLE_3, { fetcher })).rejects.toThrow(/HTTP 500/)
  })

  it('caps the request at 25 ZCTAs in a single query even when handed more', async () => {
    const many = Array.from({ length: 30 }, (_, i) => String(98101 + i))
    const { urls, fetcher } = recordingFetcher((url) => {
      const where = new URL(url).searchParams.get('where') ?? ''
      const asked: string[] = where.match(/\d{5}/g) ?? []
      return { text: geojsonFor(asked), status: 200 }
    })
    const result = await loadResultGeometry(many, { fetcher })
    expect(urls).toHaveLength(1)
    expect(result.features.size).toBe(25)
  })
})

describe('loadCountyOutlineGeometry', () => {
  it('batches members at the cap and merges them into one feature set', async () => {
    const members = Array.from({ length: 30 }, (_, i) => String(80301 + i))
    const { urls, fetcher } = recordingFetcher((url) => {
      const where = new URL(url).searchParams.get('where') ?? ''
      const asked: string[] = where.match(/\d{5}/g) ?? []
      return { text: geojsonFor(asked), status: 200 }
    })
    const result = await loadCountyOutlineGeometry(members, { fetcher })
    expect(urls).toHaveLength(2)
    expect(result.features.size).toBe(30)
    expect(result.missing).toEqual([])
  })
})
