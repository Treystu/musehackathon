import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHousingQuery } from '../core/useHousingQuery'
import { createLiveProvider, META_API_BASE, MUSE_SPARK_MODEL } from '../core/ai/meta-client'
import { getMetaKey } from '../core/ai/meta-key'
import { DISPLAYABLE_KEYS } from '../core/ai/intent-schema'
import type { ValidatedIntent } from '../core/ai/provider'
import { asStateCode, loadPlaceIndex, splitStateSuffix, type PlaceIndex, type PlaceSuggestion } from '../core/zcta-place-index'
import { FairHousingNotice } from './FairHousingNotice'
import { GuidedTour, TourNotice, shouldShowTour } from './GuidedTour'
import { applyFigureFilters, FIGURE_FILTERS } from '../core/figure-filters'
import { decodeUrl, urlForSelection } from '../core/url-state'
import { SimilarityPanel } from './SimilarityPanel'
import { SavedSearches } from './SavedSearches'
import type { SortableMetricKey } from '../core/sortable-surface'
import { KeyPrompt } from './KeyPrompt'
import { Methodology } from './Methodology'
import { SearchAutocomplete } from './SearchAutocomplete'
import { CityZipBrowser } from './CityZipBrowser'
import { SweepTable } from './SweepTable'
import { Comparison } from './Comparison'
import { FundingSection } from './Funding'
import { StateFilter } from './StateFilter'
import { MapView } from './MapView'
import { sortSweepRows } from '../core/sweep-sorting'
import { scopePrefixesForStates, STATE_NAME_BY_CODE } from '../core/sweep/states'
import { AskPanel } from './ai/AskPanel'
import { BriefingView } from './ai/BriefingView'
import {
  briefingFiguresFromMetrics,
  figureInputsFromAreaRows,
  figureInputsFromMetrics,
} from './ai/figure-input'
import type { FigureResolver } from '../core/ai/briefing'

type View = 'explore' | 'map' | 'methodology'

/**
 * Screening presets.
 *
 * The screen starts in ZIP order. A reader can choose one published figure to
 * order by; that order is criterion-specific and is not an overall judgment.
 */
const PRESETS: { id: string; label: string; sort: SortableMetricKey | null }[] = [
  { id: 'zip', label: 'ZIP code order', sort: null },
  { id: 'rent-burden', label: 'Rent burden', sort: 'median_rent_burden_pct' as const },
  { id: 'rent', label: 'Median rent', sort: 'median_gross_rent' as const },
  { id: 'home-value', label: 'Home value', sort: 'median_home_value' as const },
  { id: 'income', label: 'Household income', sort: 'median_household_income' as const },
  { id: 'households', label: 'Households', sort: 'households' as const },
]

const DEFAULT_PRESET = PRESETS[0]!

/**
 * The live provider, proxy-first (plan section 5, D1/D2).
 *
 * The browser never holds the shared key: /api/muse/* spends it server-side.
 * A visitor's own key is read lazily from localStorage and used only after the
 * shared path reports itself shut off, so a key stored later in the visit works
 * without remounting the app. The stub provider remains in provider.ts for
 * tests; no shipped mount uses it.
 */
const HOUSE_PROVIDER = createLiveProvider({
  direct: { baseUrl: META_API_BASE, model: MUSE_SPARK_MODEL, getApiKey: getMetaKey },
})

type ScreeningSort = {
  presetId: string
  sortKey: SortableMetricKey | null
  ascending: boolean
}

const num = new Intl.NumberFormat('en-US')

/** The ACS release the cached figures come from, so a cached number is never read as current. */
const VINTAGE_LABEL = '2023 5-year release'

export default function App() {
  const [view, setView] = useState<View>('explore')
  /*
   * The explore view's two modes (redesign, 2026-11-01): 'ask' is the
   * front door — the question box and its results, nothing else — and
   * 'data' is the manual apparatus (search, filters, the screening
   * table, map-adjacent tools). One mode on screen at a time; an Ask
   * execution lands the reader on the mode that shows its result.
   */
  const [mode, setMode] = useState<'ask' | 'data'>('ask')
  const [term, setTerm] = useState('')
  const [sorting, setSorting] = useState<ScreeningSort>({
    presetId: DEFAULT_PRESET.id,
    sortKey: DEFAULT_PRESET.sort,
    ascending: true,
  })
  const [showKeyPrompt, setShowKeyPrompt] = useState(false)
  /**
   * Opens the key prompt once, for a visitor who has no key at all.
   *
   * The prompt has always been reachable behind a button, but a first-time
   * visitor had no reason to press it and — until the mount-effect fix in
   * `useHousingQuery` — the button itself never rendered. So they arrived at a
   * search box that answered for one ZIP code, a country-wide view that stayed
   * empty, and no statement of why. The maintainer reported exactly that on
   * 2026-10-07.
   *
   * Once only: "Not now" is remembered for the visit by this ref, and the button
   * below remains the way back. Focus is deliberately not moved into the prompt,
   * so arriving readers are not pulled into a form they did not ask for.
   */
  const autoPrompted = useRef(false)
  const [chosenPlace, setChosenPlace] = useState<PlaceSuggestion | null>(null)
  const [placeError, setPlaceError] = useState<string | null>(null)
  /**
   * `undefined` means still loading; `null` means it could not be fetched.
   *
   * The distinction is kept because they need different copy. While loading, the
   * combobox simply offers nothing yet. Once failed, the reader is told city
   * search is unavailable rather than left waiting for suggestions that will
   * never arrive — and ZIP lookup keeps working either way.
   */
  const [placeIndex, setPlaceIndex] = useState<PlaceIndex | null | undefined>(undefined)
  /**
   * First-visit state.
   *
   * Read during the first render rather than in an effect, so the notice cannot
   * appear a frame late and shift the layout under someone who has already
   * started typing. `shouldShowTour()` is a pure localStorage read, which is why
   * the initialiser can call it without a try/catch of its own.
   *
   * The notice is dismissed by the reader or by opening the dialog; either records
   * that it has been seen, and only the dialog can be reopened.
   */
  const [noticeOpen, setNoticeOpen] = useState(() => shouldShowTour())
  const [tourOpen, setTourOpen] = useState(false)
  const statusRef = useRef<HTMLParagraphElement>(null)

  const q = useHousingQuery()
  const showKeylessGuidance = q.sweepStatus === 'needs-key' && !showKeyPrompt

  /**
   * Fetches the ZIP-to-place mapping once, on mount.
   *
   * It is ~187 kB gzipped and served from `/map/` under an immutable year-long
   * header, so this costs one request the first visit and nothing thereafter. It
   * is fetched eagerly rather than on first keystroke because the screening table
   * shows the city beside every ZIP code, and a column that fills in a second
   * after the table appears is worse than one that was simply never available.
   */
  useEffect(() => {
    let cancelled = false
    void loadPlaceIndex().then((index) => {
      if (!cancelled) setPlaceIndex(index)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // The one-time open. See the `autoPrompted` note above for why it exists.
  useEffect(() => {
    if (autoPrompted.current) return
    if (q.sweepStatus === 'needs-key' && !q.censusKeyPresent) {
      autoPrompted.current = true
      setShowKeyPrompt(true)
    }
  }, [q.sweepStatus, q.censusKeyPresent])

  const searchPlacesIn = useCallback(
    (query: string, limit?: number) => (placeIndex ? placeIndex.search(query, limit) : []),
    [placeIndex],
  )

  /** `"Austin, TX"` for a ZIP code, or null when the mapping is unavailable. */
  const placeLabel = useCallback(
    (zip: string) => placeIndex?.label(zip) ?? null,
    [placeIndex],
  )

  const [similaritySeed, setSimilaritySeed] = useState('')

  const askFigures = useMemo(
    () =>
      Object.values(q.drilldowns).flatMap((detail) =>
        figureInputsFromMetrics(
          detail.metrics,
          [detail.zcta, detail.label, placeLabel(detail.zcta) ?? ''].filter(Boolean),
        ),
      ),
    [q.drilldowns, placeLabel],
  )
  const briefingFigures = useMemo(
    () =>
      Object.values(q.drilldowns).flatMap((detail) =>
        briefingFiguresFromMetrics(detail.metrics, detail.zcta),
      ),
    [q.drilldowns],
  )
  const briefingPlaces = useMemo(
    () => Object.values(q.drilldowns).map((detail) => detail.label || detail.zcta),
    [q.drilldowns],
  )
  /**
   * Pack re-verification re-reads the figure from the data layer's
   * current drilldown state at generation time — not from the snapshot
   * the panel rendered with — so a figure changed since render fails
   * its check instead of shipping.
   */
  const resolveBriefingFigure: FigureResolver = useCallback(
    async (figure) => {
      const detail = q.drilldowns[figure.geography]
      const metric = detail?.metrics.find((m) => m.key === figure.key)
      if (!metric) return null
      return { value: metric.value, marginOfError: metric.quality.marginOfError }
    },
    [q.drilldowns],
  )
  const savedViewFigures = useCallback(
    (zips: readonly string[]) =>
      figureInputsFromAreaRows(q.sweep, zips, ['median_gross_rent', 'median_home_value']),
    [q.sweep],
  )

  /** Adds one ZIP code, resolving its city for the header when we have one. */
  const addZip = useCallback(
    (zip: string) => {
      const place = placeIndex?.lookup(zip)
      void q.selectPlace({ name: place?.displayName ?? `ZIP ${zip}`, zip, state: place?.state })
    },
    [placeIndex, q.selectPlace],
  )

  /**
   * Runs a parsed Ask intent into the view it names.
   *
   * This is the half of Ask that was missing: a validated intent used to have
   * nowhere to go, so Run rendered disabled. Each mode now lands on the surface
   * that already exists rather than on a new one.
   *
   * Three rules are enforced here rather than trusted to the model:
   * - A geography is resolved through the same place index the search box uses;
   *   an unresolvable name contributes nothing instead of a guessed ZIP.
   * - A sweep bound the screening surface cannot express is dropped. The surface
   *   offers a maximum for rent, burden and home value and a minimum for
   *   households; turning "rent over $500" into "rent under $500" would answer
   *   the opposite question, which is worse than not running it.
   * - A sweep geography scopes the screen. The bound alone used to apply to
   *   the whole loaded table, so "places in Colorado under $1,500" listed
   *   Kentucky — the same bound over a different set than the question named
   *   (found live, 2026-11-01). The named places resolve to their states and
   *   the screen re-scopes through the manual state filter's own machinery;
   *   a geography whose state cannot be pinned down is disclosed in the run
   *   note rather than silently dropped.
   */
  const executeIntent = useCallback(
    (intent: ValidatedIntent): string => {
      const zips: string[] = []
      for (const geography of intent.geographies) {
        if (/^\d{5}$/.test(geography.trim())) {
          if (!zips.includes(geography.trim())) zips.push(geography.trim())
          continue
        }
        // Prefer a city record over a county fallback. A county record's
        // first ZIP can be a small area with no published figure for the
        // measure asked about — the Honolulu comparison opened on exactly
        // one (96759, no rent figure) while the city's own ZIPs carry the
        // figures (found live, 2026-11-01). The search box still offers
        // every record; choosing between them is execution's job.
        const hits = placeIndex?.search(geography, 8) ?? []
        const resolved = (hits.find((hit) => hit.isCity) ?? hits[0])?.zips[0]
        if (resolved && !zips.includes(resolved)) zips.push(resolved)
      }

      if (intent.mode === 'lookup' || intent.mode === 'compare') {
        if (zips.length === 0) {
          return 'No ZIP code could be resolved from the places in this request, so nothing was opened.'
        }
        for (const zip of zips) addZip(zip)
        setView('explore')
        setMode('ask')
        return `Opened ${zips.length === 1 ? '1 place' : `${zips.length} places`} in the comparison.`
      }

      if (intent.mode === 'sweep_filter') {
        const next: Partial<Record<SortableMetricKey, number | null>> = {}
        let dropped = 0
        for (const filter of intent.filters) {
          if (filter.metricKey === 'households' && filter.op === 'gt') {
            next.households = filter.value
          } else if (filter.metricKey !== 'households' && (filter.op === 'lt' || filter.op === 'eq_range')) {
            next[filter.metricKey as SortableMetricKey] = filter.value
          } else {
            dropped += 1
          }
        }
        // Placeless sweep = the national screen (core/ai/national-screen.ts):
        // the scope is the whole country and the sort is the request, so a
        // bound is not required. Clear any state scope a previous run left,
        // clear previous bounds, sort by the named measure, and say what the
        // screen covers. A placed sweep without an expressible bound still
        // stops at the note below and changes nothing.
        if (intent.geographies.length === 0 && Object.keys(next).length === 0) {
          const preset = PRESETS.find((item) => item.sort === intent.metricKeys[0])
          if (preset) {
            if (q.stateScope.length > 0) void q.applyScope([])
            setFigureFilters({})
            setSorting({ presetId: preset.id, sortKey: preset.sort, ascending: true })
            setView('explore')
            setMode('data')
            return `Screening the whole country by ${preset.label.toLowerCase()}, lowest first — the table below is sorted by that figure.`
          }
        }
        if (Object.keys(next).length === 0) {
          return 'This bound cannot be set on the screening table, which offers a maximum for rent, rent burden and home value and a minimum for households. Nothing was changed.'
        }

        // Scope the screen to the states the request names, through the same
        // scope the manual state filter drives. A state's scope is its ZIP
        // prefixes, derived from the place index — the index is the authority
        // on which state a ZIP is in. An earlier version intersected those
        // prefixes with the filter's offered codes; the offered list was
        // empty in practice (its loader had no caller), so the intersection
        // silently emptied every scope and the bound applied nationally.
        const namedStates: string[] = []
        for (const geography of intent.geographies) {
          const state = asStateCode(geography) ?? splitStateSuffix(geography.trim().toLowerCase()).state
          if (state && !namedStates.includes(state)) namedStates.push(state)
        }
        const scopePrefixes: string[] =
          placeIndex && namedStates.length > 0 ? scopePrefixesForStates(placeIndex.places, namedStates) : []
        let scopeNote = ''
        if (intent.geographies.length > 0 && scopePrefixes.length === 0) {
          scopeNote = ' The place in this request could not be matched to a state, so the bound was applied to the whole loaded table.'
        } else if (scopePrefixes.length > 0) {
          const label =
            namedStates.length === 1
              ? (STATE_NAME_BY_CODE[namedStates[0]!] ?? namedStates[0]!)
              : `${namedStates.length} states`
          const alreadyScoped =
            scopePrefixes.length === q.stateScope.length &&
            scopePrefixes.every((prefix) => q.stateScope.includes(prefix))
          if (alreadyScoped) {
            scopeNote = ` The screen is showing ${label}.`
          } else {
            void q.applyScope(scopePrefixes)
            scopeNote = ` The screen is narrowing to ${label} (it scopes by state${namedStates.some((s) => !intent.geographies.some((g) => asStateCode(g) === s)) ? ', not by city' : ''}); its figures fill in below.`
          }
        }

        if (intent.geographies.length === 0) {
          // A placeless bound applies to the whole country; widen any
          // state scope a previous run left and say so.
          if (q.stateScope.length > 0) {
            void q.applyScope([])
            scopeNote = ' The screen widened back to the whole country.'
          } else {
            scopeNote = ' The bound applies to the whole country.'
          }
        }

        setFigureFilters(next)
        const preset = PRESETS.find((item) => item.sort === intent.metricKeys[0])
        if (preset) setSorting({ presetId: preset.id, sortKey: preset.sort, ascending: true })
        setView('explore')
        setMode('data')
        return (
          (dropped === 0
            ? 'Applied the bound to the screening table below.'
            : `Applied ${Object.keys(next).length} bound(s); ${dropped} could not be expressed by the table and was not applied.`) + scopeNote
        )
      }

      const seed = zips[0]
      if (!seed) {
        return 'The place this similarity request starts from could not be resolved to a ZIP code.'
      }
      addZip(seed)
      setSimilaritySeed(seed)
      setView('explore')
      setMode('data')
      return `Opened similar-ZIP search from ${seed}.`
    },
    [addZip, placeIndex, q.applyScope, q.stateScope],
  )

  /*
   * A comparison carried in the URL.
   *
   * Two directions, both deliberate:
   *
   * On arrival, `?z=` pre-selects the ZIP codes a shared link names, so a reader
   * arriving from someone else's link sees what the sender saw without typing
   * anything. The parameter is untrusted input and goes through the same
   * validation as everything else: invalid entries are dropped silently and the
   * site loads normally (`src/core/url-state.ts`).
   *
   * After that, the URL follows the selection rather than leading it:
   * `history.replaceState`, not `pushState`, so adding a fifth area is not five
   * entries of back-button history and pressing Back leaves the site rather than
   * replaying the reader's own selections one removal at a time.
   */
  const restoredFromUrl = useRef(false)
  useEffect(() => {
    if (restoredFromUrl.current) return
    const shared = decodeUrl(window.location.href)
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      restoredFromUrl.current = true
      for (const zip of shared) addZip(zip)
    })
    return () => {
      cancelled = true
    }
  }, [addZip])

  useEffect(() => {
    if (!restoredFromUrl.current) return
    const next = urlForSelection(window.location.href, q.selectedZctas)
    if (next !== window.location.href) window.history.replaceState(null, '', next)
  }, [q.selectedZctas])

  /**
   * Submits the search box.
   *
   * A five-digit code is a direct lookup. Anything else is resolved against the
   * mapping, and the result is a list of ZIP codes to choose from rather than one
   * area picked for the reader: "Springfield" is a city in at least six states,
   * and silently choosing one would put the wrong neighbourhood on screen with no
   * indication that a choice had been made. Previously this path asked Photon,
   * which returned a single city centroid with no ZIP at all — and `selectPlace`
   * returns immediately without one, so clicking that suggestion did nothing.
   */
  function submit(e: React.FormEvent) {
    e.preventDefault()
    const text = term.trim()
    if (!text) return
    setPlaceError(null)

    if (/^\d{5}$/.test(text)) {
      setChosenPlace(null)
      void q.search(text)
      return
    }

    if (!placeIndex) {
      setPlaceError(
        'City search is not available right now, because the ZIP-to-city list could not be loaded. A five-digit ZIP code still works.',
      )
      return
    }

    const matches = placeIndex.search(text, 8)
    if (matches.length === 0) {
      setChosenPlace(null)
      setPlaceError(
        `No US city or ZIP code matches "${text}". This tool covers United States data only — there are about 33,800 ZIP codes.`,
      )
      return
    }
    // One match is still shown as a list rather than opened directly, because the
    // reader may want a specific ZIP code inside it.
    setChosenPlace(matches[0]!)
    if (matches.length > 1) {
      setTerm('')
    }
  }

  // Announce async state to assistive technology. With a sweep of ~41,000 rows
  // the loading transition is substantial, and silence here would strand a
  // screen-reader user.
  useEffect(() => {
    const el = statusRef.current
    if (!el) return
    if (q.sweepStatus === 'loading') {
      const p = q.sweepProgress
      el.textContent = p
        ? `Loading ${p.scope}: ${p.done} of ${p.total} areas, ${num.format(p.rows)} ZIP codes so far.`
        : 'Loading housing data for ZIP codes.'
    } else if (q.sweepStatus === 'ready')
      el.textContent = `Loaded ${num.format(q.sweep.length)} ZIP codes${q.sweepScope.length ? '' : ' for the whole country'}.`
    else if (q.sweepStatus === 'needs-key') el.textContent = 'A free Census key is needed to load the data.'
    else if (q.sweepStatus === 'error') el.textContent = q.sweepError ?? 'Could not load the data.'
    else if (q.status === 'error') el.textContent = q.error ?? 'Something went wrong.'
  }, [
    q.sweepStatus,
    q.sweep.length,
    q.sweepError,
    q.sweepScope.length,
    q.sweepProgress?.done,
    q.sweepProgress?.total,
    q.sweepProgress?.rows,
    q.sweepProgress?.scope,
    q.status,
    q.error,
  ])


  // Affordability screen, derived from the sweep. This is the "check every ZIP
  // code for one aspect" capability: the whole country is already in memory, so
  // a filter is a local operation and costs nothing.
  /**
   * The reader's figure bounds, keyed by allowlisted metric. Empty = no filter.
   *
   * Held as raw numbers rather than parsed strings so an empty input is
   * distinguishable from a zero, which the filters treat differently: zero is a
   * bound, empty is "not asking".
   */
  const [figureFilters, setFigureFilters] = useState<Partial<Record<SortableMetricKey, number | null>>>({})

  const activeFilters = useMemo(
    () =>
      FIGURE_FILTERS.map((f) => ({ ...f, value: figureFilters[f.metric] ?? null })).filter(
        (f) => f.value !== null && Number.isFinite(f.value),
      ),
    [figureFilters],
  )

  const sweepRows = useMemo(() => {
    if (q.sweep.length === 0) return []
    // Every loaded ZIP is kept, including those with no figure for this
    // column. Filtering them out here used to hide about 7,290 of the 33,791 ZIP
    // codes from the screening table whenever a sparse column was chosen, which
    // reads as "this area does not exist" rather than "no estimate published" —
    // the one confusion this app exists to avoid. Absent figures now render as
    // "not yet imported" and sort last, which is what they mean.
    //
    // The reader's figure bounds are then applied, which DOES exclude rows
    // without a value — a bound is a question, and an area with no figure is not
    // an answer to it. The difference is who asked: nobody asks to see all
    // 33,791 rows including empty ones, but a person setting "rent under $1,200"
    // has asked a specific question. The count beside the table states how many
    // were kept, so the removal is visible rather than silent.
    const sorted = sortSweepRows(q.sweep, sorting.sortKey, sorting.ascending)
    return activeFilters.length === 0 ? sorted : applyFigureFilters(sorted, activeFilters)
  }, [q.sweep, sorting.sortKey, sorting.ascending, activeFilters])

  /*
   * The Ask homepage's live stat band (competition layer, 2026-11-01):
   * three figures computed from the loaded screen itself — never
   * literals — so the band can only ever say what the data says. Null
   * until the screen has rows with the figures it needs.
   */
  const screenStats = useMemo(() => {
    if (q.sweep.length === 0) return null
    let cheapest: { row: (typeof q.sweep)[number]; value: number } | null = null
    const rents: number[] = []
    for (const row of q.sweep) {
      const rent = row.metrics['median_gross_rent']
      if (rent != null) {
        rents.push(rent)
        if (cheapest === null || rent < cheapest.value) cheapest = { row, value: rent }
      }
    }
    if (cheapest === null || rents.length === 0) return null
    rents.sort((a, b) => a - b)
    const medianRent = rents[Math.floor(rents.length / 2)]!
    return { count: q.sweep.length, cheapest, medianRent }
  }, [q.sweep])

  /**
   * The lookup form and the Census key prompt.
   *
   * Shared by Explore and Map rather than duplicated, because a visitor who
   * opens the map and then wants to compare a specific ZIP has to be able to
   * search from there. Two copies of a search box that subtly drift apart is a
   * worse bug than one shared component.
   */
  const searchPanel = (
    <>
      <section aria-labelledby="search-heading" className="panel panel-padded">
        <h2 id="search-heading" className="text-sm font-semibold text-slate-900">
          Look up a ZIP code or a city
        </h2>
        <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
          <label htmlFor="place" className="sr-only">
            US ZIP code, or city and state
          </label>
          {/*
            The input is a combobox and owns the suggestion relationship itself, so
            the autocomplete component renders it. `role="combobox"`,
            `aria-expanded` and `aria-activedescendant` all live on the field,
            which is what keeps focus in the text box while a virtual cursor
            moves through the options.
          */}
          <SearchAutocomplete
            value={term}
            onChange={setTerm}
            onChoose={(place) => {
              setPlaceError(null)
              setChosenPlace(place)
            }}
            loading={placeIndex === undefined}
            search={searchPlacesIn}
          />
          <button
            type="submit"
            className="rounded-full bg-[rgb(var(--accent))] px-4 py-2 text-sm font-medium text-white hover:bg-[rgb(var(--accent-dark))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent))] focus-visible:ring-offset-2"
          >
            Add to comparison
          </button>
        </form>

        <p className="mt-2 text-xs text-slate-600">
          A five-digit ZIP code goes straight to that area. A city name offers every ZIP code inside it, so you can
          pick the neighbourhood rather than whichever one comes first.
        </p>

        {placeError && (
          <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900" role="alert">
            {placeError}
          </p>
        )}

        {chosenPlace && (
          <CityZipBrowser
            place={chosenPlace}
            selectedZctas={q.selectedZctas}
            onAdd={(zip) => addZip(zip)}
            onDismiss={() => setChosenPlace(null)}
          />
        )}

        <p ref={statusRef} role="status" aria-live="polite" className="mt-3 min-h-5 text-sm text-slate-700" />

        {q.status === 'error' && (
          <p className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-900" role="alert">
            {q.error}
          </p>
        )}
      </section>

      {q.sweepStatus === 'needs-key' && !showKeyPrompt && (
        <button
          type="button"
          onClick={() => setShowKeyPrompt(true)}
          className="panel panel-padded mt-4 w-full text-left text-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          <span className="font-semibold text-slate-900">Load every ZIP code in the country — free.</span>
          <span className="mt-1 block text-slate-700">
            The Census Bureau requires a free API key so they can track usage. It takes about a minute, and your
            key is stored only in this browser. We never see it and keep no record of your searches.
          </span>
        </button>
      )}

      {showKeyPrompt && (
        <div className="mt-4">
                <KeyPrompt onDismiss={() => setShowKeyPrompt(false)} autoFocus={false} />
        </div>
      )}

      {/* The agent-setup surface lives in the Ask panel (the single
          canonical AgentHandoff). A second mount here was removed in the
          2026-11-01 simplification: two instances of the same panel on
          one page read as a contradiction, and the explore view's job
          is the data. */}
    </>
  )

  /*
   * The shell.
   *
   * The header is sticky and translucent with a backdrop blur, so the view
   * switcher is reachable without scrolling back up through a full-country
   * table. The wordmark is set larger and tighter than the strapline, and the
   * strapline is de-emphasised, because the product name is the only thing on
   * the line that is not descriptive.
   *
   * The nav contract is unchanged deliberately: the buttons keep their labels,
   * their `aria-current`, and their order, because the accessibility suite and
   * the gate both select on them.
   */
  return (
    <div className="min-h-screen">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:shadow-lg"
          >
            Skip to main content
          </a>

          {/*
            Mounted at the shell so it is reachable from every view. Nothing modal
            opens by itself: the first visit gets an inline notice, and this
            dialog appears only when someone asks for it.
          */}
          <GuidedTour
            open={tourOpen}
            onDismiss={() => {
              setTourOpen(false)
              setNoticeOpen(false)
            }}
          />

          <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                {/* The pin mark from the favicon, at header scale: the
                    wordmark alone read as plain text in the screenshot
                    audit (2026-11-01) - the app had a mark everywhere
                    except the page itself. Decorative: the h1 names the
                    product for assistive tech. */}
                <img src="/favicon.svg" alt="" className="h-8 w-8 shrink-0" />
                <div className="min-w-0">
                  <h1 className="text-lg font-medium tracking-tight text-slate-900">CivicScope</h1>
                  <p className="text-xs leading-snug text-slate-600">
                    Every ZIP code in the US, from federal data, in your browser.
                  </p>
                </div>
                {/*
                  The permanent way back into the tour. Without it, dismissal would
                  be permanent and the orientation would be unreachable for anyone
                  who closed it too early — which is the common case, not the
                  exception.
                */}
                <button
                  type="button"
                  onClick={() => setTourOpen(true)}
                  className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                >
                  How this works
                </button>
              </div>
          <nav aria-label="Primary">
            <ul className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-sm">
              {(
                [
      ['explore', 'Explore'],
      ['map', 'Map'],
      ['methodology', 'Methodology'],
                ] as const
              ).map(([id, label]) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => setView(id)}
                    aria-current={view === id ? 'page' : undefined}
                    className={`rounded-md px-3 py-1.5 font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
                      view === id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:bg-white/70 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl px-4 py-10">
        {noticeOpen && (
          <div className="mx-auto max-w-3xl">
            <TourNotice
              onOpen={() => {
                setTourOpen(true)
                setNoticeOpen(false)
              }}
              onDismiss={() => setNoticeOpen(false)}
            />
          </div>
        )}
        {view === 'methodology' ? (
          <Methodology />
        ) : view === 'map' ? (
          <>
            {searchPanel}

            {q.sweepStatus === 'needs-key' ? (
              <p className="mt-6 text-sm text-slate-700">
                Add a free Census key above to load every ZIP code, then the map draws them.
              </p>
            ) : q.sweep.length === 0 ? (
              <p className="mt-6 text-sm text-slate-700" role="status" aria-live="polite">
                Loading the country-wide figures the map draws from…
              </p>
            ) : (
              <>
                <MapView
                  rows={q.sweep}
                  loading={(q.sweepProgress?.done ?? 0) < (q.sweepProgress?.total ?? 0)}
                  selectedZctas={q.selectedZctas}
                  explainProvider={HOUSE_PROVIDER}
                  onSelect={(zctas) => {
                    for (const zcta of zctas.slice(0, 6)) {
                      const row = q.sweep.find((r) => r.zcta === zcta)
                      if (row) void q.selectPlace({ name: row.name, zip: zcta })
                    }
                  }}
                />

                <Comparison
                  drilldowns={q.drilldowns}
                  onDeselect={q.deselect}
                  placeLabel={placeLabel}
                  explainProvider={HOUSE_PROVIDER}
                />

                {q.sweepFromCache && (
                  <p className="mt-2 text-xs text-slate-500">
                    Loaded from this browser&rsquo;s local cache. Figures come from the American Community
                    Survey {VINTAGE_LABEL} and update annually; use Refresh in the cache panel to re-fetch.
                  </p>
                )}
              </>
            )}

            {q.selected.length > 0 && <FundingSection />}
            {q.selected.length > 0 && (
              <div className="mt-8">
                <FairHousingNotice />
              </div>
            )}
          </>
        ) : (
          <>
            {/*
              The mode switch (redesign, 2026-11-01): Ask is the front
              door and the default; the manual apparatus lives under
              Explore the data. Labels avoid colliding with the Ask
              submit button ("Ask") and the mic ("Speak a question").
            */}
            <div className="anim-rise mb-10 flex justify-center">
              <div
                role="group"
                aria-label="Choose how to work"
                className="inline-flex rounded-full bg-slate-100 p-1 text-sm"
              >
                {(
                  [
                    ['ask', 'Ask a question'],
                    ['data', 'Explore the data'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMode(id)}
                    aria-pressed={mode === id}
                    className={`min-h-[44px] rounded-full px-4 py-2 font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
                      mode === id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {mode === 'ask' && (
              <div className="hero-glow anim-rise anim-rise-1 mx-auto max-w-3xl px-2 pb-4 pt-2">
                {/* The hero mark: the pin at display size above the
                    question box, the way a search page centers its mark
                    over the box. Decorative — the header h1 names the
                    product. */}
                <img src="/favicon.svg" alt="" className="mx-auto mb-3 h-14 w-14" />
                <AskPanel
                  provider={HOUSE_PROVIDER}
                  figures={askFigures}
                  onExecute={executeIntent}
                  clarificationCandidates={{ geographies: [], metricKeys: [...DISPLAYABLE_KEYS] }}
                />
              </div>
            )}
            {mode === 'ask' && q.selected.length === 0 && screenStats && (
              <div className="anim-rise anim-rise-2 mx-auto mt-10 grid max-w-4xl grid-cols-1 gap-6 border-t border-slate-200 pt-8 text-center sm:grid-cols-3">
                <div>
                  <p className="figure-value text-3xl">{num.format(screenStats.count)}</p>
                  <p className="figure-label mt-1">ZIP codes on the live screen</p>
                </div>
                <div>
                  <p className="figure-value text-3xl">
                    ${num.format(screenStats.cheapest.value)}
                    <span className="figure-unit"> /mo</span>
                  </p>
                  <p className="figure-label mt-1">
                    Cheapest median rent — {screenStats.cheapest.row.name} · {screenStats.cheapest.row.zcta}
                  </p>
                </div>
                <div>
                  <p className="figure-value text-3xl">
                    ${num.format(screenStats.medianRent)}
                    <span className="figure-unit"> /mo</span>
                  </p>
                  <p className="figure-label mt-1">Median rent across the screen</p>
                </div>
              </div>
            )}
            {briefingPlaces.length > 0 && (
              <div className="mx-auto mt-12 max-w-3xl border-t border-slate-200 pt-8">
                <BriefingView
                  provider={HOUSE_PROVIDER}
                  title="Selected places"
                  viewKind="drilldown selection"
                  places={briefingPlaces}
                  figures={briefingFigures}
                  resolveFigure={resolveBriefingFigure}
                />
              </div>
            )}
            {mode === 'data' && searchPanel}
            {mode === 'data' && showKeylessGuidance && (
              <section className="mt-4 panel panel-padded">
                <h2 className="text-sm font-semibold text-slate-900">What you can do without a key</h2>
                <p className="mt-1 text-sm text-slate-700">
                  ZIP lookup, Census-tract boundaries, school district staffing and enrollment, and health measures
                  work without a key. The full country-wide screen needs one.
                </p>
                <FundingSection />
              </section>
            )}

            {mode === 'data' && (q.sweepStatus === 'idle' || q.stateScope.length > 0) && q.censusKeyPresent && (
              <div className="mt-4">
                <StateFilter
                  options={q.stateChoices}
                  selected={q.stateScope}
                  onToggle={q.toggleState}
                  onClear={() => q.setStateScope([])}
                  onApply={() => void q.applyScope(q.stateScope)}
                  totalChunks={q.totalChunks}
                  scopeChunks={q.scopeChunks}
                  busy={false}
                />
              </div>
            )}
            {mode === 'data' && q.sweepStatus === 'loading' && (
              <section className="mt-4 panel panel-padded" role="status" aria-busy="true">
                <h2 className="text-sm font-semibold text-slate-900">
                  Loading {q.sweepProgress?.scope ?? 'housing data'}
                </h2>
                {q.sweepProgress ? (
                  <>
                    {/* aria-busy above tells assistive tech the region is
                        still updating; the bar is decorative, the text
                        carries the actual state. */}
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="h-full bg-[rgb(var(--accent))] transition-[width] duration-300"
                        style={{
                          width: `${q.sweepProgress.total ? Math.round((q.sweepProgress.done / q.sweepProgress.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <p className="section-note mt-2">
                      {q.sweepProgress.done} of {q.sweepProgress.total} areas ·{' '}
                      {num.format(q.sweepProgress.rows)} ZIP codes ready
                      {q.sweepProgress.failed > 0 && ` · ${q.sweepProgress.failed} failed`}
                    </p>
                    {q.sweepProgress.budget && (
                      <p className="mt-1 text-xs text-slate-500">
                        {q.sweepProgress.budget.remaining} of {q.sweepProgress.budget.limit} requests left
                        today. Areas already loaded are cached, so returning to this page costs nothing.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mt-1 text-sm text-slate-700">Working out which areas to load…</p>
                )}
                <p className="section-note mt-2">
                  <strong>You do not have to wait.</strong> Look up a ZIP code above and you will get its full
                  figures immediately — that request is separate and takes a couple of seconds.
                </p>
                {/*
                  The table is already usable while this runs, so the copy has to
                  say so rather than implying the page is blocked.
                */}
                <p className="mt-1 text-sm text-slate-700">
                  Rows appear below as each area loads; sorting and filtering work on what has arrived.
                </p>
              </section>
            )}

            {mode === 'data' && q.sweepStatus === 'error' && (
              <p className="mt-4 rounded-md bg-red-50 p-4 text-sm text-red-900" role="alert">
                The country-wide load failed: {q.sweepError}. Individual ZIP lookups still work.{' '}
                <button type="button" onClick={() => void q.loadSweep()} className="underline">
                  Try again
                </button>
              </p>
            )}

            {/* The screen appears as soon as the first chunk lands rather than
                after the last one. During a 43-chunk country-wide load this is
                the difference between a usable table after a second and a blank
                page for two minutes. */}
            {mode === 'data' && q.sweep.length > 0 && (
              <>
                <section aria-labelledby="screen-heading" className="mt-6">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 id="screen-heading" className="section-title">
                      Screen every ZIP code
                    </h2>
                    <p className="text-xs text-slate-500">
                      {num.format(q.sweep.length)} areas loaded
                      {q.sweepFromCache ? ' from local cache' : ''} · {q.quota.used} request
                      {q.quota.used === 1 ? '' : 's'} from this browser
                    </p>
                  </div>

                  <fieldset className="mt-3">
                    <legend className="text-sm font-medium text-slate-800">Choose a figure to sort by</legend>
                    <p className="mt-1 text-xs text-slate-600">
                      The list starts in ZIP code order. Choose one figure, then select its column header again to
                      reverse direction. Every figure stays visible.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {PRESETS.map((p) => (
                        <label
                          key={p.id}
                          className={`cursor-pointer rounded-md border px-3 py-2 text-sm ${
                            sorting.presetId === p.id
                              ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent))] text-white'
                              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="radio"
                            name="preset"
                            value={p.id}
                            checked={sorting.presetId === p.id}
                            onChange={() =>
                              setSorting({ presetId: p.id, sortKey: p.sort, ascending: true })
                            }
                            className="sr-only"
                          />
                          <span className="font-medium">{p.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  {/*
                    Figure filters, inside a disclosure so the default view is
                    unchanged. A filter is one half of the surface
                    `src/core/types.ts` calls the single most important rule in
                    the codebase — a metric that proxies a protected
                    characteristic must never be offered as a sort OR filter
                    control — so these draw from the same allowlist as the sort
                    columns, and school and health measures are absent by
                    decision (issue #5), not by oversight.
                  */}
                  <details className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                    <summary className="min-h-[44px] cursor-pointer text-sm font-medium text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900">
                      Narrow by figures (rent, burden, home value, households)
                    </summary>
                    <p className="mt-1 text-xs text-slate-600">
                      Keeps only the areas inside the bounds you set, in the order you were already viewing. This
                      filters; it does not rank, and an area with no published figure for a bound you set is left
                      out rather than shown.
                    </p>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {FIGURE_FILTERS.map((f) => {
                        const id = `filter-${f.metric}`
                        const label =
                          f.metric === 'median_gross_rent'
                            ? 'Max median gross rent ($/mo)'
                            : f.metric === 'median_rent_burden_pct'
                              ? 'Max rent burden (% of income)'
                              : f.metric === 'median_home_value'
                                ? 'Max median home value ($)'
                                : 'Min households'
                        return (
                          <div key={f.metric}>
                            <label htmlFor={id} className="block text-xs font-medium text-slate-700">
                              {label}
                            </label>
                            <input
                              id={id}
                              type="number"
                              min={0}
                              inputMode="numeric"
                              value={figureFilters[f.metric] ?? ''}
                              onChange={(e) => {
                                const raw = e.target.value
                                setFigureFilters((prev) => ({
                                  ...prev,
                                  [f.metric]: raw === '' ? null : Number(raw),
                                }))
                              }}
                              className="mt-1 w-full min-h-[44px] rounded-md border border-slate-300 px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                            />
                          </div>
                        )
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => setFigureFilters({})}
                      className="mt-2 min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                    >
                      Clear all bounds
                    </button>
                  </details>

                  {/*
                    Similar-ZIP search, off by default and reader-weighted. It
                    sits with the screening tools because it reads the same
                    in-memory screen; it is a separate disclosure so that its
                    off state is the default view, not an absence.
                  */}
                  <SimilarityPanel
                    key={similaritySeed || 'similarity'}
                    sweep={q.sweep}
                    selected={q.selectedZctas}
                    onAdd={(zcta) => addZip(zcta)}
                    explainProvider={HOUSE_PROVIDER}
                    initialOriginZip={similaritySeed}
                  />

                  <SweepTable
                    rows={sweepRows}
                    sortKey={sorting.sortKey}
                    ascending={sorting.ascending}
                    onSortChange={(sortKey, ascending) => {
                      const next = PRESETS.find((item) => item.sort === sortKey)
                      if (next) setSorting({ presetId: next.id, sortKey, ascending })
                    }}
                    onAdd={(zcta) => {
                      // Routed through addZip so the comparison header and the
                      // table row agree on the area's name. Previously each
                      // surface invented its own label from whatever it had to
                      // hand.
                      addZip(zcta)
                    }}
                    selectedZctas={q.selectedZctas}
                    placeLabel={placeLabel}
                    explainProvider={HOUSE_PROVIDER}
                  />
                </section>

                <Comparison
                  drilldowns={q.drilldowns}
                  onDeselect={q.deselect}
                  placeLabel={placeLabel}
                  explainProvider={HOUSE_PROVIDER}
                />
              </>
            )}

            {mode === 'data' && q.sweep.length > 0 && (
              <>
                {/*
                  The figures are cached so a revisit is instant, which means a
                  number on screen may be days old. Saying so is the difference
                  between a cache that feels fast and one that misleads.
                */}
                {q.sweepFromCache && (
                  <p className="mt-2 text-xs text-slate-500">
                    Loaded from this browser&rsquo;s local cache. Figures come from the American Community
                    Survey {VINTAGE_LABEL} and update annually; use Refresh in the cache panel to re-fetch.
                  </p>
                )}
                {q.sweepError && (
                  <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900" role="status">
                    {q.sweepError}
                  </p>
                )}
              </>
            )}

            {/* Keep the comparison visible until the first sweep rows arrive.
                In Ask mode it is the result region, so it shows whenever a
                selection exists (the sweep-section comparison covers the
                data mode when rows are loaded). */}
            {q.selected.length > 0 && (mode === 'ask' || q.sweep.length === 0) && (
              <Comparison
                drilldowns={q.drilldowns}
                onDeselect={q.deselect}
                placeLabel={placeLabel}
                explainProvider={HOUSE_PROVIDER}
              />
            )}

            {/*
              Saved comparisons, mounted in the data mode of the explore
              view (redesign, 2026-11-01: the mode gate is a navigation
              state, not a selection state). The panel hides itself when
              there is nothing to save and nothing saved, but it must NOT
              live inside a "selection present" branch: an empty
              comparison is exactly when Restore matters, and a panel that
              vanishes with the last removed area strands every saved entry.
              Found by a browser test that emptied the comparison before
              restoring, which is a perfectly ordinary thing for a reader to do.
            */}
            {mode === 'data' && (
              <SavedSearches
                selectedZctas={q.selectedZctas}
                onRestore={(zips) => zips.forEach(addZip)}
                explainProvider={HOUSE_PROVIDER}
                figuresForSaved={savedViewFigures}
              />
            )}

            {/*
              The Fair Housing notice is rendered unconditionally whenever
              neighbourhood data is on screen. It used to sit inside the
              "sweep loaded" branch, which meant it disappeared for exactly the
              visitors who had not yet added a Census key — the people least
              informed about how to read the figures. It is a legal disclosure,
              not a decoration, so its presence cannot depend on application
              state.
            */}
            {q.selected.length > 0 && !showKeylessGuidance && <FundingSection />}

            {q.selected.length > 0 && (
              <div className="mt-8">
                <FairHousingNotice />
              </div>
            )}
          </>
        )}
      </main>

      <footer className="mt-12 border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-6 text-xs text-slate-600">
          <p>
            CivicScope is free, open, and carries no advertising. It does not sell, broker, or refer listings
            and does not accept payment for placement in any result.
          </p>
          <p className="mt-2">
            Data is fetched directly from its publishers by your browser. We operate no server that records
            your searches, and we hold no copy of the data.
          </p>
          <p className="mt-2">
            This product uses the Census Bureau Data API but is not endorsed or certified by the Census
            Bureau. Geocoding by OpenStreetMap contributors (ODbL).
          </p>
        </div>
      </footer>
    </div>
  )
}

