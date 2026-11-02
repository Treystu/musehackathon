/**
 * Meter persistence adapter (Q1): wraps the untouched Meter logic core
 * (meter.ts) with a single durable record so the aggregate survives
 * isolate restarts and is shared across isolates. Counts only, never
 * content — the persisted record cannot hold query text, figures, or
 * provider bodies by construction.
 *
 * Every operation is load -> sweep expired reservations -> hydrate a
 * Meter -> apply one operation -> persist. Storage sits behind the
 * MeterStorage interface; the Durable Object binding that implements it
 * lives in functions/api/muse/meter-do.ts.
 *
 * Failure modes are fail-closed at this layer: any storage failure,
 * corrupt record, or unknown schema version throws
 * MeterUnavailableError and leaves the stored record untouched. A
 * corrupt record is never silently reset — the only path that
 * overwrites one is operatorReset(). What changed on 2026-11-02 is
 * the caller, not this layer: the request path treats a throw here as
 * a lost accounting record and serves the user anyway (the meter is
 * accounting only), while the diagnostics read path still surfaces
 * it rather than fabricating totals.
 */
import {
  Meter,
  type BreakerState,
  type MeterConfig,
  type MeterSnapshot,
  type MeterState,
} from './meter'
import {
  sanitizeUsageSnapshot,
  zeroHourglass,
  type UsageBucket,
  type UsageDetail,
  type UsageSnapshot,
} from './usage'
import type { BookendCounters } from './bookend-counters'

export const PERSISTED_METER_VERSION = 1

/** Reservation TTL: far above any single provider call (design: 120 s). */
export const RESERVATION_TTL_MS = 120_000

/** The one stored record. Mirrors meter.ts field-for-field, plus the
 *  schema version and the reservation expiry the adapter owns. */
export interface PersistedMeterState {
  version: 1
  requests: number
  tokensIn: number
  tokensOut: number
  spentMicroUsd: number
  failures: number
  breaker: BreakerState
  breakerOpenedAt: number
  errors: Record<string, number>
  perClientSpent: Record<string, number>
  reservations: Record<
    string,
    { clientId: string; estMicroUsd: number; expiresAt: number }
  >
  nextReservationId: number
  /**
   * P7 splits (usage.ts), additive under version 1: a record written
   * before P7 carries none of these fields and loads with zero
   * splits (its flat totals are untouched and remain the truth for
   * the pre-P7 period); a record written after P7 carries all of
   * them. Present-but-malformed values fail closed in the loader,
   * exactly like every other field -- they are never silently zeroed.
   */
  usageByModel?: Record<string, UsageBucket>
  usageByRoute?: Record<string, UsageBucket>
  searches?: number
  hourglass?: BookendCounters
}

/** Single-record storage behind the adapter (one key in the DO). */
export interface MeterStorage {
  get(): Promise<PersistedMeterState | undefined>
  put(state: PersistedMeterState): Promise<void>
}

export type MeterUnavailableReason =
  | 'storage'
  | 'state_invalid'
  | 'version_unknown'

/** Fail-closed signal: the proxy maps this to 503 breaker_open. */
export class MeterUnavailableError extends Error {
  readonly code = 'meter_unavailable'
  constructor(
    readonly reason: MeterUnavailableReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'MeterUnavailableError'
  }
}

export function emptyPersistedState(): PersistedMeterState {
  return {
    version: PERSISTED_METER_VERSION,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    spentMicroUsd: 0,
    failures: 0,
    breaker: 'closed',
    breakerOpenedAt: 0,
    errors: {},
    perClientSpent: {},
    reservations: {},
    nextReservationId: 0,
    usageByModel: {},
    usageByRoute: {},
    searches: 0,
    hourglass: zeroHourglass(),
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNumberRecord(v: unknown): v is Record<string, number> {
  return (
    typeof v === 'object' &&
    v !== null &&
    Object.values(v).every(isFiniteNumber)
  )
}

function isPersistedMeterState(raw: unknown): raw is PersistedMeterState {
  if (typeof raw !== 'object' || raw === null) return false
  const s = raw as Record<string, unknown>
  if (
    !isFiniteNumber(s.requests) ||
    !isFiniteNumber(s.tokensIn) ||
    !isFiniteNumber(s.tokensOut) ||
    !isFiniteNumber(s.spentMicroUsd) ||
    !isFiniteNumber(s.failures) ||
    !isFiniteNumber(s.breakerOpenedAt) ||
    !isFiniteNumber(s.nextReservationId)
  ) {
    return false
  }
  if (s.breaker !== 'closed' && s.breaker !== 'open' && s.breaker !== 'half-open') {
    return false
  }
  if (!isNumberRecord(s.errors) || !isNumberRecord(s.perClientSpent)) return false
  if (typeof s.reservations !== 'object' || s.reservations === null) return false
  if (!Object.values(s.reservations).every((r) => {
    if (typeof r !== 'object' || r === null) return false
    const rec = r as Record<string, unknown>
    return (
      typeof rec.clientId === 'string' &&
      isFiniteNumber(rec.estMicroUsd) &&
      isFiniteNumber(rec.expiresAt)
    )
  })) {
    return false
  }
  // P7 fields are optional (pre-P7 records carry none), but a present
  // field must be well-formed: a bucket with a non-finite count is
  // corruption, not a zero.
  if (s.usageByModel !== undefined && !isBucketRecord(s.usageByModel)) return false
  if (s.usageByRoute !== undefined && !isBucketRecord(s.usageByRoute)) return false
  if (s.searches !== undefined && !isFiniteNumber(s.searches)) return false
  if (s.hourglass !== undefined && !isHourglassRecord(s.hourglass)) return false
  return true
}

function isBucketRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  return Object.values(v).every((b) => {
    if (typeof b !== 'object' || b === null) return false
    const rec = b as Record<string, unknown>
    return (
      isFiniteNumber(rec.calls) &&
      isFiniteNumber(rec.tokensIn) &&
      isFiniteNumber(rec.tokensOut)
    )
  })
}

function isHourglassRecord(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const rec = v as Record<string, unknown>
  const side = (x: unknown, keys: string[]): boolean =>
    typeof x === 'object' &&
    x !== null &&
    keys.every((k) => isFiniteNumber((x as Record<string, unknown>)[k]))
  return (
    side(rec.top, ['sound', 'unsound', 'degraded']) &&
    side(rec.bottom, ['verified', 'concerns', 'notRun'])
  )
}

/**
 * Forward-only versioned loaders, one per persisted schema version.
 * A loader validates its version's shape and returns the current
 * in-memory form; a future version adds a loader that transforms the
 * previous record forward. Unknown versions fail closed.
 */
const LOADERS: Record<number, (raw: unknown) => PersistedMeterState> = {
  1: (raw) => {
    if (!isPersistedMeterState(raw)) {
      throw new MeterUnavailableError(
        'state_invalid',
        'persisted meter record failed v1 shape validation',
      )
    }
    // Normalize the P7 fields through the closed-vocabulary sanitize
    // pass: a stored key outside the model/route unions (impossible
    // through the Meter, which sanitizes on write) is dropped here
    // rather than reaching diagnostics, and a pre-P7 record gains
    // zero splits.
    const usage = sanitizeUsageSnapshot({
      byModel: raw.usageByModel,
      byRoute: raw.usageByRoute,
      searches: raw.searches,
      hourglass: raw.hourglass,
    })
    return {
      ...raw,
      usageByModel: usage.byModel,
      usageByRoute: usage.byRoute,
      searches: usage.searches,
      hourglass: usage.hourglass,
    }
  },
}

/**
 * Migrate a raw stored record to the current schema.
 * `undefined` means an empty store (designed cutover: fresh zero state),
 * not corruption. Anything present but unreadable fails closed.
 */
export function migratePersistedState(raw: unknown): PersistedMeterState {
  if (raw === undefined || raw === null) return emptyPersistedState()
  if (typeof raw !== 'object') {
    throw new MeterUnavailableError(
      'state_invalid',
      'persisted meter record is not an object',
    )
  }
  const version = (raw as Record<string, unknown>).version
  if (!isFiniteNumber(version)) {
    throw new MeterUnavailableError(
      'state_invalid',
      'persisted meter record has no numeric version',
    )
  }
  const loader = LOADERS[version]
  if (!loader) {
    throw new MeterUnavailableError(
      'version_unknown',
      `persisted meter record version ${version} is not loadable`,
    )
  }
  return loader(raw)
}

/** Drop reservations whose TTL has lapsed (adapter-owned, pre-hydrate). */
export function sweepExpiredReservations(
  state: PersistedMeterState,
  now: number,
): PersistedMeterState {
  const kept = Object.entries(state.reservations).filter(
    ([, r]) => r.expiresAt > now,
  )
  if (kept.length === Object.keys(state.reservations).length) return state
  return { ...state, reservations: Object.fromEntries(kept) }
}

function toMeterState(p: PersistedMeterState): MeterState {
  return {
    requests: p.requests,
    tokensIn: p.tokensIn,
    tokensOut: p.tokensOut,
    spentMicroUsd: p.spentMicroUsd,
    failures: p.failures,
    breaker: p.breaker,
    breakerOpenedAt: p.breakerOpenedAt,
    errors: { ...p.errors },
    perClientSpent: { ...p.perClientSpent },
    reservations: Object.fromEntries(
      Object.entries(p.reservations).map(([id, r]) => [
        id,
        { clientId: r.clientId, estMicroUsd: r.estMicroUsd },
      ]),
    ),
    nextReservationId: p.nextReservationId,
    usageByModel: Object.fromEntries(
      Object.entries(p.usageByModel ?? {}).map(([k, v]) => [k, { ...v }]),
    ),
    usageByRoute: Object.fromEntries(
      Object.entries(p.usageByRoute ?? {}).map(([k, v]) => [k, { ...v }]),
    ),
    searches: p.searches ?? 0,
    hourglass: p.hourglass
      ? { top: { ...p.hourglass.top }, bottom: { ...p.hourglass.bottom } }
      : zeroHourglass(),
  }
}

function toPersistedState(
  ms: MeterState,
  prior: PersistedMeterState,
  now: number,
  ttlMs: number,
): PersistedMeterState {
  return {
    version: PERSISTED_METER_VERSION,
    requests: ms.requests,
    tokensIn: ms.tokensIn,
    tokensOut: ms.tokensOut,
    spentMicroUsd: ms.spentMicroUsd,
    failures: ms.failures,
    breaker: ms.breaker,
    breakerOpenedAt: ms.breakerOpenedAt,
    errors: { ...ms.errors },
    perClientSpent: { ...ms.perClientSpent },
    reservations: Object.fromEntries(
      Object.entries(ms.reservations).map(([id, r]) => [
        id,
        {
          clientId: r.clientId,
          estMicroUsd: r.estMicroUsd,
          // Existing reservations keep their original expiry; only a
          // reservation created by this operation gets a fresh TTL.
          expiresAt: prior.reservations[id]?.expiresAt ?? now + ttlMs,
        },
      ]),
    ),
    nextReservationId: ms.nextReservationId,
    usageByModel: Object.fromEntries(
      Object.entries(ms.usageByModel).map(([k, v]) => [k, { ...v }]),
    ),
    usageByRoute: Object.fromEntries(
      Object.entries(ms.usageByRoute).map(([k, v]) => [k, { ...v }]),
    ),
    searches: ms.searches,
    hourglass: {
      top: { ...ms.hourglass.top },
      bottom: { ...ms.hourglass.bottom },
    },
  }
}

export interface PersistentMeterOptions {
  ttlMs?: number
  /** Injectable clock for hermetic tests; the DO uses its own clock. */
  now?: () => number
}

/**
 * The Meter surface, persisted. Each method performs one serialized
 * load -> apply -> persist cycle against the shared record, so any
 * number of instances over one store observe one aggregate.
 */
export class PersistentMeter {
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    private readonly storage: MeterStorage,
    private readonly cfg: MeterConfig,
    opts: PersistentMeterOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? RESERVATION_TTL_MS
    this.now = opts.now ?? Date.now
  }

  private async load(now: number): Promise<{ persisted: PersistedMeterState; meter: Meter }> {
    let raw: PersistedMeterState | undefined
    try {
      raw = await this.storage.get()
    } catch (e) {
      throw new MeterUnavailableError('storage', 'meter storage read failed', {
        cause: e,
      })
    }
    const persisted = sweepExpiredReservations(migratePersistedState(raw), now)
    const meter = new Meter(this.cfg)
    meter.importState(toMeterState(persisted))
    return { persisted, meter }
  }

  private async save(
    prior: PersistedMeterState,
    meter: Meter,
    now: number,
  ): Promise<void> {
    const next = toPersistedState(meter.exportState(), prior, now, this.ttlMs)
    try {
      await this.storage.put(next)
    } catch (e) {
      throw new MeterUnavailableError('storage', 'meter storage write failed', {
        cause: e,
      })
    }
  }

  private async apply<T>(fn: (meter: Meter, now: number) => T): Promise<T> {
    const now = this.now()
    const { persisted, meter } = await this.load(now)
    const result = fn(meter, now)
    await this.save(persisted, meter, now)
    return result
  }

  reserve(clientId: string, estMicroUsd: number, estTokens: number): Promise<string | null> {
    return this.apply((m) => m.reserve(clientId, estMicroUsd, estTokens))
  }

  settle(
    id: string,
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): Promise<void> {
    return this.apply((m) => {
      m.settle(id, clientId, actualMicroUsd, tin, tout, detail)
    })
  }

  /** Accounting-only counting for the request path (2026-11-02). */
  recordCall(
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): Promise<void> {
    return this.apply((m) => {
      m.recordCall(clientId, actualMicroUsd, tin, tout, detail)
    })
  }

  /** P7: count completed web_search calls from one research reply. */
  recordSearches(count: number): Promise<void> {
    return this.apply((m) => {
      m.recordSearches(count)
    })
  }

  /** P7: mirror one top-bookend outcome into the durable record. */
  recordTopBookend(outcome: keyof BookendCounters['top']): Promise<void> {
    return this.apply((m) => {
      m.recordTopBookend(outcome)
    })
  }

  /** P7: mirror one bottom-bookend outcome into the durable record. */
  recordBottomBookend(outcome: keyof BookendCounters['bottom']): Promise<void> {
    return this.apply((m) => {
      m.recordBottomBookend(outcome)
    })
  }

  /** P7 split view, read through the same load cycle as snapshot(). */
  usageSnapshot(): Promise<UsageSnapshot> {
    return this.apply((m) => m.usageSnapshot())
  }

  release(id: string): Promise<void> {
    return this.apply((m) => {
      m.release(id)
    })
  }

  recordError(cls: string): Promise<void> {
    return this.apply((m) => {
      m.recordError(cls)
    })
  }

  recordFailure(now?: number): Promise<void> {
    return this.apply((m, opNow) => {
      m.recordFailure(now ?? opNow)
    })
  }

  snapshot(): Promise<MeterSnapshot> {
    return this.apply((m) => m.snapshot())
  }

  breakerState(now?: number): Promise<BreakerState> {
    return this.apply((m, opNow) => m.breakerState(now ?? opNow))
  }

  /**
   * The diagnostics configuration view. Configuration is fixed at
   * construction, so this reads no storage: it answers from cfg alone
   * (via a throwaway Meter, keeping the reported shape identical to
   * Meter.configSnapshot by construction) and cannot fail with
   * MeterUnavailableError.
   */
  async configSnapshot(): Promise<ReturnType<Meter['configSnapshot']>> {
    return new Meter(this.cfg).configSnapshot()
  }

  /**
   * Explicit operator reset: the ONLY path that overwrites an invalid
   * or unknown-version record. Starts from zero and records the event
   * in the error counts, per the fail-closed failure-mode design.
   */
  async operatorReset(): Promise<void> {
    const fresh = emptyPersistedState()
    fresh.errors.meter_state_invalid = 1
    try {
      await this.storage.put(fresh)
    } catch (e) {
      throw new MeterUnavailableError('storage', 'meter storage write failed', {
        cause: e,
      })
    }
  }
}

/**
 * In-memory MeterStorage: the hermetic test double. Records cross the
 * boundary as deep copies, so two PersistentMeter instances over one
 * MemoryMeterStorage honestly simulate two isolates over one store.
 */
export class MemoryMeterStorage implements MeterStorage {
  private record: PersistedMeterState | undefined

  constructor(initial?: PersistedMeterState) {
    this.record = initial ? structuredClone(initial) : undefined
  }

  async get(): Promise<PersistedMeterState | undefined> {
    return this.record ? structuredClone(this.record) : undefined
  }

  async put(state: PersistedMeterState): Promise<void> {
    this.record = structuredClone(state)
  }

  /** Test/inspection view of the raw stored record. */
  peek(): PersistedMeterState | undefined {
    return this.record ? structuredClone(this.record) : undefined
  }
}
