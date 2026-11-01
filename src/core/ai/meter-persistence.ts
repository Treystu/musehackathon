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
 * Failure modes are fail-closed: any storage failure, corrupt record,
 * or unknown schema version throws MeterUnavailableError and leaves the
 * stored record untouched. A corrupt record is never silently reset —
 * the only path that overwrites one is operatorReset().
 */
import {
  Meter,
  type BreakerState,
  type MeterConfig,
  type MeterSnapshot,
  type MeterState,
} from './meter'

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
  return Object.values(s.reservations).every((r) => {
    if (typeof r !== 'object' || r === null) return false
    const rec = r as Record<string, unknown>
    return (
      typeof rec.clientId === 'string' &&
      isFiniteNumber(rec.estMicroUsd) &&
      isFiniteNumber(rec.expiresAt)
    )
  })
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
    return raw
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
  ): Promise<void> {
    return this.apply((m) => {
      m.settle(id, clientId, actualMicroUsd, tin, tout)
    })
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
