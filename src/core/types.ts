/**
 * Core plugin contract.
 *
 * Design rules that keep this system from collapsing as plugins are added:
 *
 *  1. A plugin DECLARES its geography and dependencies. It does not hand-write
 *     fetch waterfalls. The DAG executor resolves the graph, dedupes shared
 *     requests, and fans out concurrently. Adding source #20 must not require
 *     touching the engine or any other plugin.
 *
 *  2. `source` is MANDATORY metadata, not a comment. The methodology page and
 *     the data dictionary are generated from the registry, so documentation
 *     cannot drift out of sync with reality.
 *
 *  3. `legal` is enforced centrally by the engine. Suppression thresholds,
 *     protected-class handling, and notice requirements cannot be forgotten
 *     inside an individual plugin.
 *
 *  4. Nothing here may be personalized. No per-user credit, income, family
 *     status, or protected-class inference. Metrics describe PLACES.
 */

export type GeographyLevel =
  | 'nation'
  | 'state'
  | 'county'
  | 'zip'
  | 'tract'
  | 'blockgroup'
  | 'schoolDistrict'
  | 'school'

export type MetricCategory =
  | 'cost'
  | 'education'
  | 'demographics'
  | 'health'
  | 'environment'
  | 'labor'

/**
 * 'institutions' counts organisations, not people or households — school
 * buildings, for instance. The distinction is load-bearing: the engine's
 * minimum-n suppression exists so a reader cannot over-read a figure about a
 * handful of *people*, and a district with 3 schools is an exact administrative
 * fact the publisher publishes, not a small-sample estimate. Before this unit
 * existed, "Schools in district: 3" was suppressed to "not published" by a rule
 * that was never meant for it.
 */
export type MetricUnit = 'usd' | 'usd_monthly' | 'percent' | 'ratio' | 'number' | 'count' | 'index' | 'institutions'

export type AbsentReason =
  | 'not-applicable'
  | 'not-comparable'
  | 'missing'
  | 'too-few-households'
  | 'out-of-range'

/** The five progressively finer stages of data resolution. */
export type ZoomLevel = 0 | 1 | 2 | 3 | 4

export const ZOOM_LABELS: Record<ZoomLevel, string> = {
  0: 'Country',
  1: 'County',
  2: 'ZIP code',
  3: 'Census tract',
  4: 'School district',
}

/** Identifies where a number came from, precisely enough to re-fetch it. */
export interface SourceRef {
  publisher: string
  dataset: string
  /** e.g. "B25064" in ACS 5-year. Shown to users; makes claims auditable. */
  tableId: string
  /** e.g. "2023" — the data vintage, not the year we fetched it. */
  vintage: string
  url: string
  /** Human-readable citation string shown in the UI. */
  citation?: string
}

export interface MetricValue {
  key: string
  label: string
/** null means the source had no value (not zero). Never coerce null to 0. */
    value: number | null
    /**
     * Why the value is absent, when the publisher said why.
     *
     * "Not applicable" and "we have not loaded it yet" are different answers,
     * and a reader can act on neither without knowing which they are looking at.
     * Verified against the live endpoint for ZCTA 20771, a military ZIP code
     * with no civilian households: the Census Bureau returns not-applicable for
     * every median and a real 0 for the counts, and both are true.
     */
    absentReason?: AbsentReason
  unit: MetricUnit
  /** Fixed decimal places for context figures whose published precision is meaningful. */
  displayPrecision?: number
  category: MetricCategory
  source: SourceRef
  quality: {
    /** 90% confidence margin of error, in the metric's own unit. */
    marginOfError?: number
    /** True when the value was withheld by a suppression rule. */
    suppressed?: boolean
    /**
     * For derived metrics: the exact computation, shown in the UI.
     * Required whenever `derived` is true.
     */
    derivation?: string
    derived?: boolean
  }
  /**
   * True when this metric encodes or proxies a protected characteristic.
   *
   * Stamped by the executor from the plugin's `legal.protectedClassProxy`, so a
   * plugin cannot leave it off an individual metric — the same centralisation the
   * suppression threshold already has. Such metrics are displayed but never
   * offered as a sort or filter control, and `scoring.ts` refuses to fold them
   * into a composite.
   */
  protectedClassProxy?: boolean
  /**
   * Direction of "better", used only for user-chosen sorting and never for an
   * overall quality judgment. The engine never uses this to rank automatically.
   */
  betterWhen?: 'higher' | 'lower'
  /** Area-specific geography that must stay beside this value in comparisons. */
  geographyContext?: string
  /** Longer explanation shown in the metric's detail popover. */
  note?: string
}

export interface QueryContext {
  /** Free-text location as typed by the user. */
  text?: string
  /** Resolved geography from the geocoder, when known. */
  geo?: ResolvedPlace
  /**
   * Census tracts (11-digit FIPS) covering the selected area, resolved once and
   * shared by every tract-level plugin. This is what lets a tract-keyed source
   * like CDC PLACES work without re-deriving geography per plugin.
   */
  tractFips?: string[]
  /** Where the user has drilled down to. */
  zoom: ZoomLevel
  /**
   * The Census API key in effect for this run: the visitor's own when they
   * have added one (held only in their browser), otherwise the deployment's
   * shared application key. See resolveCensusKey in censusKey.ts.
   */
  censusKey?: string
  signal: AbortSignal
}

export interface ResolvedPlace {
  name: string
  /** ZCTA when a postal code is known. */
  zip?: string
  county?: string
  countyFips?: string
  state?: string
  stateFips?: string
  lat?: number
  lon?: number
  /** True only when the source is authoritative for this boundary. */
  precise?: boolean
}

export interface PluginRequest {
  /** Stable, versioned. */
  id: string
  title: string
  category: MetricCategory
  geography: GeographyLevel
  /** Minimum zoom at which this plugin has anything to contribute. */
  minZoom: ZoomLevel
  /**
   * Ids of other plugins whose results this one needs. Declarative only — the
   * engine resolves order, dedupes shared upstream requests, and runs siblings
   * concurrently.
   */
  requires?: string[]
  /**
   * Whether this plugin needs a Census API key. Keyless plugins form the
   * degraded experience that every user gets by default.
   */
  requiresCensusKey?: boolean
  fetch(ctx: QueryContext): Promise<MetricValue[]>
  legal: LegalRule
}

export interface LegalRule {
  /**
   * Hide any cell below this household count (minimum-n suppression). The
   * engine applies this, so a plugin cannot forget it.
   */
  suppressBelow?: number
  /**
   * True if the metric encodes or proxies a protected characteristic. Such
   * metrics are displayed but are NEVER offered as a sort or filter control.
   * This is the single most important rule in the codebase.
   */
  protectedClassProxy?: boolean
  /**
   * Mandatory notice rendered on any page displaying this metric. The Fair
   * Housing Act makes under-disclosure a violation, so notices are required,
   * not optional.
   */
  notice?: string
}

/** Wraps a raw upstream payload with the provenance the UI needs. */
export interface Provenance {
  pluginId: string
  fetchedAt: number
  source: SourceRef
  /** True when served from local cache rather than the network. */
  fromCache: boolean
}
