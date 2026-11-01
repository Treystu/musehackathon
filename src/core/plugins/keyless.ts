/**
 * Keyless sources.
 *
 * These define the experience a visitor gets before, or without ever, adding a
 * Census key. Hard-gating the app on a signup would cost a large share of all
 * visitors, so the default state has to be genuinely useful on its own.
 *
 * Verified CORS: CDC PLACES (Socrata) and BLS both return
 * Access-Control-Allow-Origin: * and require no key.
 */

import { fetchCached } from '../executor'
import type { MetricValue, PluginRequest, QueryContext, SourceRef } from '../types'

function source(publisher: string, dataset: string, tableId: string, vintage: string, url: string): SourceRef {
  return { publisher, dataset, tableId, vintage, url, citation: `${publisher} ${dataset} (${vintage})` }
}

/**
 * CDC PLACES, census-tract release.
 *
 * One row per tract, keyed by state/county/tract FIPS. Measures are modelled
 * crude prevalences with published 95% confidence intervals. The intervals are
 * wide — frequently plus or minus 8 to 15 percentage points on a single tract
 * — which is precisely why they are surfaced to the user rather than dropped.
 * A bare "37.3% obesity" would be a misrepresentation of what the data can
 * support.
 *
 * Tract geography is resolved from TIGERweb, which also needs no key. Verified
 * live: a PLACES query by tract GEOID returns data with no credential at all.
 * A health figure for the wrong geography would be worse than no figure, so
 * rather than guessing a boundary we depend on real tract resolution and
 * report unavailability when it is missing.
 */
const PLACES_ID = 'yjkw-uj5s'
const PLACES_VINTAGE = '2025 release'

const PLACES_MEASURES = [
  {
    field: 'obesity_crudeprev',
    key: 'pct_obesity',
    label: 'Adults with obesity',
    note: 'Modelled estimate of the crude prevalence of obesity among adults, with a 95% confidence interval.',
  },
  {
    field: 'foodinsecu_crudeprev',
    key: 'pct_food_insecurity',
    label: 'Households reporting food insecurity',
    note: 'Modelled estimate of the crude prevalence of reported food insecurity.',
  },
  {
    field: 'lacktrpt_crudeprev',
    key: 'pct_no_vehicle',
    label: 'Households with no vehicle access',
    note: 'Modelled estimate of the crude prevalence of households with no vehicle available. A practical proxy for car dependence, which matters for anyone without a car.',
  },
  {
    field: 'lpa_crudeprev',
    key: 'pct_no_leisure_activity',
    label: 'Adults with no leisure-time physical activity',
    note: 'Modelled estimate of the crude prevalence of no leisure-time physical activity among adults.',
  },
  {
    field: 'depression_crudeprev',
    key: 'pct_depression',
    label: 'Adults reporting depression',
    note: 'Modelled estimate of the crude prevalence of adults reporting depression. A self-reported measure, not a clinical diagnosis.',
  },
] as const

/** Parses CDC's "(29.1, 45.8)" confidence-interval encoding. */
function parseCi(s: string | undefined): [number, number] | null {
  if (!s) return null
  const m = s.match(/([\d.]+)\s*,\s*([\d.]+)/)
  if (!m) return null
  const lo = Number(m[1])
  const hi = Number(m[2])
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null
}

export const cdcPlacesPlugin: PluginRequest = {
  id: 'cdc-places',
  title: 'Health and access (CDC PLACES)',
  category: 'health',
  geography: 'tract',
  minZoom: 2,
  // No Census key required. Verified live: PLACES is an open Socrata endpoint
  // and TIGERweb supplies the tract GEOID keylessly, so this data is reachable
  // by every visitor regardless of whether they ever add a key.
  legal: {
    suppressBelow: 20,
    /**
     * Health prevalence encodes and proxies protected characteristics — age and
     * disability above all — so every measure this plugin emits is
     * `protectedClassProxy`. The executor stamps that onto each metric centrally,
     * which means these figures are displayed in a drilldown but can never be
     * offered as a sort, a filter or a ranking weight, and `scoring.ts` refuses
     * to fold them into a composite.
     *
     * For most of this repository's life this flag was declared in
     * `src/core/types.ts` and set by no plugin, read by nothing. The guarantee
     * that health measures stay out of a ranking rested entirely on nobody having
     * wired one in yet. Recorded as issue #11, closed by making the rule
     * mechanical.
     */
    protectedClassProxy: true,
    notice:
      'These are modelled estimates for Census tracts, not medical advice and not information about any individual. Tracts are statistical areas that do not correspond to any community boundary, and single-tract estimates carry very wide confidence intervals.',
  },

  async fetch(ctx: QueryContext): Promise<MetricValue[]> {
    const tracts = ctx.tractFips ?? []
    if (tracts.length === 0) return []

    // PLACES is tract-keyed, so we query exactly the tracts the user's ZIP
    // resolved to. Population-weighted mean of the crude prevalences; the
    // weights are populations, so this is an area-level aggregate and never an
    // individual-level inference.
    const list = tracts.map((t) => `'${t}'`).join(',')
    const select = ['stateabbr', 'countyfips', 'tractfips', 'totalpopulation', ...PLACES_MEASURES.map((m) => m.field)].join(',')
    const url =
      `https://data.cdc.gov/resource/${PLACES_ID}.json` +
      `?$select=${encodeURIComponent(select)}&$where=${encodeURIComponent(`tractfips in(${list})`)}`

    const { body } = await fetchCached<unknown[]>(url, ctx.signal,
      180 * 24 * 60 * 60 * 1000,
    )

    // Shape validation: the Census and CDC endpoints both answer 200 with an
    // error payload on failure, so a status-only check reports success for
    // nothing.
    if (!Array.isArray(body) || body.length === 0) return []
    const rows = body as Record<string, unknown>[]

    const totalPop = rows.reduce((sum, r) => sum + (Number(r.totalpopulation) || 0), 0)
    if (totalPop <= 0) return []

    const out: MetricValue[] = []
    for (const m of PLACES_MEASURES) {
      let acc = 0
      let contributing = 0
      let widest = 0
      for (const r of rows) {
        const v = r[m.field]
        if (typeof v !== 'number') continue
        const pop = Number(r.totalpopulation) || 0
        acc += v * pop
        contributing += pop
        const ci = parseCi(r[`${m.field.replace('_crudeprev', '')}_crude95ci`] as string | undefined)
        if (ci) widest = Math.max(widest, (ci[1] - ci[0]) / 2)
      }
      if (contributing <= 0) continue
      const value = acc / contributing
      out.push({
        key: m.key,
        label: m.label,
        value: Math.round(value * 10) / 10,
        unit: 'percent',
        category: 'health',
        source: source('CDC', 'PLACES: Census Tract Data', m.field, PLACES_VINTAGE, url),
        quality: {
          derived: true,
          // Reporting the widest contributing interval keeps the user informed
          // of how much noise is in this number.
          marginOfError: Math.round(widest * 10) / 10,
          derivation: `Population-weighted mean of modelled tract-level prevalence across ${body.length} Census tract(s) covering the selected ZIP code, using published CDC PLACES estimates. This is our aggregation, not a published CDC figure.`,
        },
        note: m.note,
      })
    }
    return out
  },
}
