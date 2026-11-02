import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { executePlugins } from './executor'
import { fetchAreas, rowToMetrics, type AreaRow } from './plugins/acs'
import { enrichWithTracts } from './plugins/geography'
import { DRILLDOWN_PLUGIN_IDS, isSchoolPlugin, registry } from './plugin-catalog'
import { runSweep, type SweepProgress, type SweepScope } from './sweep/runSweep'
import { CHUNK_SIZE, listAllZctas } from './sweep/chunk'
import {
  buildStatePartitions,
  describeScope,
  estimateChunks,
  stateOptions,
  toggleStateOption,
  type StateOption,
  type StatePartition,
} from './sweep/states'
import { loadPlaceIndex } from './zcta-place-index'
import { formatPlace, geocode } from './geocode'
import { resolveCensusKey, CENSUS_KEY_EVENT, type CensusKeySource } from './censusKey'
import { sweepCache } from './cache'
import { getQuota, onQuotaChange, type QuotaState } from './http'
import { scoreBoth, type Composite } from './scoring'
import type { MetricValue, QueryContext, ResolvedPlace, ZoomLevel } from './types'

export type SweepStatus = 'idle' | 'loading' | 'ready' | 'error' | 'needs-key'
export interface DrillState {
  zcta: string
  label: string
  metrics: MetricValue[]
  composites: Composite[]
  loading: boolean
  error?: string
  /** True when a school district was found, so the UI can disclose what is absent. */
  hasSchools?: boolean
}

export interface QueryState {
  status: 'idle' | 'searching' | 'error'
  error?: string
  /** Country-wide screen, filled in progressively as chunks land. */
  sweep: AreaRow[]
  sweepStatus: SweepStatus
  sweepError?: string
  /** Which two-digit state prefixes are in scope; empty means the whole country. */
  sweepScope: string[]
  sweepProgress?: SweepProgress
  /** True when at least one chunk was served from local cache. */
  sweepFromCache: boolean
  selected: ResolvedPlace[]
  drilldowns: Record<string, DrillState>
  /** True when a Census key is in effect, from either source. */
  censusKeyPresent: boolean
  /**
   * Which source the effective key came from. Copy that talks about "your
   * key" must key off this, never off censusKeyPresent alone: a 'shared'
   * default is the deployment's application key, not a key the visitor
   * added, and no surface may claim otherwise.
   */
  censusKeySource: CensusKeySource | undefined
  quota: QuotaState
  zoom: ZoomLevel
}

/** The key-derived slice of state, recomputed wherever the key may have changed. */
function keyState(): Pick<QueryState, 'censusKeyPresent' | 'censusKeySource'> {
  const resolved = resolveCensusKey()
  return { censusKeyPresent: resolved !== undefined, censusKeySource: resolved?.source }
}

const initial: QueryState = {
  status: 'idle',
  sweep: [],
  sweepStatus: 'idle',
  sweepScope: [],
  sweepFromCache: false,
  selected: [],
  drilldowns: {},
  ...keyState(),
  quota: getQuota(),
  zoom: 2,
}

export function useHousingQuery() {
  const [state, setState] = useState<QueryState>(initial)
  const sweepAbort = useRef<AbortController | null>(null)
  const drillAbort = useRef<Record<string, AbortController>>({})
  const runRef = useRef<((text: string) => Promise<void>) | null>(null)
  const lastSearch = useRef<{ text: string } | null>(null)
  const [, setQuotaTick] = useState(0)

  useEffect(() => onQuotaChange(() => setQuotaTick((t) => t + 1)), [])

  /**
   * Loads the country-wide screen in chunks.
   *
   * The previous implementation issued one wildcard request for every ZCTA,
   * which is roughly 34x the number of geographies the Census API accepts in a
   * single call. It failed or timed out. It is now chunked at the measured
   * ceiling of 1,000 ZCTAs per request, with each chunk cached independently,
   * so a dropped connection costs one chunk rather than the whole load.
   */
  const loadSweep = useCallback(async (scope: SweepScope = { states: [] }) => {
    // Either source unlocks the sweep: the visitor's own key, or the shared
    // application key the deployment supplied. Only with neither does the
    // sweep stay in its needs-key state.
    if (!resolveCensusKey()) {
      setState((s) => ({ ...s, sweepStatus: 'needs-key', censusKeyPresent: false, censusKeySource: undefined }))
      return
    }
    sweepAbort.current?.abort()
    const ctrl = new AbortController()
    sweepAbort.current = ctrl
    setState((s) => ({ ...s, sweepStatus: 'loading', ...keyState(), sweepError: undefined }))

    try {
      const { rows, manifest } = await runSweep({
        scope,
        signal: ctrl.signal,
        onRows: (partial, progress) => {
          if (ctrl.signal.aborted) return
          setState((s) => ({ ...s, sweep: partial, sweepProgress: progress }))
        },
        onProgress: (progress) => {
          if (ctrl.signal.aborted) return
          setState((s) => ({ ...s, sweepProgress: progress }))
        },
      })
      if (ctrl.signal.aborted) return
      const failed = manifest.chunks.filter((c) => c.status === 'failed').length
      setState((s) => ({
        ...s,
        sweepStatus: 'ready',
        sweep: rows,
        sweepScope: scope.states,
        sweepFromCache: manifest.fromCache === true,
        sweepError: failed
          ? `${failed} of ${manifest.chunks.length} areas could not be loaded. Everything shown is real; retry for the rest.`
          : undefined,
      }))
    } catch (err) {
      if (ctrl.signal.aborted) return
      setState((s) => ({
        ...s,
        sweepStatus: 'error',
        sweepError: err instanceof Error ? err.message : 'The country-wide screen could not be loaded',
      }))
    }
  }, [])

  /** Adds a place to the comparison set and fetches its detail. */
  const selectPlace = useCallback(
    async (place: ResolvedPlace) => {
      const zcta = place.zip
      if (!zcta) return

      setState((s) => ({
        ...s,
        selected: s.selected.some((p) => p.zip === zcta) ? s.selected : [...s.selected, place],
        drilldowns: {
          ...s.drilldowns,
          [zcta]: { zcta, label: formatPlace(place), metrics: [], composites: [], loading: true },
        },
      }))

      const key = resolveCensusKey()?.key

      drillAbort.current[zcta]?.abort()
      const ctrl = new AbortController()
      drillAbort.current[zcta] = ctrl

      // A Census key is not required for every drilldown source. The NCES
      // district lookup, the CDC PLACES measures, and the per-state school
      // plugins are all keyless, so returning early when the key is absent
      // silently discarded all of them. The key is passed through as optional
      // and only the key-requiring plugins are skipped by the executor. The
      // key itself is the resolved one — the visitor's own when they have
      // added one, otherwise the deployment's shared application key.
      const ctx: QueryContext = { geo: place, zoom: 4, censusKey: key, signal: ctrl.signal }
      const signal = ctrl.signal

      // The NCES boundary lookup is a point query, so a selected ZIP needs
      // coordinates. The search box and the sweep table both supply an area
      // without them, so they are resolved here rather than in the UI.
      if (place.lat === undefined || place.lon === undefined) {
        try {
          const { places } = await geocode(zcta, signal)
          const hit = places.find((p) => p.zip === zcta) ?? places[0]
          if (hit) {
            place = { ...place, lat: hit.lat, lon: hit.lon, county: hit.county ?? place.county, state: hit.state ?? place.state }
            ctx.geo = place
          }
        } catch {
          // A ZIP with no resolvable point simply gets no school panel; the
          // rest of the drilldown is unaffected.
        }
      }
      if (signal.aborted) return

      try {
        await enrichWithTracts(ctx)
        if (signal.aborted) return

        const results = await executePlugins({
          registry,
          ids: DRILLDOWN_PLUGIN_IDS,
          ctx,
        })
        if (signal.aborted) return

        // ACS detail for the selected ZIP, plus whatever the drilldown plugins
        // produced. The sweep already has the headline figures, but fetching
        // the specific row keeps the drilldown self-contained and correct if
        // the sweep was loaded from a stale cache.
        const areaRows = key ? await fetchAreas([zcta], key, signal) : []
        if (signal.aborted) return
        const areaRow = areaRows.find((r) => r.zcta === zcta)

        const metrics = [...(areaRow ? rowToMetrics(areaRow) : []), ...results.flatMap((r) => r.metrics)]

        setState((s) => ({
          ...s,
          drilldowns: {
            ...s.drilldowns,
            [zcta]: {
              zcta,
              label: formatPlace(place),
              metrics,
              composites: scoreBoth(metrics),
              loading: false,
              hasSchools: results.some(
                (r) => isSchoolPlugin(r.pluginId) && r.status === 'ok',
              ),
            },
          },
        }))
      } catch (err) {
        if (signal.aborted) return
        setState((s) => ({
          ...s,
          drilldowns: {
            ...s.drilldowns,
            [zcta]: {
              zcta,
              label: formatPlace(place),
              metrics: [],
              composites: [],
              loading: false,
              error: err instanceof Error ? err.message : 'Detail lookup failed',
            },
          },
        }))
      }
    },
    [state.zoom],
  )

  const deselect = useCallback((zcta: string) => {
    drillAbort.current[zcta]?.abort()
    delete drillAbort.current[zcta]
    setState((s) => {
      const drilldowns = { ...s.drilldowns }
      delete drilldowns[zcta]
      return { ...s, selected: s.selected.filter((p) => p.zip !== zcta), drilldowns }
    })
  }, [])

  /** Free-text place search, used to add an area to the comparison set. */
  const search = useCallback(
    async (text: string) => {
      lastSearch.current = { text }
      setState((s) => ({ ...s, status: 'searching', error: undefined }))

      const ctrl = new AbortController()
      try {
        const { places, notUsZip } = await geocode(text, ctrl.signal)
        if (notUsZip) {
          // The Census Bureau has a ZCTA record for every US ZIP code, so a
          // miss here means the code is not a US ZIP, and saying so is more
          // useful than a bare "not found".
          setState((s) => ({
            ...s,
            status: 'error',
            error: `"${text}" is not a US ZIP code. This tool covers United States data only — there are about 33,800 of them.`,
          }))
          return
        }
        if (places.length === 0) {
          setState((s) => ({
            ...s,
            status: 'error',
            error: `We could not find "${text}". Try a 5-digit US ZIP code.`,
          }))
          return
        }
        setState((s) => ({ ...s, status: 'idle' }))
        await selectPlace(places[0]!)
      } catch (err) {
        setState((s) => ({ ...s, status: 'error', error: err instanceof Error ? err.message : 'Lookup failed' }))
      }
    },
    [selectPlace],
  )

  // A newly saved key unlocks the sweep, which is the whole dataset. The
  // event only ever fires for the personal key's lifecycle — the shared
  // default is a build-time constant and cannot change while the app runs —
  // but resolution is recomputed here rather than assumed, so removing a
  // personal key on a deployment that carries the shared key falls back to
  // that key (and the sweep reloads on it) instead of dropping to no key.
  useEffect(() => {
    const onKeyChange = () => {
      setState((s) => ({ ...s, ...keyState() }))
      void loadSweep()
    }
    window.addEventListener(CENSUS_KEY_EVENT, onKeyChange)
    return () => window.removeEventListener(CENSUS_KEY_EVENT, onKeyChange)
  }, [loadSweep])

  /**
   * Self-heal the cache before anything is read.
   *
   * A visitor who loaded the site before the sentinel fix is holding rows that
   * render as -666666666. Bumping the version stamp discards them, but asking
   * someone to clear site data by hand to be shown correct numbers is not an
   * acceptable answer. So the cache is swept once per session: any chunk holding
   * an impossible value is dropped and simply re-fetched.
   */
  useEffect(() => {
    let cancelled = false
    void sweepCache.purgeImplausible().then((dropped) => {
      if (cancelled || dropped === 0) return
      if (import.meta.env.DEV) {
        console.info(`CivicScope: discarded ${dropped} cached chunk(s) holding unusable values`)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Loads the country-wide screen on arrival, or says that a key is needed.
   *
   * This used to run only when a key was already stored (`if (getCensusKey())`),
   * which meant a first-time visitor's status stayed 'idle' and every `needs-key`
   * branch in the interface was unreachable — including the key prompt. The site
   * therefore never asked a new visitor for a key at all: they saw a search box
   * that worked for one ZIP code and no explanation of why the country-wide view
   * was empty or how to fix it. Reported by the maintainer on 2026-10-07.
   *
   * `loadSweep` itself handles the no-key case by setting 'needs-key' and
   * returning, with no network request, so calling it unconditionally costs a
   * keyless visitor nothing and makes the prompt reachable.
   */
  useEffect(() => {
    void loadSweep()
  }, [loadSweep])

  useEffect(
    () => () => {
      sweepAbort.current?.abort()
      Object.values(drillAbort.current).forEach((a) => a.abort())
    },
    [],
  )

  useEffect(() => {
    runRef.current = search
  }, [search])

  /**
   * Enumerates the national ZCTA list once, keylessly, and partitions it by
   * each ZCTA's own state from the place index, so the state picker can show
   * real counts before the user commits to a scope. The enumeration is
   * cached for ninety days, so this costs a returning visitor nothing; it
   * runs in the background and never blocks first paint.
   *
   * Measured defect this wiring fixes (2026-11-01): loadStateList previously
   * had no caller anywhere, so the partitions never loaded — the state
   * filter rendered with no options, and the Ask sweep derivation, which
   * intersected its prefixes with the filter's offered codes, always came
   * up empty and applied every named-state bound to the whole country.
   */
  const [stateList, setStateList] = useState<StatePartition[] | null>(null)
  const [stateScope, setStateScope] = useState<string[]>([])
  const stateAbort = useRef<AbortController | null>(null)

  const loadStateList = useCallback(async () => {
    if (stateList) return stateList
    stateAbort.current?.abort()
    const ctrl = new AbortController()
    stateAbort.current = ctrl
    try {
      const [all, index] = await Promise.all([listAllZctas(ctrl.signal), loadPlaceIndex(ctrl.signal)])
      if (!index) return null
      const stateByZip = new Map<string, string>()
      for (const [zip, record] of index.byZip) stateByZip.set(zip, record.state)
      const partitions = buildStatePartitions(all, stateByZip)
      setStateList(partitions)
      return partitions
    } catch {
      return null
    }
  }, [stateList])

  const stateListStarted = useRef(false)
  useEffect(() => {
    if (stateListStarted.current) return
    stateListStarted.current = true
    void loadStateList()
  }, [loadStateList])

  const applyScope = useCallback(
    async (states: string[]) => {
      setStateScope(states)
      await loadSweep({ states })
    },
    [loadSweep],
  )

  const stateChoices: StateOption[] = useMemo(() => (stateList ? stateOptions(stateList) : []), [stateList])
  const totalChunks = useMemo(
    () => estimateChunks(stateList?.reduce((n, g) => n + g.zctas.length, 0) ?? 33791, CHUNK_SIZE),
    [stateList],
  )
  const scopeChunks = useMemo(
    () =>
      estimateChunks(
        stateList
          ? stateList.reduce(
              (n, p) =>
                n +
                p.zctas.filter((z) => stateScope.length === 0 || stateScope.includes(z.slice(0, 2))).length,
              0,
            )
          : 0,
        CHUNK_SIZE,
      ),
    [stateList, stateScope],
  )

  useEffect(
    () => () => {
      stateAbort.current?.abort()
    },
    [],
  )

  const selectedZctas = useMemo(() => state.selected.map((p) => p.zip).filter((z): z is string => Boolean(z)), [state.selected])

  return {
    ...state,
    selectedZctas,
    loadSweep,
    applyScope,
    loadStateList,
    stateChoices,
    stateScope,
    setStateScope,
    toggleState: (option: StateOption) => setStateScope((cur) => toggleStateOption(cur, option)),
    totalChunks,
    scopeChunks,
    scopeLabel: describeScope(stateScope, stateList ?? undefined),
    selectPlace,
    deselect,
    search,
    quota: getQuota(),
  }
}
