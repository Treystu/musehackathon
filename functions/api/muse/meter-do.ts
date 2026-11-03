/**
 * Durable Object binding for the Q1 meter — the port-time adapter that
 * shared.ts anticipated. One named instance ('judging-window-v1') owns
 * the single persisted record (meter-persistence.ts); input to a DO is
 * serialized, so the adapter's load -> apply -> persist cycle cannot
 * interleave with itself, and every isolate that reaches this object
 * observes one global aggregate.
 *
 * The class is framework-free and depends only on minimal structural
 * views of the DO runtime (no workers-types dependency in this tree).
 * At port time the Pages worker entry re-exports this class and the
 * wrangler.toml binding (METER) attaches it; routes then call the
 * DurableMeterClient below, whose surface mirrors the synchronous
 * Meter ops the handlers use today, made async by the network hop.
 *
 * Failure modes at this layer: a MeterUnavailableError from the
 * adapter is answered 503 breaker_open (closed taxonomy), so a caller
 * can tell the record did not persist. Since 2026-11-02 the meter is
 * accounting only — the request path treats that 503 as a lost
 * accounting record and serves the user anyway; only the diagnostics
 * read path still surfaces it.
 */
import {
  defaultMeterConfig,
  type BreakerState,
  type Meter,
  type MeterConfig,
  type MeterSnapshot,
} from '../../../src/core/ai/meter'
import {
  MeterUnavailableError,
  PersistentMeter,
  type MeterStorage,
  type PersistedMeterState,
} from '../../../src/core/ai/meter-persistence'
import type { UsageDetail, UsageSnapshot } from '../../../src/core/ai/usage'
import type {
  BookendCounters,
  BookendSettleClass,
} from '../../../src/core/ai/bookend-counters'

const STORAGE_KEY = 'meter/v1'
export const METER_INSTANCE_NAME = 'judging-window-v1'

/** Minimal structural view of Durable Object transactional storage. */
export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike
}

export interface DurableObjectStubLike {
  fetch(
    input: string,
    init?: { method?: string; body?: string },
  ): Promise<Response>
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStubLike
}

class DurableMeterStorage implements MeterStorage {
  constructor(private readonly storage: DurableObjectStorageLike) {}

  async get(): Promise<PersistedMeterState | undefined> {
    return this.storage.get<PersistedMeterState>(STORAGE_KEY)
  }

  async put(state: PersistedMeterState): Promise<void> {
    await this.storage.put(STORAGE_KEY, state)
  }
}

/**
 * MeterConfig is deployment config: plan defaults, with optional env
 * overrides. The caps in it are reporting thresholds since 2026-11-02;
 * this only wires where the configured values arrive from, and
 * diagnostics reports them.
 */
function configFromEnv(env: Record<string, unknown>): MeterConfig {
  const cfg = defaultMeterConfig()
  const num = (v: unknown): number | undefined =>
    typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined
  const cap = num(env.METER_BUDGET_CAP_MICRO_USD)
  if (cap !== undefined) cfg.budgetCapMicroUsd = cap
  const perClient = num(env.METER_PER_CLIENT_CAP_MICRO_USD)
  if (perClient !== undefined) cfg.perClientCapMicroUsd = perClient
  return cfg
}

class ShapeError extends Error {}

function asString(v: unknown): string {
  if (typeof v !== 'string') throw new ShapeError('expected string arg')
  return v
}

function asNumber(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ShapeError('expected finite number arg')
  }
  return v
}

function asOptNumber(v: unknown): number | undefined {
  return v === undefined ? undefined : asNumber(v)
}

/**
 * P7 settle detail (trailing arg): an object whose model/route, when
 * present, are strings. Anything else is a shape error. The values
 * themselves are not allowlist-checked here -- the Meter sanitizes
 * against the closed unions on write, so an unlisted string is
 * dropped from the splits there, not rejected here.
 */
function asOptUsageDetail(v: unknown): { model?: string; route?: string } | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ShapeError('expected usage detail object arg')
  }
  const rec = v as Record<string, unknown>
  if (rec.model !== undefined && typeof rec.model !== 'string') {
    throw new ShapeError('expected string usage model')
  }
  if (rec.route !== undefined && typeof rec.route !== 'string') {
    throw new ShapeError('expected string usage route')
  }
  return {
    ...(typeof rec.model === 'string' ? { model: rec.model } : {}),
    ...(typeof rec.route === 'string' ? { route: rec.route } : {}),
  }
}

function asTopOutcome(v: unknown): 'sound' | 'unsound' | 'degraded' {
  if (v === 'sound' || v === 'unsound' || v === 'degraded') return v
  throw new ShapeError('expected top bookend outcome')
}

function asBottomOutcome(v: unknown): 'verified' | 'concerns' | 'notRun' {
  if (v === 'verified' || v === 'concerns' || v === 'notRun') return v
  throw new ShapeError('expected bottom bookend outcome')
}

/**
 * Item 2 cure: the trailing settle arg on the bookend ops. Absent
 * or invalid reads as undefined, and the Meter then derives the
 * class from the outcome by the same defaults bookend-counters.ts
 * uses -- so a pre-cure client that sends only the outcome records
 * exactly the class it always recorded.
 */
function asOptSettleClass(v: unknown): BookendSettleClass | undefined {
  if (v === 'settled-ok' || v === 'settled-error' || v === 'skipped') return v
  return undefined
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export class MeterDurableObject {
  private readonly meter: PersistentMeter

  constructor(state: DurableObjectStateLike, env: Record<string, unknown> = {}) {
    this.meter = new PersistentMeter(
      new DurableMeterStorage(state.storage),
      configFromEnv(env),
    )
  }

  async fetch(request: Request): Promise<Response> {
    let op: string
    let args: unknown[]
    try {
      const body = (await request.json()) as { op?: unknown; args?: unknown }
      if (typeof body?.op !== 'string' || !Array.isArray(body?.args)) {
        return json(400, { error: 'shape_invalid' })
      }
      op = body.op
      args = body.args
    } catch {
      return json(400, { error: 'shape_invalid' })
    }

    try {
      switch (op) {
        case 'reserve':
          return json(200, {
            result: await this.meter.reserve(
              asString(args[0]),
              asNumber(args[1]),
              asNumber(args[2]),
            ),
          })
        case 'settle':
          await this.meter.settle(
            asString(args[0]),
            asString(args[1]),
            asNumber(args[2]),
            asNumber(args[3]),
            asNumber(args[4]),
            asOptUsageDetail(args[5]),
          )
          return json(200, { result: null })
        case 'recordCall':
          await this.meter.recordCall(
            asString(args[0]),
            asNumber(args[1]),
            asNumber(args[2]),
            asNumber(args[3]),
            asOptUsageDetail(args[4]),
          )
          return json(200, { result: null })
        case 'countCall':
          // Item 2 cure: the no-reservation counting op behind
          // DurableMeterClient.recordCall's null-reserve fallback.
          // Same args and accounting as recordCall's settle; the
          // difference lives in the client composition, not here.
          await this.meter.countCall(
            asString(args[0]),
            asNumber(args[1]),
            asNumber(args[2]),
            asNumber(args[3]),
            asOptUsageDetail(args[4]),
          )
          return json(200, { result: null })
        case 'recordSearches':
          await this.meter.recordSearches(asNumber(args[0]))
          return json(200, { result: null })
        case 'recordTopBookend':
          await this.meter.recordTopBookend(asTopOutcome(args[0]), asOptSettleClass(args[1]))
          return json(200, { result: null })
        case 'recordBottomBookend':
          await this.meter.recordBottomBookend(
            asBottomOutcome(args[0]),
            asOptSettleClass(args[1]),
          )
          return json(200, { result: null })
        case 'usageSnapshot':
          return json(200, { result: await this.meter.usageSnapshot() })
        case 'release':
          await this.meter.release(asString(args[0]))
          return json(200, { result: null })
        case 'recordError':
          await this.meter.recordError(asString(args[0]))
          return json(200, { result: null })
        case 'recordFailure':
          await this.meter.recordFailure(asOptNumber(args[0]))
          return json(200, { result: null })
        case 'snapshot':
          return json(200, { result: await this.meter.snapshot() })
        case 'breakerState':
          return json(200, {
            result: await this.meter.breakerState(asOptNumber(args[0])),
          })
        case 'configSnapshot':
          return json(200, { result: await this.meter.configSnapshot() })
        case 'operatorReset':
          await this.meter.operatorReset()
          return json(200, { result: null })
        default:
          return json(400, { error: 'not_allowlisted' })
      }
    } catch (e) {
      if (e instanceof ShapeError) return json(400, { error: 'shape_invalid' })
      if (e instanceof MeterUnavailableError) {
        return json(503, { error: 'breaker_open' })
      }
      throw e
    }
  }
}

export interface DurableMeterClientOptions {
  /** Injectable retry delays for hermetic tests; production uses the default. */
  retryDelaysMs?: readonly number[]
}

/**
 * Retry delays for transient Durable Object stub failures. Measured
 * basis (2026-11-02, hourly burndown rounds 0-2): hosted-browser
 * captures repeatedly showed helper calls failing with breaker_open
 * while route probes seconds apart succeeded and the meter's
 * cumulative error map never moved — the signature of the
 * meter-unavailable fail-closed path below, not of a genuine breaker
 * trip (which needs 5 recorded failures) or a provider flap. The
 * class is intermittent per-call DO unavailability as seen from the
 * worker isolates; two short retries (200 ms, 600 ms — far inside
 * the routes' existing 40 s breaker wait-out) cover a transient
 * stub failure without stacking waits.
 */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [200, 600]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Client adapter used by the proxy routes at port time: the Meter op
 * surface over a DO stub. Any failure — unreachable stub, non-200, or
 * the DO's own 503 — surfaces as MeterUnavailableError. Callers split
 * by purpose since 2026-11-02: the request path records accounting
 * through these ops best-effort and swallows the error (a lost record
 * is invisible to the user), while the diagnostics read path surfaces
 * it as 503 rather than reporting fabricated totals.
 *
 * Failures are retried within the bounds above, on a per-op safety
 * split. A DO-answered 503 is proof the op never persisted (the
 * object answers 503 only from its MeterUnavailableError catch,
 * thrown during load/save before the record is written), so any op
 * may retry it. A transport failure (the stub fetch throws, or the
 * response body is unreadable) is ambiguous — the op may have
 * persisted — so only ops whose duplicate application is safe retry
 * it: the reads (their persisted effect is the expired-reservation
 * sweep), release (a delete), and reserve (a duplicate only holds
 * its estimate against the cap until the adapter's 120 s TTL sweep;
 * it is never charged). settle, recordCall, recordError and
 * recordFailure increment counters unconditionally, so they never
 * retry an ambiguous failure: a double count would corrupt spend.
 */
export class DurableMeterClient {
  private readonly retryDelaysMs: readonly number[]

  constructor(
    private readonly stub: DurableObjectStubLike,
    opts: DurableMeterClientOptions = {},
  ) {
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  }

  private async call<T>(
    op: string,
    args: unknown[],
    retryAmbiguous: boolean,
  ): Promise<T> {
    const delays = this.retryDelaysMs
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.stub.fetch('https://meter-do/', {
          method: 'POST',
          body: JSON.stringify({ op, args }),
        })
      } catch (e) {
        if (retryAmbiguous && attempt < delays.length) {
          await sleep(delays[attempt]!)
          continue
        }
        throw new MeterUnavailableError('storage', 'meter DO unreachable', {
          cause: e,
        })
      }
      if (res.status === 503 && attempt < delays.length) {
        await sleep(delays[attempt]!)
        continue
      }
      if (res.status !== 200) {
        throw new MeterUnavailableError(
          'storage',
          `meter DO op ${op} failed with status ${res.status}`,
        )
      }
      try {
        const body = (await res.json()) as { result: T }
        return body.result
      } catch (e) {
        if (retryAmbiguous && attempt < delays.length) {
          await sleep(delays[attempt]!)
          continue
        }
        throw new MeterUnavailableError('storage', 'meter DO unreachable', {
          cause: e,
        })
      }
    }
  }

  reserve(clientId: string, estMicroUsd: number, estTokens: number): Promise<string | null> {
    return this.call<string | null>('reserve', [clientId, estMicroUsd, estTokens], true)
  }

  settle(
    id: string,
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): Promise<void> {
    // The detail rides as a trailing arg: a pre-P7 deployed class
    // reads args[0..4] and ignores it, so the flat settle still lands
    // there and only the splits wait for the redeploy (see the
    // recordCall note below on the deployed-class skew).
    const args: unknown[] = [id, clientId, actualMicroUsd, tin, tout]
    if (detail !== undefined) args.push(detail)
    return this.call<null>('settle', args, false).then(() => undefined)
  }

  /**
   * Accounting for one served call, spoken in the ops the DEPLOYED
   * meter class dispatches. Measured 2026-11-02, first de-gated
   * deployment (d3d5bbe): successful calls stopped appearing in
   * diagnostics (requests/spent frozen across intent + explain +
   * briefing probes while recordError still landed) because the
   * standalone civicscope-meter worker still runs the pre-recordCall
   * class — its dispatch has no 'recordCall' op, so every recordCall
   * failed and the accounting wrapper swallowed it, exactly as
   * designed, invisibly. reserve + settle is the same bookkeeping in
   * the two ops every deployed class speaks. A null reservation (the
   * old contract's cap refusal) used to lose that one call's count
   * and nothing else — the Item 2 cure below replaces that loss
   * with the 'countCall' fallback. Retire this composition when
   * the meter worker is redeployed from a source whose dispatch
   * includes 'recordCall'.
   */
  async recordCall(
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): Promise<void> {
    const id = await this.reserve(clientId, actualMicroUsd, tin + tout)
    if (id === null) {
      // Item 2 cure: a null reserve is a reporting threshold
      // answering (budget cap reached, breaker open) -- it must
      // not erase a completed call's count, which the pre-cure
      // early return above did silently. Fall back to the
      // no-reservation counting op with the same arguments.
      // Against a pre-cure deployed worker the op is unknown and
      // this throws MeterUnavailableError, which the accounting
      // wrapper swallows exactly as it swallowed the pre-cure
      // loss (no regression); the fallback becomes live when the
      // standalone meter worker is redeployed from this source --
      // that redeploy is the recorded deployment precondition.
      const args: unknown[] = [clientId, actualMicroUsd, tin, tout]
      if (detail !== undefined) args.push(detail)
      await this.call<null>('countCall', args, false)
      return
    }
    await this.settle(id, clientId, actualMicroUsd, tin, tout, detail)
  }

  /** Item 2 cure: the 'countCall' op itself, for direct callers. */
  countCall(
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
    detail?: UsageDetail,
  ): Promise<void> {
    const args: unknown[] = [clientId, actualMicroUsd, tin, tout]
    if (detail !== undefined) args.push(detail)
    return this.call<null>('countCall', args, false).then(() => undefined)
  }

  /**
   * P7 ops. These dispatch names exist only in the P7 class, so
   * against the pre-P7 deployed standalone worker they fail with
   * MeterUnavailableError -- which the accounting wrapper swallows
   * (a lost split record, invisible to the user) and the diagnostics
   * read path reports as usage readable: false rather than as
   * fabricated zeros. They increment counters unconditionally, so,
   * like settle, they never retry an ambiguous transport failure.
   */
  recordSearches(count: number): Promise<void> {
    return this.call<null>('recordSearches', [count], false).then(() => undefined)
  }

  recordTopBookend(
    outcome: keyof BookendCounters['top'],
    settle?: BookendSettleClass,
  ): Promise<void> {
    // The settle rides as a trailing arg, like settle's detail: an
    // older deployed class reads args[0] and ignores it, so the
    // count still lands there and only the durable last-settle
    // waits for the redeploy.
    const args: unknown[] = [outcome]
    if (settle !== undefined) args.push(settle)
    return this.call<null>('recordTopBookend', args, false).then(() => undefined)
  }

  recordBottomBookend(
    outcome: keyof BookendCounters['bottom'],
    settle?: BookendSettleClass,
  ): Promise<void> {
    const args: unknown[] = [outcome]
    if (settle !== undefined) args.push(settle)
    return this.call<null>('recordBottomBookend', args, false).then(() => undefined)
  }

  usageSnapshot(): Promise<UsageSnapshot> {
    return this.call<UsageSnapshot>('usageSnapshot', [], true)
  }

  release(id: string): Promise<void> {
    return this.call<null>('release', [id], true).then(() => undefined)
  }

  recordError(cls: string): Promise<void> {
    return this.call<null>('recordError', [cls], false).then(() => undefined)
  }

  recordFailure(now?: number): Promise<void> {
    return this.call<null>('recordFailure', now === undefined ? [] : [now], false).then(
      () => undefined,
    )
  }

  snapshot(): Promise<MeterSnapshot> {
    return this.call<MeterSnapshot>('snapshot', [], true)
  }

  breakerState(now?: number): Promise<BreakerState> {
    return this.call<BreakerState>('breakerState', now === undefined ? [] : [now], true)
  }

  configSnapshot(): Promise<ReturnType<Meter['configSnapshot']>> {
    return this.call<ReturnType<Meter['configSnapshot']>>('configSnapshot', [], true)
  }
}

/** The single judging-window instance, by name (Q1: one named store). */
export function getMeterClient(
  namespace: DurableObjectNamespaceLike,
  name: string = METER_INSTANCE_NAME,
): DurableMeterClient {
  return new DurableMeterClient(namespace.get(namespace.idFromName(name)))
}
