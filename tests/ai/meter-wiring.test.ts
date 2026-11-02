import { beforeEach, describe, expect, it } from 'vitest'
import { handleDiagnostics } from '../../functions/api/muse/diagnostics'
import { handleIntent } from '../../functions/api/muse/intent'
import {
  DurableMeterClient,
  MeterDurableObject,
  getMeterClient,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type DurableObjectStubLike,
} from '../../functions/api/muse/meter-do'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { createStubProvider, type MuseProvider } from '../../src/core/ai/provider'
import {
  meterFor,
  meterPersistenceFor,
  resetMeterForTests,
  type MuseEnv,
} from '../../src/server/muse-adapter'
import type { ProxyDeps } from '../../src/server/muse-proxy'

/**
 * Wiring proof, accounting-only contract (2026-11-02): the proxy
 * handlers account against the Durable Object client (not the
 * in-isolate Meter) when deps carry one, and a meter that cannot be
 * read or written changes NOTHING for the user — the request still
 * succeeds with the provider's answer and the lost accounting record
 * is invisible. (Before de-gating, the same failures were 503
 * breaker_open with no provider call; that fail-closed hop is the
 * class the overhaul removes.) All hermetic: one in-memory Durable
 * Object behind a fake namespace.
 *
 * Accounting through the DO client is deferred fire-and-forget in the
 * handlers, so tests that assert recorded totals first flush the
 * pending hops (flushAccounting); the reply never waits for them.
 */

function fakeStorage(): DurableObjectStorageLike {
  const map = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const v = map.get(key)
      return v === undefined ? undefined : (structuredClone(v) as T)
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value))
    },
  }
}

interface FakeMeter {
  namespace: DurableObjectNamespaceLike
  doObj: MeterDurableObject
  client: DurableMeterClient
}

function fakeMeter(): FakeMeter {
  const state: DurableObjectStateLike = { storage: fakeStorage() }
  const doObj = new MeterDurableObject(state)
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (input, init) => doObj.fetch(new Request(input, init)),
    }),
  }
  return { namespace, doObj, client: getMeterClient(namespace) }
}

function intentReq() {
  return {
    method: 'POST',
    path: '/api/muse/intent',
    body: { slots: {} },
    clientId: 'shared',
  }
}

function depsWith(meter: ProxyDeps['meter'], provider: MuseProvider): ProxyDeps {
  return { meter, provider, allowedModels: ['spark-test'] }
}

/** Let deferred accounting hops land before asserting recorded totals. */
async function flushAccounting(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('handlers account against the Durable Object client', () => {
  beforeEach(() => {
    resetMeterForTests()
  })

  it('recordCall flows through the client into durable state', async () => {
    const { client } = fakeMeter()
    const r = await handleIntent(intentReq(), depsWith(client, createStubProvider()))
    expect(r.status).toBe(200)
    expect(r.body.intent).toBeDefined()

    // A second client over the same object observes the recorded
    // totals: the state lives in the Durable Object, not this isolate.
    await flushAccounting()
    const snap = await client.snapshot()
    expect(snap.requests).toBe(1)
    expect(snap.spentMicroUsd).toBe(1000)
    expect(snap.tokensIn).toBe(128)
    expect(snap.tokensOut).toBe(64)
    expect(snap.budgetExhausted).toBe(false)
  })

  it('recordFailure + recordError flow through on provider failure', async () => {
    const { client } = fakeMeter()
    const provider = createStubProvider({
      async intent() {
        throw Object.assign(new Error('rl'), { code: 'rate_limited' })
      },
    })
    const r = await handleIntent(intentReq(), depsWith(client, provider))
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('rate_limited')

    await flushAccounting()
    const snap = await client.snapshot()
    // Nothing counted as a completed call; the failure class counted.
    expect(snap.requests).toBe(0)
    expect(snap.spentMicroUsd).toBe(0)
    expect(snap.errors.rate_limited).toBe(1)
  })

  it('configSnapshot answers through the client with the Meter shape', async () => {
    const { client } = fakeMeter()
    const viaClient = await client.configSnapshot()
    expect(viaClient).toEqual(new Meter(defaultMeterConfig()).configSnapshot())
  })
})

describe('meter down: the request still succeeds (accounting-only pin)', () => {
  beforeEach(() => {
    resetMeterForTests()
  })

  it('an unreachable meter stub: provider answer served, failure invisible', async () => {
    const deadStub: DurableObjectStubLike = {
      async fetch() {
        throw new Error('unreachable')
      },
    }
    let providerCalls = 0
    const provider = createStubProvider({
      async intent() {
        providerCalls++
        return { intent: { mode: 'lookup', geographies: [], metricKeys: [], filters: [], clarificationNeeded: true } }
      },
    })
    // The decisive de-gating pin: every meter op fails (breaker read
    // at the gate, recordCall after the provider answers), and the
    // reply is still the provider's 200 — no 503, no error field.
    const r = await handleIntent(
      intentReq(),
      depsWith(new DurableMeterClient(deadStub, { retryDelaysMs: [0, 0] }), provider),
    )
    expect(r.status).toBe(200)
    expect(r.body.intent).toBeDefined()
    expect(r.body.error).toBeUndefined()
    expect(providerCalls).toBe(1)
  })

  it('a DO that 503s the accounting write: provider answer still served', async () => {
    const { doObj } = fakeMeter()
    const accountingDown: DurableObjectStubLike = {
      fetch: (input, init) => {
        const op = (JSON.parse(init?.body ?? '{}') as { op?: string }).op
        if (op === 'recordCall') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'breaker_open' }), { status: 503 }),
          )
        }
        return doObj.fetch(new Request(input, init))
      },
    }
    let providerCalls = 0
    const provider = createStubProvider({
      async intent() {
        providerCalls++
        return { intent: { mode: 'lookup', geographies: [], metricKeys: [], filters: [], clarificationNeeded: true } }
      },
    })
    const r = await handleIntent(
      intentReq(),
      depsWith(new DurableMeterClient(accountingDown, { retryDelaysMs: [0, 0] }), provider),
    )
    expect(r.status).toBe(200)
    expect(r.body.intent).toBeDefined()
    expect(providerCalls).toBe(1)
  })
})

describe('adapter chooses the meter the deployment actually carries', () => {
  beforeEach(() => {
    resetMeterForTests()
  })

  it('METER binding -> DurableMeterClient + durable; no binding -> Meter + isolate', () => {
    const { namespace } = fakeMeter()
    const bound = meterFor({ METER: namespace })
    expect(bound).toBeInstanceOf(DurableMeterClient)
    expect(meterPersistenceFor({ METER: namespace })).toBe('durable')

    resetMeterForTests()
    const unbound = meterFor({})
    expect(unbound).toBeInstanceOf(Meter)
    expect(meterPersistenceFor({})).toBe('isolate')
  })

  it('diagnostics reads the same durable store the handlers account against', async () => {
    const { namespace, client } = fakeMeter()
    const env: MuseEnv = { MUSE_API_KEY: 'test-key', METER: namespace }

    const r = await handleIntent(
      intentReq(),
      depsWith(client, createStubProvider()),
    )
    expect(r.status).toBe(200)
    await flushAccounting()

    const response = await handleDiagnostics({
      request: new Request('https://app.test/api/muse/diagnostics', { method: 'GET' }),
      env,
      params: {},
      next: async () => new Response(null, { status: 404 }),
      waitUntil: () => {},
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.meterPersistence).toBe('durable')
    expect(body.requests).toBe(1)
    expect(body.spentMicroUsd).toBe(1000)
    expect(body.budgetCapMicroUsd).toBe(
      new Meter(defaultMeterConfig()).configSnapshot().budgetCapMicroUsd,
    )
  })
})
