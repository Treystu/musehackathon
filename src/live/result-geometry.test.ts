/**
 * The live contract behind the result map's geometry (spec section
 * 2.5, kept as a standing test after the P6 probe settled it).
 *
 * The probe (2026-11-02) measured the shipped query shape against
 * TIGERweb: geometryPrecision=3 + maxAllowableOffset=0.0009 DEGREES
 * (the offset is in degrees under outSR=4326 — the spec's metre
 * reading collapses polygons to ~4-vertex blobs) returned 25 Seattle
 * ZCTAs in 13,907 B raw / 0.66 s and 17 coastal Santa Cruz ZCTAs in
 * 28,976 B raw / 0.70 s, shapes intact. This suite re-asserts that
 * contract against the live service so a TIGERweb change — a renamed
 * field, an error body, a payload blow-up — is caught as drift rather
 * than discovered as a wrong map. CI signal, not a gate (vitest.live).
 */
import { describe, expect, it } from 'vitest'

import {
  buildResultGeometryUrl,
  parseResultGeometry,
  RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES,
} from '../core/map/result-geometry'
import { withNetworkRetry } from './resilience'

const SEATTLE_25 = [
  '98101', '98102', '98103', '98104', '98105', '98106', '98107', '98108', '98109', '98112',
  '98115', '98116', '98117', '98118', '98119', '98121', '98122', '98125', '98126', '98134',
  '98136', '98144', '98154', '98164', '98174',
]

describe('result-map geometry (live TIGERweb)', () => {
  it('serves generalized polygons for a bounded 25-ZCTA set within the payload budget', async () => {
    const body = await withNetworkRetry('result geometry Seattle 25', async () => {
      const res = await fetch(buildResultGeometryUrl(SEATTLE_25))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    })()
    const parsed = parseResultGeometry(body, SEATTLE_25)
    expect(parsed.missing).toEqual([])
    expect(parsed.features.size).toBe(25)
    // The probe's decision rule: the generalized set stays far under
    // the 150 KB probe ceiling and the loader's 500 KB budget.
    expect(parsed.bytes).toBeLessThan(150_000)
    expect(parsed.bytes).toBeLessThan(RESULT_GEOMETRY_PAYLOAD_BUDGET_BYTES)
    for (const feature of parsed.features.values()) {
      expect(['Polygon', 'MultiPolygon']).toContain(feature.geometry.type)
    }
  }, 300000)
})
