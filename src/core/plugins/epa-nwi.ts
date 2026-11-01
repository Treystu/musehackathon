/**
 * Curated EPA Smart Location Database context for a selected ZIP's geocoded point.
 *
 * One public ArcGIS request supplies a small set of measures across the SLD's
 * density, diversity, design, transit, and destination-access domains. The
 * result describes the containing block group, not a ZIP-wide average.
 */

import { getJson } from '../http'
import type { MetricValue, PluginRequest, QueryContext, SourceRef } from '../types'

export const EPA_SLD_QUERY =
  'https://geodata.epa.gov/arcgis/rest/services/OA/SmartLocationDatabase/MapServer/1/query'
export const EPA_SLD_LAYER =
  'https://geodata.epa.gov/arcgis/rest/services/OA/SmartLocationDatabase/MapServer/1'

export const EPA_SLD_SOURCE: SourceRef = {
  publisher: 'U.S. Environmental Protection Agency',
  dataset: 'Smart Location Database Version 3.0',
  tableId: 'Map service layer 1',
  vintage: '2021 release; 2019 block-group IDs; input years vary',
  url: EPA_SLD_LAYER,
  citation: 'U.S. EPA Smart Location Database Version 3.0 (2021)',
}

const OUT_FIELDS = 'GEOID20,NatWalkInd,D1A,D2B_E5MIXA,D3B,D4A,D5AR'

interface ArcGisFeature {
  attributes?: Record<string, unknown>
}

interface ArcGisPointResponse {
  features?: ArcGisFeature[]
  error?: { code?: number; message?: string }
}

export interface EpaSldPointResult {
  geoid: string
  metrics: MetricValue[]
}

interface MetricDefinition {
  field: string
  key: string
  label: string
  unit: MetricValue['unit']
  tableId: string
  note: string
  displayPrecision?: number
  min?: number
  max?: number
  missingValues?: readonly number[]
}

const DEFINITIONS: readonly MetricDefinition[] = [
  {
    field: 'NatWalkInd',
    key: 'epa_natwalkind_at_zip_point',
    label: 'EPA walkability index at the ZIP point',
    unit: 'index',
    tableId: 'NatWalkInd',
    note: 'EPA calculates this national relative index from ranked SLD measures. It is not an on-the-ground sidewalk, crossing, or destination assessment.',
    displayPrecision: 1,
    min: 1,
    max: 20,
  },
  {
    field: 'D1A',
    key: 'epa_residential_density',
    label: 'Residential density (housing units per acre)',
    unit: 'number',
    tableId: 'D1A',
    note: 'Uses 2018 ACS five-year housing-unit estimates divided by acreage EPA identifies as unprotected from development.',
    displayPrecision: 1,
    min: 0,
  },
  {
    field: 'D2B_E5MIXA',
    key: 'epa_employment_mix',
    label: 'Five-category employment mix (index)',
    unit: 'index',
    tableId: 'D2B_E5MIXA',
    note: 'Uses 2017 Census LEHD Workplace Area Characteristics employment, with entropy normalized across a fixed set of five job categories. Higher values indicate a more even mix; this is not a neighborhood grade.',
    displayPrecision: 2,
    min: 0,
    max: 1,
  },
  {
    field: 'D3B',
    key: 'epa_street_intersection_density',
    label: 'Weighted street-intersection density (per square mile)',
    unit: 'number',
    tableId: 'D3B',
    note: 'Uses 2018 HERE Maps NAVSTREETS. EPA weights intersection types, gives auto-oriented intersections zero weight, and discounts three-way intersections. The source street data does not establish whether sidewalks are present or in good condition.',
    displayPrecision: 1,
    min: 0,
  },
  {
    field: 'D4A',
    key: 'epa_distance_to_transit_m',
    label: 'Distance to nearest transit stop (meters)',
    unit: 'number',
    tableId: 'D4A',
    note: 'Uses 2020 GTFS and CTOD stop data. It measures minimum walk-network distance from the block group’s historical 2010 population-weighted centroid; the 0.75-mile straight-line search threshold and GTFS coverage limit availability. EPA assigns -99999 when a distance threshold is exceeded or required GTFS coverage is unavailable. This is not a current service-frequency or trip-time measure.',
    displayPrecision: 1,
    min: 0,
    missingValues: [-99999],
  },
  {
    field: 'D5AR',
    key: 'epa_jobs_accessible_by_auto',
    label: 'Jobs reachable within 45 minutes by car (weighted)',
    unit: 'count',
    tableId: 'D5AR',
    note: 'EPA’s destination-access estimate weights jobs reachable from this residential block group by a 45-minute auto trip; nearby jobs count more. Version 3 used 2020 TravelTime routing and 2017 Census LEHD jobs. It is not an individual commute prediction or a current traffic estimate.',
    min: 0,
    missingValues: [99999],
  },
]

function sourceFor(field: string, requestUrl: string): SourceRef {
  return { ...EPA_SLD_SOURCE, tableId: field, url: requestUrl }
}

/** Build a small, deterministic point query with only the curated SLD fields. */
export function epaNwiPointUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${lon.toFixed(5)},${lat.toFixed(5)}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS,
    returnGeometry: 'false',
    f: 'json',
  })
  return `${EPA_SLD_QUERY}?${params.toString()}`
}

function parseNumber(raw: unknown, definition: MetricDefinition): Pick<MetricValue, 'value' | 'absentReason'> {
  if (raw === null || raw === undefined || raw === '') return { value: null, absentReason: 'missing' }
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(value)) return { value: null, absentReason: 'out-of-range' }
  if (definition.missingValues?.includes(value)) return { value: null, absentReason: 'not-applicable' }
  if ((definition.min !== undefined && value < definition.min) || (definition.max !== undefined && value > definition.max)) {
    return { value: null, absentReason: 'out-of-range' }
  }
  return { value }
}

/**
 * Keep a point result only when it resolves to exactly one valid 2019 block
 * group identifier. A boundary hit must not arbitrarily choose one neighbour.
 */
export function parseEpaSldPointResponse(body: ArcGisPointResponse, requestUrl: string): EpaSldPointResult | null {
  if (body.error) throw new Error(`EPA Smart Location query failed (${body.error.code ?? 'unknown'})`)
  if (body.features?.length !== 1) return null

  const attributes = body.features[0]?.attributes
  const geoid = typeof attributes?.GEOID20 === 'string' ? attributes.GEOID20 : ''
  if (!/^\d{12}$/.test(geoid)) return null

  const metrics = DEFINITIONS.map((definition): MetricValue => {
    const parsed = parseNumber(attributes?.[definition.field], definition)
    return {
      key: definition.key,
      label: definition.label,
      ...parsed,
      unit: definition.unit,
      displayPrecision: definition.displayPrecision,
      category: 'environment',
      source: sourceFor(definition.field, requestUrl),
      quality: { derived: false },
      geographyContext: `Block group ${geoid} contains this ZIP’s Census-geocoded point; this is not a ZIP-wide average.`,
      note: `Smart Location Database v3 is a 2021 release and its input years vary. ${definition.note}`,
    }
  })

  return { geoid, metrics }
}

async function lookupPoint(lat: number, lon: number, signal: AbortSignal): Promise<EpaSldPointResult | null> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return null
  const requestUrl = epaNwiPointUrl(lat, lon)
  const body = await getJson<ArcGisPointResponse>(requestUrl, { signal, metered: true })
  return parseEpaSldPointResponse(body, requestUrl)
}

export const epaNwiContextPlugin: PluginRequest = {
  id: 'epa-nwi-context',
  title: 'Built environment (EPA)',
  category: 'environment',
  geography: 'blockgroup',
  minZoom: 4,
  legal: {
    notice:
      'EPA Smart Location measures are historical block-group context at the Census-geocoded ZIP point. They are not ZIP-wide averages, property assessments, real-time conditions, recommendations, or scoring inputs.',
  },

  async fetch(ctx: QueryContext): Promise<MetricValue[]> {
    const { lat, lon } = ctx.geo ?? {}
    if (lat === undefined || lon === undefined) return []

    const match = await lookupPoint(lat, lon, ctx.signal)
    return match?.metrics ?? []
  },
}
