import { beforeEach, describe, expect, it } from 'vitest'
import { handleDiagnostics } from '../../functions/api/muse/diagnostics'
import { handleIntent } from '../../functions/api/muse/intent'
import { handlePlan } from '../../functions/api/muse/plan'
import { handleResearch } from '../../functions/api/muse/research'
import {
  DurableMeterClient,
  MeterDurableObject,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type DurableObjectStubLike,
} from '../../functions/api/muse/meter-do'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import {
  MemoryMeterStorage,
  PersistentMeter,
  emptyPersistedState,
  type PersistedMeterState,
} from '../../src/core/ai/meter-persistence'
import {
  createStubProvider,
  createStubStageProvider,
  type MuseProvider,
} from '../../src/core/ai/provider'
import {
  bucketCostMicroUsd,
  computeTrueCosts,
  zeroUsageSnapshot,
  SEARCH_COST_MICRO_USD_PER_SEARCH,
} from '../../src/core/ai/usage'
import { MUSE_SPARK_MODEL, MUSE_WONDER_MODEL } from '../../src/core/ai/meta-client'
import { resetBookendCountersForTests } from '../../src/core/ai/bookend-counters'
import {
  meterFor,
  resetMeterForTests,
  type MuseEnv,
} from '../../src/server/muse-adapter'
import type { ProxyDeps } from '../../src/server/muse-proxy'

/**
 * P7 usage visibility pins (2026-11-02):
 *  - a settle records the model + route split beside the flat totals;
 *  - the true-cost computation is exact on a hand-computed fixture;
 *  - the search counter increments on a stubbed research call, from
 *    the provider-reported count, with one as the floor;
 *  - diagnostics renders both cost lines, labelled, from the durable
 *    store, and the Wonder bookend spend is directly readable;
 *  - the diagnostics additions are read-path only: rendering them
 *    writes nothing, and a failing split write never fails a request.
 */

function deps(meter: ProxyDeps['meter'], provider: MuseProvider, extra: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    meter,
    provider,
    allowedModels: ['spark-test'],
    waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [1, 1] as number[] },
    ...extra,
  }
}

describe('true-cost computation (hand-computed fixture)', () => {
  it('prices split tokens at roster rates and searches at $2.50 per 1000, exactly', () => {
    const usage = zeroUsageSnapshot()
    // Spark: 2,000,000 in at $1.25/1M = $2.50; 1,000,000 out at
    // $4.25/1M = $4.25. Model total $6.75 = 6,750,000 micro-USD.
    usage.byModel[MUSE_SPARK_MODEL] = { calls: 3, tokensIn: 2_000_000, tokensOut: 1_000_000 }
    // Wonder: 500,000 in at $4/1M = $2.00; 100,000 out at $20/1M =
    // $2.00. Model total $4.00 = 4,000,000 micro-USD.
    usage.byModel[MUSE_WONDER_MODEL] = { calls: 1, tokensIn: 500_000, tokensOut: 100_000 }
    // Searches: 40 at $0.0025 = $0.10 = 100,000 micro-USD.
    usage.searches = 40

    const costs = computeTrueCosts(usage)
    expect(costs.byModelCostMicroUsd[MUSE_SPARK_MODEL]).toBe(6_750_000)
    expect(costs.byModelCostMicroUsd[MUSE_WONDER_MODEL]).toBe(4_000_000)
    expect(costs.tokenCostMicroUsd).toBe(10_750_000)
    expect(costs.searchCostMicroUsd).toBe(100_000)
    expect(costs.trueCostMicroUsd).toBe(10_850_000)
    expect(SEARCH_COST_MICRO_USD_PER_SEARCH).toBe(2_500)
  })

  it('rounds a sub-micro token cost once, to the nearest micro-USD', () => {
    // One Spark input token is 1.25 micro-USD; three are 3.75.
    expect(
      bucketCostMicroUsd(MUSE_SPARK_MODEL, { calls: 1, tokensIn: 1, tokensOut: 0 }),
    ).toBe(1)
    expect(
      bucketCostMicroUsd(MUSE_SPARK_MODEL, { calls: 1, tokensIn: 3, tokensOut: 0 }),
    ).toBe(4)
    expect(
      bucketCostMicroUsd(MUSE_WONDER_MODEL, { calls: 0, tokensIn: 0, tokensOut: 0 }),
    ).toBe(0)
  })
})

describe('meter splits', () => {
  it('recordCall and settle bucket by model and route beside the flat totals', () => {
    const meter = new Meter(defaultMeterConfig())
    meter.recordCall('c1', 1000, 128, 64, { model: MUSE_SPARK_MODEL, route: 'intent' })
    const id = meter.reserve('c1', 2000, 512)
    expect(id).not.toBeNull()
    meter.settle(id as string, 'c1', 2000, 384, 128, {
      model: MUSE_WONDER_MODEL,
      route: 'plan',
    })
    // A model outside the closed roster is dropped from the splits;
    // the call itself still counts in the global totals.
    meter.recordCall('c1', 500, 10, 10, { model: 'some-other-model', route: 'intent' })

    const flat = meter.snapshot()
    expect(flat.requests).toBe(3)
    expect(flat.spentMicroUsd).toBe(3500)
    expect(flat.tokensIn).toBe(522)
    expect(flat.tokensOut).toBe(202)

    const usage = meter.usageSnapshot()
    expect(usage.byModel[MUSE_SPARK_MODEL]).toEqual({ calls: 1, tokensIn: 128, tokensOut: 64 })
    expect(usage.byModel[MUSE_WONDER_MODEL]).toEqual({ calls: 1, tokensIn: 384, tokensOut: 128 })
    expect(usage.byRoute.intent).toEqual({ calls: 2, tokensIn: 138, tokensOut: 74 })
    expect(usage.byRoute.plan).toEqual({ calls: 1, tokensIn: 384, tokensOut: 128 })
    expect(usage.byRoute.explain).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0 })
  })

  it('the splits persist across PersistentMeter instances over one store', async () => {
    const storage = new MemoryMeterStorage()
    const a = new PersistentMeter(storage, defaultMeterConfig())
    await a.recordCall('c1', 800, 128, 128, { model: MUSE_SPARK_MODEL, route: 'explain' })
    await a.recordSearches(3)
    await a.recordTopBookend('sound')

    const b = new PersistentMeter(storage, defaultMeterConfig())
    const usage = await b.usageSnapshot()
    expect(usage.byRoute.explain).toEqual({ calls: 1, tokensIn: 128, tokensOut: 128 })
    expect(usage.byModel[MUSE_SPARK_MODEL].calls).toBe(1)
    expect(usage.searches).toBe(3)
    expect(usage.hourglass.top.sound).toBe(1)
    expect((await b.snapshot()).spentMicroUsd).toBe(800)
  })

  it('a pre-P7 persisted record loads with zero splits and intact flat totals', async () => {
    const legacy = emptyPersistedState() as unknown as Record<string, unknown>
    delete legacy.usageByModel
    delete legacy.usageByRoute
    delete legacy.searches
    delete legacy.hourglass
    legacy.requests = 5
    legacy.spentMicroUsd = 4200
    const storage = new MemoryMeterStorage(legacy as unknown as PersistedMeterState)
    const meter = new PersistentMeter(storage, defaultMeterConfig())
    expect((await meter.snapshot()).requests).toBe(5)
    expect((await meter.snapshot()).spentMicroUsd).toBe(4200)
    const usage = await meter.usageSnapshot()
    expect(usage).toEqual(zeroUsageSnapshot())
  })

  it('the splits round-trip through the Durable Object op surface', async () => {
    const map = new Map<string, unknown>()
    const storage: DurableObjectStorageLike = {
      async get<T>(key: string): Promise<T | undefined> {
        const v = map.get(key)
        return v === undefined ? undefined : (structuredClone(v) as T)
      },
      async put(key: string, value: unknown): Promise<void> {
        map.set(key, structuredClone(value))
      },
    }
    const state: DurableObjectStateLike = { storage }
    const doObj = new MeterDurableObject(state)
    const stub: DurableObjectStubLike = {
      fetch: (input, init) => doObj.fetch(new Request(input, init)),
    }
    const client = new DurableMeterClient(stub, { retryDelaysMs: [0, 0] })
    await client.recordCall('c1', 1000, 128, 64, {
      model: MUSE_SPARK_MODEL,
      route: 'intent',
    })
    await client.recordSearches(2)
    await client.recordBottomBookend('verified')

    // A fresh object over the same storage (a cold isolate) reads
    // the same splits: they live in the DO record, not the isolate.
    const cold = new DurableMeterClient(
      { fetch: (input, init) => new MeterDurableObject(state).fetch(new Request(input, init)) },
      { retryDelaysMs: [0, 0] },
    )
    const usage = await cold.usageSnapshot()
    expect(usage.byModel[MUSE_SPARK_MODEL]).toEqual({ calls: 1, tokensIn: 128, tokensOut: 64 })
    expect(usage.byRoute.intent.calls).toBe(1)
    expect(usage.searches).toBe(2)
    expect(usage.hourglass.bottom.verified).toBe(1)
    expect((await cold.snapshot()).spentMicroUsd).toBe(1000)
  })
})

describe('route wiring', () => {
  it('a stubbed research call increments the search counter by the reported count', async () => {
    const meter = new Meter(defaultMeterConfig())
    const d = deps(
      meter,
      createStubProvider({
        async research() {
          return {
            prose: 'Lincoln High is rated well by the state.',
            sources: [{ title: 'State school report', url: 'https://example.org/schools' }],
            searchCalls: 3,
          }
        },
      }),
    )
    const r = await handleResearch(
      { method: 'POST', path: '/api/muse/research', body: { queryText: 'schools near Hilo', places: ['Hilo'] }, clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(200)
    const usage = meter.usageSnapshot()
    expect(usage.searches).toBe(3)
    expect(usage.byRoute.research).toEqual({ calls: 1, tokensIn: 256, tokensOut: 512 })
    expect(usage.byModel[MUSE_SPARK_MODEL]).toEqual({ calls: 1, tokensIn: 256, tokensOut: 512 })
    // The flat modelled settle is unchanged by the new lines.
    expect(meter.snapshot().spentMicroUsd).toBe(5000)
  })

  it('an unreported search count on a completed research reply counts as one', async () => {
    const meter = new Meter(defaultMeterConfig())
    const d = deps(
      meter,
      createStubProvider({
        async research() {
          return {
            prose: 'Lincoln High is rated well by the state.',
            sources: [{ title: 'State school report', url: 'https://example.org/schools' }],
          }
        },
      }),
    )
    const r = await handleResearch(
      { method: 'POST', path: '/api/muse/research', body: { queryText: 'schools near Hilo' }, clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(200)
    expect(meter.usageSnapshot().searches).toBe(1)
  })

  it('Wonder per-request spend is directly readable from the plan split', async () => {
    const meter = new Meter(defaultMeterConfig())
    const d = deps(meter, createStubProvider(), {
      stageProvider: createStubStageProvider({
        async stageChat() {
          return { text: '{"verdict":"sound","objections":[]}', model: MUSE_WONDER_MODEL }
        },
      }),
    })
    const r = await handlePlan(
      {
        method: 'POST',
        path: '/api/muse/plan',
        body: {
          question: 'best schools near Hilo',
          intent: { mode: 'lookup', geographies: ['Hilo, HI'], measures: [] },
          criteria: [{ kind: 'research', text: 'good schools' }],
          subset: { count: 3, ranges: [] },
        },
        clientId: 'c1',
      },
      d,
    )
    expect(r.status).toBe(200)
    const usage = meter.usageSnapshot()
    expect(usage.byModel[MUSE_WONDER_MODEL]).toEqual({ calls: 1, tokensIn: 384, tokensOut: 128 })
    expect(usage.byRoute.plan).toEqual({ calls: 1, tokensIn: 384, tokensOut: 128 })
    expect(usage.hourglass.top.sound).toBe(1)
    // Hand-computed Wonder cost of that one call: 384 in at $4/1M
    // plus 128 out at $20/1M = 0.001536 + 0.00256 = $0.004096,
    // which rounds to 4,096 micro-USD.
    expect(computeTrueCosts(usage).byModelCostMicroUsd[MUSE_WONDER_MODEL]).toBe(4096)
  })
})

describe('diagnostics rendering', () => {
  beforeEach(() => {
    resetMeterForTests()
    resetBookendCountersForTests()
  })

  function context(env: MuseEnv): Parameters<typeof handleDiagnostics>[0] {
    return {
      request: new Request('https://app.test/api/muse/diagnostics', { method: 'GET' }),
      env,
      params: {},
      next: async () => new Response(null, { status: 404 }),
      waitUntil: () => {},
    }
  }

  it('renders both cost lines labelled, plus the splits and durable hourglass', async () => {
    const env: MuseEnv = { MUSE_API_KEY: 'test-key' }
    const meter = meterFor(env)
    // Two Spark intent calls at the flat constants, one search.
    await meter.recordCall('shared', 1000, 128, 64, {
      model: MUSE_SPARK_MODEL,
      route: 'intent',
    })
    await meter.recordCall('shared', 1000, 128, 64, {
      model: MUSE_SPARK_MODEL,
      route: 'intent',
    })
    await meter.recordSearches(1)
    await meter.recordTopBookend('sound')

    const response = await handleDiagnostics(context(env))
    expect(response.status).toBe(200)
    const body = await response.json()

    // Flat modelled accounting, unchanged semantics and label.
    expect(body.spentMicroUsd).toBe(2000)
    expect(body.costs.modelledAccounting.spentMicroUsd).toBe(2000)
    expect(body.costs.modelledAccounting.basis).toContain('flat modelled accounting')

    // True cost, hand-computed: Spark 256 in at $1.25/1M = 320
    // micro; 128 out at $4.25/1M = 544 micro; token total 864.
    // One search = 2,500 micro. True total 3,364 micro.
    expect(body.costs.trueCost.basis).toContain('true cost')
    expect(body.costs.trueCost.tokenCostMicroUsd).toBe(864)
    expect(body.costs.trueCost.searchCostMicroUsd).toBe(2500)
    expect(body.costs.trueCost.trueCostMicroUsd).toBe(3364)
    expect(body.costs.trueCost.byModelCostMicroUsd[MUSE_SPARK_MODEL]).toBe(864)
    expect(body.costs.trueCost.byModelCostMicroUsd[MUSE_WONDER_MODEL]).toBe(0)

    expect(body.usage.readable).toBe(true)
    expect(body.usage.byModel[MUSE_SPARK_MODEL]).toEqual({ calls: 2, tokensIn: 256, tokensOut: 128 })
    expect(body.usage.byRoute.intent).toEqual({ calls: 2, tokensIn: 256, tokensOut: 128 })
    expect(body.usage.searches).toBe(1)
    expect(body.usage.searchCostMicroUsd).toBe(2500)

    // The hourglass reads the meter's durable mirror (the in-isolate
    // counters were reset and never recorded this outcome).
    expect(body.hourglass.top.sound).toBe(1)
  })

  it('is read-path only: rendering diagnostics twice writes nothing', async () => {
    const env: MuseEnv = { MUSE_API_KEY: 'test-key' }
    const meter = meterFor(env)
    await meter.recordCall('shared', 1000, 128, 64, {
      model: MUSE_SPARK_MODEL,
      route: 'intent',
    })
    await meter.recordSearches(2)
    const beforeFlat = await meter.snapshot()
    const beforeUsage = await meter.usageSnapshot()

    const first = await handleDiagnostics(context(env))
    const second = await handleDiagnostics(context(env))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await meter.snapshot()).toEqual(beforeFlat)
    expect(await meter.usageSnapshot()).toEqual(beforeUsage)
  })

  it('a failing split write never fails the request it accounts for', async () => {
    const meter = new Meter(defaultMeterConfig())
    const original = meter.recordSearches.bind(meter)
    meter.recordSearches = () => {
      throw new Error('split store down')
    }
    const d = deps(
      meter,
      createStubProvider({
        async research() {
          return {
            prose: 'Lincoln High is rated well by the state.',
            sources: [{ title: 'State school report', url: 'https://example.org/schools' }],
            searchCalls: 2,
          }
        },
      }),
    )
    const r = await handleResearch(
      { method: 'POST', path: '/api/muse/research', body: { queryText: 'schools near Hilo' }, clientId: 'c1' },
      d,
    )
    expect(r.status).toBe(200)
    expect(r.body.prose).toContain('Lincoln High')
    meter.recordSearches = original

    // Same posture on a classic route: a recordCall that throws is
    // swallowed by the accounting wrapper and the intent still serves.
    const meter2 = new Meter(defaultMeterConfig())
    meter2.recordCall = () => {
      throw new Error('meter down')
    }
    const r2 = await handleIntent(
      { method: 'POST', path: '/api/muse/intent', body: { slots: {} }, clientId: 'c1' },
      deps(meter2, createStubProvider()),
    )
    expect(r2.status).toBe(200)
    expect(r2.body.intent).toBeDefined()
  })
})
