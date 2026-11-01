/**
 * Sweep orchestration: partition, fetch in chunks, cache each chunk
 * independently, and report progress as chunks land.
 *
 * The manifest is what makes a partial sweep valid rather than corrupt. Without
 * it, one dropped connection would discard the whole country-wide load; with
 * it, a resume skips everything already fetched.
 */

import { resolveCensusKey } from '../censusKey'
import { manifestStore, sweepCache } from '../cache'
import { budgetState, QuotaExhaustedError } from '../ratelimit'
import { areaRowFromRaw, sanitiseAreaRow, SCREEN_VARS, type AreaRow } from '../plugins/acs'
import { CHUNK_SIZE, chunkKey, fetchChunk, groupByState, listAllZctas, planChunks, type ZctasByPrefix } from './chunk'

export type ChunkStatus = 'pending' | 'active' | 'done' | 'failed'

export interface ChunkState {
  key: string
  first: string
  last: string
  count: number
  status: ChunkStatus
  error?: string
}

export interface SweepManifest {
  /** Bumped when the variable set or vintage changes, invalidating old chunks. */
  version: string
  startedAt: number
  updatedAt: number
  totalZctas: number
  chunks: ChunkState[]
  /** Rows merged so far, so a reload can render before refetching. */
  rows: number
  scope: string
  /** True when every chunk was served from local cache rather than fetched. */
  fromCache?: boolean
  /** Remaining requests in today's budget, so the UI can say so plainly. */
  budget?: { used: number; limit: number; remaining: number; day: string }
}

/**
 * Bumped when the parser changed, not only when the source data did. Rows cached
 * by the build that shipped sentinels as numbers were stored under v1 and replayed
 * verbatim, because a cache hit skips parsing entirely. The stamp is the invalidation
 * mechanism, so a parsing change must invalidate too.
 *
 * v6: the screen's variable-to-key mapping grew eight keys (vacant units,
 * no-internet households, household size, median age, poverty count, bachelor's
 * count, mean commute, owner-occupied units). Chunks cached under v5 hold rows
 * without those keys, which would render as a permanent labelled absence —
 * "no figure" for figures the publisher does publish — for every returning
 * visitor, so the stamp moves and one full refetch is the honest cost.
 *
 * v7: three variables changed what they mean under the same metric keys, after
 * a reader compared the map against the drilldown and the publisher's own
 * definitions were checked. "Households" was B25001_001E, total housing units
 * including vacant — now B25002_002E, occupied. "No internet subscription"
 * was B28002_003E, dial-up-only households — now B28002_013E, no internet
 * access at all. "Mean commute time" was B08303_001E, which is not a mean but
 * the count of commuting workers — the metric is now that count under an honest
 * label. Rows cached under v6 would render the old meanings under the new
 * labels forever, so the stamp moves again.
 */
export const SWEEP_VERSION = 'acs5:2023:screen:v7-honest-labels'

export interface SweepScope {
  /** Empty means the whole country. Otherwise a list of two-digit ZIP prefixes. */
  states: string[]
}

export function scopeLabel(scope: SweepScope, groups: readonly ZctasByPrefix[]): string {
  if (scope.states.length === 0) return 'the United States'
  if (scope.states.length === 1) return groups[0]?.label ?? `ZIP prefix ${scope.states[0] ?? ''}`
  return `${scope.states.length} states`
}

export interface SweepProgress {
  done: number
  total: number
  rows: number
  failed: number
  scope: string
  /** True when every chunk was served from local cache rather than fetched. */
  fromCache?: boolean
  /** Remaining requests in today's budget, so the UI can say so plainly. */
  budget?: { used: number; limit: number; remaining: number; day: string }
}

/**
 * Runs the country-wide sweep.
 *
 * `onRows` is called as each chunk lands so the table can fill in progressively
 * rather than appearing all at once after a minute of nothing. This is the whole
 * point of chunking: the first chunk is visible in about a second.
 */
export async function runSweep(options: {
  scope?: SweepScope
  signal: AbortSignal
  onRows?: (rows: AreaRow[], progress: SweepProgress) => void
  onProgress?: (progress: SweepProgress) => void
}): Promise<{ rows: AreaRow[]; manifest: SweepManifest }> {
  const scope = options.scope ?? { states: [] }
  // The visitor's own key when they have added one, otherwise the
  // deployment's shared application key (see resolveCensusKey). The error
  // below is unchanged: with neither, the sweep still cannot run.
  const censusKey = resolveCensusKey()?.key
  if (!censusKey) throw new Error('a Census API key is required to load the country-wide screen')

  const signal = options.signal

  // 1. Partition. Keyless, so it works before the key is even needed.
  const allZctas = await listAllZctas(signal)
  const groups: ZctasByPrefix[] = groupByState(allZctas)
  const inScope = (z: string) => scope.states.length === 0 || scope.states.includes(z.slice(0, 2))
  const scopedZctas = allZctas.filter(inScope)
  const label = scopeLabel(scope, groups.filter((g) => inScope(`${g.zip}00`)))

  // 2. Plan. Chunk boundaries derive from the ZIP list, so they are stable
  //    across reloads as long as the enumeration is unchanged.
  const chunks = planChunks(scopedZctas, CHUNK_SIZE)

  const manifest: SweepManifest = {
    version: SWEEP_VERSION,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    totalZctas: scopedZctas.length,
    chunks: chunks.map((c) => ({
      key: chunkKey(c),
      first: c[0]!,
      last: c[c.length - 1]!,
      count: c.length,
      status: 'pending' as ChunkStatus,
    })),
    rows: 0,
    scope: label,
  }

  // 3. Fetch, merging as we go. One failed chunk costs that chunk, not the sweep.
  const merged = new Map<string, AreaRow>()

  // Every ZIP the Census publishes is in the table, including those ACS returns
  // no row for at all. Roughly nineteen ZCTAs have no ACS coverage, and they
  // used to be absent from the screen entirely, which reads as "this place does
  // not exist" rather than "no estimate is published for it". They are added
  // here as absent rows so the national screen covers the full 33,791, and they
  // render as "not yet imported" everywhere.
  for (const zcta of scopedZctas) {
    if (!merged.has(zcta)) {
      merged.set(zcta, { zcta, name: `ZCTA5 ${zcta}`, metrics: {}, moes: {} })
    }
  }
  let anyFetched = false

  const report = () => {
    const done = manifest.chunks.filter((c) => c.status === 'done').length
    const failed = manifest.chunks.filter((c) => c.status === 'failed').length
    const progress: SweepProgress = {
      done,
      total: manifest.chunks.length,
      rows: merged.size,
      failed,
      scope: label,
      budget: budgetState(),
    }
    options.onProgress?.(progress)
    return progress
  }

  for (let i = 0; i < chunks.length; i++) {
    if (signal.aborted) break
    const zctas = chunks[i]!
    const state = manifest.chunks[i]!
    state.status = 'active'

    try {
      // Cache first. A completed chunk from a previous visit is reused without
      // touching the Census API, which is what keeps the shared rate limit
      // sustainable for a free tool.
      const cached = await sweepCache.read<AreaRow[]>(state.key, SWEEP_VERSION)
      if (cached) {
        // A cache hit bypasses the parser, so cached values are sanitised here.
        // Without this, rows cached before the sentinel fix are replayed as-is.
        for (const row of cached.body) {
          const clean = sanitiseAreaRow(row)
          merged.set(clean.zcta, clean)
        }
        state.status = 'done'
        options.onRows?.([...merged.values()], report())
        continue
      }

      anyFetched = true
      const { header, rows } = await fetchChunk(zctas, SCREEN_VARS, censusKey, signal)
      const parsed = areaRowFromRaw(header, rows)
      for (const row of parsed) merged.set(row.zcta, row)
      await sweepCache.write(state.key, parsed, SWEEP_VERSION)
      state.status = 'done'
    } catch (err) {
      state.status = 'failed'
      state.error = err instanceof Error ? err.message : 'unknown error'
      // Running the budget dry is not a fault in the data, so the remaining
      // chunks are left pending rather than failed: the manifest resumes them
      // after the budget resets, and everything already cached still renders.
      if (err instanceof QuotaExhaustedError) {
        state.status = 'pending'
        state.error = 'waiting for the daily request budget to reset'
        break
      }
    }

    manifest.updatedAt = Date.now()
    const progress = report()
    options.onRows?.([...merged.values()], progress)
  }

  manifest.rows = merged.size
  manifest.fromCache = !anyFetched
  await manifestStore.write('current', SWEEP_VERSION, manifest)

  return { rows: [...merged.values()], manifest }
}
