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
 * Failure modes stay fail-closed: a MeterUnavailableError from the
 * adapter is answered 503 breaker_open (closed taxonomy) and no
 * unmetered provider call is ever made.
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
 * overrides (the per-client cap value itself remains the S10 decision;
 * this only wires where the configured value arrives from).
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
          )
          return json(200, { result: null })
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

/**
 * Client adapter used by the proxy routes at port time: the Meter op
 * surface over a DO stub. Any failure — unreachable stub, non-200, or
 * the DO's own fail-closed 503 — surfaces as MeterUnavailableError so
 * the proxy maps it to 503 breaker_open and makes no provider call.
 */
export class DurableMeterClient {
  constructor(private readonly stub: DurableObjectStubLike) {}

  private async call<T>(op: string, args: unknown[]): Promise<T> {
    let res: Response
    try {
      res = await this.stub.fetch('https://meter-do/', {
        method: 'POST',
        body: JSON.stringify({ op, args }),
      })
    } catch (e) {
      throw new MeterUnavailableError('storage', 'meter DO unreachable', {
        cause: e,
      })
    }
    if (res.status !== 200) {
      throw new MeterUnavailableError(
        'storage',
        `meter DO op ${op} failed with status ${res.status}`,
      )
    }
    const body = (await res.json()) as { result: T }
    return body.result
  }

  reserve(clientId: string, estMicroUsd: number, estTokens: number): Promise<string | null> {
    return this.call<string | null>('reserve', [clientId, estMicroUsd, estTokens])
  }

  settle(
    id: string,
    clientId: string,
    actualMicroUsd: number,
    tin: number,
    tout: number,
  ): Promise<void> {
    return this.call<null>('settle', [id, clientId, actualMicroUsd, tin, tout]).then(
      () => undefined,
    )
  }

  release(id: string): Promise<void> {
    return this.call<null>('release', [id]).then(() => undefined)
  }

  recordError(cls: string): Promise<void> {
    return this.call<null>('recordError', [cls]).then(() => undefined)
  }

  recordFailure(now?: number): Promise<void> {
    return this.call<null>('recordFailure', now === undefined ? [] : [now]).then(
      () => undefined,
    )
  }

  snapshot(): Promise<MeterSnapshot> {
    return this.call<MeterSnapshot>('snapshot', [])
  }

  breakerState(now?: number): Promise<BreakerState> {
    return this.call<BreakerState>('breakerState', now === undefined ? [] : [now])
  }

  configSnapshot(): Promise<ReturnType<Meter['configSnapshot']>> {
    return this.call<ReturnType<Meter['configSnapshot']>>('configSnapshot', [])
  }
}

/** The single judging-window instance, by name (Q1: one named store). */
export function getMeterClient(
  namespace: DurableObjectNamespaceLike,
  name: string = METER_INSTANCE_NAME,
): DurableMeterClient {
  return new DurableMeterClient(namespace.get(namespace.idFromName(name)))
}
