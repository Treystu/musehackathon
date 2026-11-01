/**
 * F7 client-side diagnostics: counts only, stored in this browser.
 *
 * The acceptance bar for this module is structural, not editorial. An export
 * is meant to be handed to someone, so it must be incapable of carrying a
 * secret, a raw question, or a provider message. Three rules enforce that:
 *
 *   1. Counters are keyed by closed unions. An unknown class is dropped, not
 *      stored under its own name, so storage cannot accumulate arbitrary text.
 *   2. The export is rebuilt field by field from validated scalars. Nothing is
 *      spread from storage, a fetch response, or a component prop, so extra
 *      fields cannot ride along.
 *   3. The only free-shaped strings are the origin, a deployment branch, and a
 *      commit hash, each pattern-limited. A prompt, a key, or a model reply
 *      matches none of those patterns and therefore has nowhere to go.
 *
 * Values are observed at export time: the module probes the real routes and
 * asks the deployment for its own state. When a value is not knowable, it is
 * null and its reason is listed in `unknowns` rather than filled with a
 * plausible default.
 */
import { PROXY_ERRORS, type ProxyError } from './proxy-errors'
import { VALIDATOR_FAILURES, type ValidatorFailure } from './validator'

export const DIAGNOSTICS_SCHEMA = 'civicscope.diagnostics.v1'
export const DIAGNOSTICS_STORAGE_KEY = 'civicscope.diagnostics.v1'

/** Validator dispositions plus the case where the proxy withheld without a class. */
export const WITHHOLD_CLASSES = [...VALIDATOR_FAILURES, 'unspecified'] as const
export type WithholdClass = ValidatorFailure | 'unspecified'

export const INTENT_FAILURE_CLASSES = [...PROXY_ERRORS, 'schema_invalid', 'unexpected'] as const
export type IntentFailureClass = ProxyError | 'schema_invalid' | 'unexpected'

export const ERROR_STATES = [...PROXY_ERRORS, 'unexpected'] as const
export type ErrorState = ProxyError | 'unexpected'

export interface DiagnosticsSnapshot {
  withholds: Record<WithholdClass, number>
  intentFailures: Record<IntentFailureClass, number>
  errorStates: Record<ErrorState, number>
}

export interface DiagnosticsStore {
  read(): string | null
  write(value: string): void
}

export interface DiagnosticsRecorder {
  readonly storageKey: string
  recordWithhold(cls: string): void
  recordIntentFailure(cls: string): void
  recordErrorState(cls: string): void
  snapshot(): DiagnosticsSnapshot
}

function zeroBy<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>
  for (const key of keys) out[key] = 0
  return out
}

export function emptySnapshot(): DiagnosticsSnapshot {
  return {
    withholds: zeroBy(WITHHOLD_CLASSES),
    intentFailures: zeroBy(INTENT_FAILURE_CLASSES),
    errorStates: zeroBy(ERROR_STATES),
  }
}

/** Non-negative integer or zero. Never trusts a number enough to keep it as-is. */
function toCount(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000
    ? value
    : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000_000
    ? value
    : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

/**
 * Rebuilds a stored snapshot from known keys only. This is the only way a
 * stored value reaches memory, so a hostile or corrupted storage entry can
 * change counts and nothing else.
 */
export function sanitizeSnapshot(raw: unknown): DiagnosticsSnapshot {
  const source = isRecord(raw) ? raw : {}
  const withholds = isRecord(source.withholds) ? source.withholds : {}
  const intentFailures = isRecord(source.intentFailures) ? source.intentFailures : {}
  const errorStates = isRecord(source.errorStates) ? source.errorStates : {}
  const out = emptySnapshot()
  for (const key of WITHHOLD_CLASSES) out.withholds[key] = toCount(withholds[key])
  for (const key of INTENT_FAILURE_CLASSES) out.intentFailures[key] = toCount(intentFailures[key])
  for (const key of ERROR_STATES) out.errorStates[key] = toCount(errorStates[key])
  return out
}

function cloneSnapshot(snapshot: DiagnosticsSnapshot): DiagnosticsSnapshot {
  const out = emptySnapshot()
  for (const key of WITHHOLD_CLASSES) out.withholds[key] = toCount(snapshot.withholds[key])
  for (const key of INTENT_FAILURE_CLASSES) out.intentFailures[key] = toCount(snapshot.intentFailures[key])
  for (const key of ERROR_STATES) out.errorStates[key] = toCount(snapshot.errorStates[key])
  return out
}

/**
 * localStorage where available, memory otherwise. A write failure is ignored
 * on purpose: a browser in a restricted storage mode should still be able to
 * show this visit's counts, and a thrown quota error must not break the app.
 */
function browserStore(): DiagnosticsStore {
  return {
    read() {
      try {
        if (typeof localStorage === 'undefined') return null
        return localStorage.getItem(DIAGNOSTICS_STORAGE_KEY)
      } catch {
        return null
      }
    },
    write(value) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, value)
        }
      } catch {
        // Counts remain correct for this tab; they just do not survive a reload.
      }
    },
  }
}

export function createDiagnostics(
  store: DiagnosticsStore = browserStore(),
): DiagnosticsRecorder {
  let state = emptySnapshot()
  try {
    const raw = store.read()
    if (raw) state = sanitizeSnapshot(JSON.parse(raw))
  } catch {
    state = emptySnapshot()
  }

  function persist(): void {
    store.write(JSON.stringify(state))
  }

  function bump<K extends string>(
    bucket: Record<K, number>,
    key: string,
    allowed: readonly K[],
  ): void {
    if (!(allowed as readonly string[]).includes(key)) return
    bucket[key as K] += 1
    persist()
  }

  return {
    storageKey: DIAGNOSTICS_STORAGE_KEY,
    recordWithhold(cls) {
      bump(state.withholds, cls, WITHHOLD_CLASSES)
    },
    recordIntentFailure(cls) {
      bump(state.intentFailures, cls, INTENT_FAILURE_CLASSES)
    },
    recordErrorState(cls) {
      bump(state.errorStates, cls, ERROR_STATES)
    },
    snapshot() {
      return cloneSnapshot(state)
    },
  }
}

export const diagnostics = createDiagnostics()

/* ------------------------------------------------------------------ */
/* Export artifact                                                     */
/* ------------------------------------------------------------------ */

export type RouteOutcome =
  | 'refused_shape'
  | 'no_shared_key'
  | 'route_missing'
  | 'unexpected_status'
  | 'unreachable'

export interface RouteObservation {
  status: number | null
  outcome: RouteOutcome
}

export type ServerOutcome = 'reported' | 'unavailable'
export type BreakerState = 'closed' | 'open' | 'half-open'
export type CapState = 'configured' | 'unset' | 'unknown'
export type MeterPersistence = 'isolate' | 'durable' | 'unknown'

export interface ServerObservation {
  outcome: ServerOutcome
  status: number | null
  sharedKeyPresent: boolean | null
  modelIsDefault: boolean | null
  perClientCap: CapState
  meterPersistence: MeterPersistence
  budgetCapMicroUsd: number | null
  spentMicroUsd: number | null
  requests: number | null
  tokensIn: number | null
  tokensOut: number | null
  budgetExhausted: boolean | null
  breaker: BreakerState | null
  errors: Partial<Record<ProxyError | ValidatorFailure, number>>
  deployment: { pages: boolean | null; branch: string | null; commit: string | null }
}

export type UnknownReason =
  | 'server-diagnostics-unavailable'
  | 'shared-key-state-unknown'
  | 'meter-state-unknown'
  | 'deployment-identity-unknown'
  | 'route-probe-unreachable'

export interface DiagnosticsExport {
  schema: typeof DIAGNOSTICS_SCHEMA
  generatedAt: string
  origin: string
  server: ServerObservation
  routes: { intent: RouteObservation; explain: RouteObservation }
  local: DiagnosticsSnapshot
  unknowns: UnknownReason[]
}

const BREAKER_STATES = ['closed', 'open', 'half-open'] as const
const ROUTE_OUTCOMES = [
  'refused_shape',
  'no_shared_key',
  'route_missing',
  'unexpected_status',
  'unreachable',
] as const

/** A deployment origin, with no path, query, userinfo, or foreign scheme. */
export function safeOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return 'unknown'
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'unknown'
    if (url.username !== '' || url.password !== '') return 'unknown'
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(url.host)) return 'unknown'
    return `${url.protocol}//${url.host}`
  } catch {
    return 'unknown'
  }
}

/** Platform branch names only: no whitespace or prose, no parent traversal. */
export function safeBranch(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) return null
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return null
  if (value.includes('..')) return null
  return value
}

/** Abbreviated or full git object id, lowercase hex only. */
export function safeCommit(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^[0-9a-f]{7,40}$/.exec(value)
  return match ? match[0] : null
}

function unavailableServer(status: number | null): ServerObservation {
  return {
    outcome: 'unavailable',
    status,
    sharedKeyPresent: null,
    modelIsDefault: null,
    perClientCap: 'unknown',
    meterPersistence: 'unknown',
    budgetCapMicroUsd: null,
    spentMicroUsd: null,
    requests: null,
    tokensIn: null,
    tokensOut: null,
    budgetExhausted: null,
    breaker: null,
    errors: {},
    deployment: { pages: null, branch: null, commit: null },
  }
}

/**
 * Reads the deployment's diagnostics payload. Unknown keys are dropped and
 * every value is type-checked; a response that does not carry this schema is
 * reported as unavailable rather than partially trusted.
 */
export function parseServerObservation(
  payload: unknown,
  status: number | null,
): ServerObservation {
  if (!isRecord(payload) || payload.schema !== DIAGNOSTICS_SCHEMA) {
    return unavailableServer(status)
  }
  const errors: Partial<Record<ProxyError | ValidatorFailure, number>> = {}
  if (isRecord(payload.errors)) {
    for (const cls of [...PROXY_ERRORS, ...VALIDATOR_FAILURES]) {
      const count = countOrNull(payload.errors[cls])
      if (count !== null) errors[cls] = count
    }
  }
  const deployment = isRecord(payload.deployment) ? payload.deployment : {}
  return {
    outcome: 'reported',
    status,
    sharedKeyPresent: boolOrNull(payload.sharedKeyPresent),
    modelIsDefault: boolOrNull(payload.modelIsDefault),
    perClientCap: oneOf(payload.perClientCap, ['configured', 'unset'] as const) ?? 'unknown',
    meterPersistence:
      oneOf(payload.meterPersistence, ['isolate', 'durable'] as const) ?? 'unknown',
    budgetCapMicroUsd: countOrNull(payload.budgetCapMicroUsd),
    spentMicroUsd: countOrNull(payload.spentMicroUsd),
    requests: countOrNull(payload.requests),
    tokensIn: countOrNull(payload.tokensIn),
    tokensOut: countOrNull(payload.tokensOut),
    budgetExhausted: boolOrNull(payload.budgetExhausted),
    breaker: oneOf(payload.breaker, BREAKER_STATES),
    errors,
    deployment: {
      pages: boolOrNull(deployment.pages),
      branch: safeBranch(deployment.branch),
      commit: safeCommit(deployment.commit),
    },
  }
}

function sanitizeServer(input: ServerObservation): ServerObservation {
  const source: Record<string, unknown> = isRecord(input) ? input : {}
  const deployment = isRecord(source.deployment) ? source.deployment : {}
  const errors: Partial<Record<ProxyError | ValidatorFailure, number>> = {}
  if (isRecord(source.errors)) {
    for (const cls of [...PROXY_ERRORS, ...VALIDATOR_FAILURES]) {
      const count = countOrNull(source.errors[cls])
      if (count !== null) errors[cls] = count
    }
  }
  return {
    outcome: oneOf(source.outcome, ['reported', 'unavailable'] as const) ?? 'unavailable',
    status: countOrNull(source.status),
    sharedKeyPresent: boolOrNull(source.sharedKeyPresent),
    modelIsDefault: boolOrNull(source.modelIsDefault),
    perClientCap: oneOf(source.perClientCap, ['configured', 'unset'] as const) ?? 'unknown',
    meterPersistence:
      oneOf(source.meterPersistence, ['isolate', 'durable'] as const) ?? 'unknown',
    budgetCapMicroUsd: countOrNull(source.budgetCapMicroUsd),
    spentMicroUsd: countOrNull(source.spentMicroUsd),
    requests: countOrNull(source.requests),
    tokensIn: countOrNull(source.tokensIn),
    tokensOut: countOrNull(source.tokensOut),
    budgetExhausted: boolOrNull(source.budgetExhausted),
    breaker: oneOf(source.breaker, BREAKER_STATES),
    errors,
    deployment: {
      pages: boolOrNull(deployment.pages),
      branch: safeBranch(deployment.branch),
      commit: safeCommit(deployment.commit),
    },
  }
}

function sanitizeRoute(input: unknown): RouteObservation {
  const source: Record<string, unknown> = isRecord(input) ? input : {}
  const status = countOrNull(source.status)
  return {
    status: status !== null && status >= 100 && status <= 599 ? status : null,
    outcome: oneOf(source.outcome, ROUTE_OUTCOMES) ?? 'unexpected_status',
  }
}

export interface ExportInputs {
  origin: string
  generatedAt: Date
  server: ServerObservation
  routes: { intent: RouteObservation; explain: RouteObservation }
  local: DiagnosticsSnapshot
}

/**
 * Builds the artifact. Every field is reconstructed; the return value shares
 * no object with the inputs. A prompt or key cannot enter through a spread
 * because no spread exists.
 */
export function buildDiagnosticsExport(input: ExportInputs): DiagnosticsExport {
  const origin = safeOrigin(input.origin)
  const server = sanitizeServer(input.server)
  const routes = {
    intent: sanitizeRoute(input.routes?.intent),
    explain: sanitizeRoute(input.routes?.explain),
  }
  const local = cloneSnapshot(input.local)
  const generatedAt = Number.isFinite(input.generatedAt?.getTime?.())
    ? input.generatedAt.toISOString()
    : new Date(0).toISOString()

  const unknowns: UnknownReason[] = []
  if (server.outcome !== 'reported') unknowns.push('server-diagnostics-unavailable')
  if (server.sharedKeyPresent === null) unknowns.push('shared-key-state-unknown')
  if (server.requests === null || server.spentMicroUsd === null) unknowns.push('meter-state-unknown')
  if (server.deployment.branch === null && server.deployment.commit === null) {
    unknowns.push('deployment-identity-unknown')
  }
  if (routes.intent.outcome === 'unreachable' || routes.explain.outcome === 'unreachable') {
    unknowns.push('route-probe-unreachable')
  }

  return { schema: DIAGNOSTICS_SCHEMA, generatedAt, origin, server, routes, local, unknowns }
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Probe bodies are deliberately invalid in a way each handler rejects before
 * touching the provider or the meter: an over-ceiling query, and a non-array
 * value set. They therefore prove a route exists without spending credit or
 * recording a failure.
 */
const INTENT_PROBE = {
  slots: { geographyHints: [], metricHints: [] },
  queryText: 'x'.repeat(501),
}
const EXPLAIN_PROBE = { figureSetId: 'diagnostics-probe', values: 'not-an-array' }

function outcomeFor(status: number, errorCode: unknown): RouteOutcome {
  if (status === 503 && errorCode === 'provider_down') return 'no_shared_key'
  if (status === 400 && errorCode === 'shape_invalid') return 'refused_shape'
  if (status === 404 || status === 405) return 'route_missing'
  return 'unexpected_status'
}

async function probeRoute(
  doFetch: typeof fetch,
  origin: string,
  path: string,
  body: unknown,
): Promise<RouteObservation> {
  try {
    const res = await doFetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    })
    let errorCode: unknown = null
    try {
      const parsed: unknown = await res.json()
      if (isRecord(parsed)) errorCode = parsed.error
    } catch {
      // HTML or an empty body: the status alone classifies it.
    }
    return { status: res.status, outcome: outcomeFor(res.status, errorCode) }
  } catch {
    return { status: null, outcome: 'unreachable' }
  }
}

async function fetchServerObservation(
  doFetch: typeof fetch,
  origin: string,
): Promise<ServerObservation> {
  if (origin === 'unknown') return unavailableServer(null)
  try {
    const res = await doFetch(`${origin}/api/muse/diagnostics`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    let payload: unknown = null
    try {
      payload = await res.json()
    } catch {
      payload = null
    }
    return parseServerObservation(payload, res.status)
  } catch {
    return unavailableServer(null)
  }
}

export interface CollectOptions {
  fetchImpl?: typeof fetch
  origin?: string
  recorder?: DiagnosticsRecorder
  now?: () => Date
}

/**
 * Collects the export from the live surface. Nothing throws: a failed fetch
 * becomes `unavailable` plus an unknown reason, which is the honest result and
 * still leaves a usable artifact.
 */
export async function collectDiagnostics(
  options: CollectOptions = {},
): Promise<DiagnosticsExport> {
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args))
  const recorder = options.recorder ?? diagnostics
  const now = options.now ?? (() => new Date())
  const rawOrigin =
    options.origin ??
    (typeof window !== 'undefined' && window.location ? window.location.origin : '')
  const origin = safeOrigin(rawOrigin)

  if (origin === 'unknown') {
    return buildDiagnosticsExport({
      origin,
      generatedAt: now(),
      server: unavailableServer(null),
      routes: {
        intent: { status: null, outcome: 'unreachable' },
        explain: { status: null, outcome: 'unreachable' },
      },
      local: recorder.snapshot(),
    })
  }

  const [server, intent, explain] = await Promise.all([
    fetchServerObservation(doFetch, origin),
    probeRoute(doFetch, origin, '/api/muse/intent', INTENT_PROBE),
    probeRoute(doFetch, origin, '/api/muse/explain', EXPLAIN_PROBE),
  ])

  return buildDiagnosticsExport({
    origin,
    generatedAt: now(),
    server,
    routes: { intent, explain },
    local: recorder.snapshot(),
  })
}
