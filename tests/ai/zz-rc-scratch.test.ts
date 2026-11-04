import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodePlaces } from '../../src/core/zcta-place-index'
import { buildStatePartitions } from '../../src/core/sweep/states'
import { aggregateRowsToCounties } from '../../src/core/county-aggregate'
import type { AreaRow } from '../../src/core/types'

/**
 * SCRATCH (R-C investigation, 2026-11-04): the shipped state-aggregate
 * computation over the REAL ACS 2023 5-year ZCTA pull (downloaded to
 * /tmp/acs_zcta.json from api.census.gov with the deployment's shared
 * app key — the same data the live sweep reads). Question under test:
 * does the shipped formula yield Maine ≈45 ±1 (the 9a75c2f live
 * verification) or ≈45 ±5 (the 7dc627e battery)?
 */
describe('R-C scratch: state aggregate margins on real ACS data', () => {
  it('computes median-age state aggregates', () => {
    const raw = JSON.parse(readFileSync('/tmp/acs_zcta.json', 'utf8')) as string[][]
    const num = (v: string | undefined): number | null => {
      if (v === undefined) return null
      const n = Number(v)
      if (!Number.isFinite(n) || n <= -666666666 || n === -999999999) return null
      return n
    }
    const rows: AreaRow[] = []
    for (const r of raw.slice(1)) {
      const age = num(r[1])
      const ageM = num(r[2])
      const pop = num(r[3])
      rows.push({
        zcta: r[4]!,
        name: r[0]!,
        metrics: { median_age: age, population: pop },
        moes: { median_age: ageM },
      } as AreaRow)
    }
    const payload = JSON.parse(
      readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8'),
    )
    const { byZip } = decodePlaces(payload)
    const stateByZip = new Map<string, string>()
    for (const [zip, record] of byZip) stateByZip.set(zip, record.state)
    const partitions = buildStatePartitions(
      rows.map((r) => r.zcta),
      stateByZip,
    )
    const wanted = ['ME', 'PR', 'VT', 'FL', 'NH', 'WV', 'UT']
    const out: Record<string, unknown> = {}
    for (const partition of partitions) {
      if (!wanted.includes(partition.code)) continue
      const memberSet = new Set(partition.zctas)
      const members = rows.filter((r) => memberSet.has(r.zcta))
      const assignments = new Map(
        members.map((row) => [row.zcta, { name: partition.label, state: partition.code }]),
      )
      const agg = aggregateRowsToCounties(members, assignments, ['median_age'])
      const row = agg.rows[0]!
      out[partition.code] = {
        members: members.length,
        value: row.metrics['median_age'],
        margin: row.moes['median_age'],
      }
    }
    console.log('STATE AGGREGATES (full real data):', JSON.stringify(out, null, 1))
    expect(Object.keys(out).length).toBe(wanted.length)
  })
})
