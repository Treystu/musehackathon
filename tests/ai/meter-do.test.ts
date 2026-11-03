import { describe, expect, it } from 'vitest'
import {
  DurableMeterClient,
  MeterDurableObject,
  getMeterClient,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type DurableObjectStubLike,
} from '../../functions/api/muse/meter-do'
import { mapMeterError } from '../../functions/api/muse/shared'
import { MeterUnavailableError } from '../../src/core/ai/meter-persistence'

/** Map-backed fake of Durable Object storage (deep copies at the boundary). */
function fakeState(): { state: DurableObjectStateLike; map: Map<string, unknown> } {
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
  return { state: { storage }, map }
}

function call(doObj: MeterDurableObject, op: string, args: unknown[] = []): Promise<Response> {
  return doObj.fetch(
    new Request('https://meter-do/', {
      method: 'POST',
      body: JSON.stringify({ op, args }),
    }),
  )
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

function stubFor(doObj: MeterDurableObject): DurableObjectStubLike {
  return {
    fetch: (input, init) => doObj.fetch(new Request(input, init)),
  }
}

describe('meter durable object', () => {
  it('round-trips reserve -> settle -> snapshot across object incarnations', async () => {
    const { state } = fakeState()
    const first = new MeterDurableObject(state)
    const reserve = await call(first, 'reserve', ['c1', 1000, 100])
    expect(reserve.status).toBe(200)
    expect((await body(reserve)).result).toBe('r1')
    expect((await call(first, 'settle', ['r1', 'c1', 900, 10, 5])).status).toBe(200)

    // A new object over the same storage (restart) sees the same aggregate.
    const second = new MeterDurableObject(state)
    const snap = await body(await call(second, 'snapshot'))
    expect(snap.result).toEqual({
      requests: 1,
      tokensIn: 10,
      tokensOut: 5,
      spentMicroUsd: 900,
      budgetExhausted: false,
      errors: {},
    })
  })

  it('rejects unknown ops and malformed envelopes on the closed taxonomy', async () => {
    const { state } = fakeState()
    const doObj = new MeterDurableObject(state)
    const unknown = await call(doObj, 'dropTable')
    expect(unknown.status).toBe(400)
    expect((await body(unknown)).error).toBe('not_allowlisted')

    const malformed = await doObj.fetch(
      new Request('https://meter-do/', { method: 'POST', body: 'not json' }),
    )
    expect(malformed.status).toBe(400)
    expect((await body(malformed)).error).toBe('shape_invalid')

    const badArgs = await call(doObj, 'reserve', ['c1', 'lots', 10])
    expect(badArgs.status).toBe(400)
    expect((await body(badArgs)).error).toBe('shape_invalid')
  })

  it('answers 503 breaker_open when storage fails (fail closed)', async () => {
    const failing: DurableObjectStateLike = {
      storage: {
        async get<T>(): Promise<T | undefined> {
          return undefined
        },
        async put(): Promise<void> {
          throw new Error('storage down')
        },
      },
    }
    const doObj = new MeterDurableObject(failing)
    const res = await call(doObj, 'reserve', ['c1', 100, 10])
    expect(res.status).toBe(503)
    expect((await body(res)).error).toBe('breaker_open')
  })

  it('recovers a corrupt record only through the operatorReset verb', async () => {
    const { state, map } = fakeState()
    map.set('meter/v1', { version: 99 })
    const doObj = new MeterDurableObject(state)
    expect((await call(doObj, 'snapshot')).status).toBe(503)

    expect((await call(doObj, 'operatorReset')).status).toBe(200)
    const snap = await body(await call(doObj, 'snapshot'))
    const result = snap.result as { errors: Record<string, number> }
    expect(result.errors.meter_state_invalid).toBe(1)
  })
})

describe('durable meter client', () => {
  it('drives the full op surface through a stub', async () => {
    const { state } = fakeState()
    const doObj = new MeterDurableObject(state)
    const client = new DurableMeterClient(stubFor(doObj))

    const id = await client.reserve('c1', 1000, 100)
    expect(id).toBe('r1')
    await client.settle(id as string, 'c1', 900, 10, 5)
    await client.recordError('provider_down')
    const snap = await client.snapshot()
    expect(snap.spentMicroUsd).toBe(900)
    expect(snap.errors.provider_down).toBe(1)
    expect(await client.breakerState()).toBe('closed')
  })

  it('recordCall counts a completed call with no reservation (request-path accounting)', async () => {
    const { state } = fakeState()
    const doObj = new MeterDurableObject(state)
    const client = new DurableMeterClient(stubFor(doObj))

    await client.recordCall('c1', 800, 128, 128)
    await client.recordCall('c1', 800, 128, 128)
    const snap = await client.snapshot()
    expect(snap.requests).toBe(2)
    expect(snap.spentMicroUsd).toBe(1600)
    expect(snap.tokensIn).toBe(256)
    expect(snap.tokensOut).toBe(256)
  })

  it('recordCall still counts via countCall when reserve always returns null (Item 2 cure, pin C)', async () => {
    // A zero budget cap is a reporting threshold that refuses every
    // reservation; the completed call's count must survive it.
    const { state } = fakeState()
    const doObj = new MeterDurableObject(state, { METER_BUDGET_CAP_MICRO_USD: '0' })
    const client = new DurableMeterClient(stubFor(doObj), { retryDelaysMs: [0, 0] })
    expect(await client.reserve('c1', 800, 256)).toBeNull()

    await client.recordCall('c1', 800, 128, 128, {
      model: 'muse-spark-1.3',
      route: 'intent',
    })
    const snap = await client.snapshot()
    expect(snap.requests).toBe(1)
    expect(snap.spentMicroUsd).toBe(800)
    expect(snap.tokensIn).toBe(128)
    expect(snap.tokensOut).toBe(128)
    const usage = await client.usageSnapshot()
    expect(usage.byRoute.intent).toEqual({ calls: 1, tokensIn: 128, tokensOut: 128 })
  })

  it('fails closed when the stub answers non-200 or throws', async () => {
    const down: DurableObjectStubLike = {
      fetch: () => Promise.resolve(new Response('{}', { status: 503 })),
    }
    await expect(new DurableMeterClient(down).snapshot()).rejects.toBeInstanceOf(
      MeterUnavailableError,
    )
    const unreachable: DurableObjectStubLike = {
      fetch: () => Promise.reject(new Error('no route')),
    }
    await expect(
      new DurableMeterClient(unreachable).reserve('c1', 1, 1),
    ).rejects.toBeInstanceOf(MeterUnavailableError)
  })

  it('getMeterClient resolves the single named judging-window instance', async () => {
    const { state } = fakeState()
    const doObj = new MeterDurableObject(state)
    const seen: string[] = []
    const client = getMeterClient({
      idFromName: (name: string) => {
        seen.push(name)
        return name
      },
      get: () => stubFor(doObj),
    })
    expect(seen).toEqual(['judging-window-v1'])
    expect(await client.reserve('c1', 100, 10)).toBe('r1')
  })
})

describe('durable meter client retry (transient DO unavailability)', () => {
  const NO_WAIT = { retryDelaysMs: [0, 0] }

  function flaky(
    doObj: MeterDurableObject,
    plan: Array<'throw' | 's503' | 'ok'>,
  ): { stub: DurableObjectStubLike; attempts: () => number } {
    let n = 0
    return {
      stub: {
        fetch: (input, init) => {
          const step = plan[Math.min(n, plan.length - 1)]!
          n += 1
          if (step === 'throw') return Promise.reject(new Error('no route'))
          if (step === 's503') return Promise.resolve(new Response('{}', { status: 503 }))
          return doObj.fetch(new Request(input, init))
        },
      },
      attempts: () => n,
    }
  }

  it('retries a read after a transport failure and answers', async () => {
    const { state } = fakeState()
    const { stub, attempts } = flaky(new MeterDurableObject(state), ['throw', 'ok'])
    const snap = await new DurableMeterClient(stub, NO_WAIT).snapshot()
    expect(snap.requests).toBe(0)
    expect(attempts()).toBe(2)
  })

  it('retries a reserve after a DO-answered 503 and reserves exactly once', async () => {
    const { state } = fakeState()
    const { stub } = flaky(new MeterDurableObject(state), ['s503', 'ok'])
    const client = new DurableMeterClient(stub, NO_WAIT)
    expect(await client.reserve('c1', 1000, 100)).toBe('r1')
    expect((await client.snapshot()).requests).toBe(0)
  })

  it('still fails closed after the retries are spent', async () => {
    const { stub, attempts } = flaky(new MeterDurableObject(fakeState().state), [
      'throw',
      'throw',
      'throw',
      'ok',
    ])
    await expect(new DurableMeterClient(stub, NO_WAIT).snapshot()).rejects.toBeInstanceOf(
      MeterUnavailableError,
    )
    expect(attempts()).toBe(3)
  })

  it('retries settle on a DO-answered 503 (op provably never persisted) exactly once', async () => {
    const { state } = fakeState()
    const doObj = new MeterDurableObject(state)
    const direct = new DurableMeterClient(stubFor(doObj))
    const id = await direct.reserve('c1', 1000, 100)
    const { stub } = flaky(doObj, ['s503', 'ok'])
    await new DurableMeterClient(stub, NO_WAIT).settle(id as string, 'c1', 900, 10, 5)
    const snap = await direct.snapshot()
    expect(snap.requests).toBe(1)
    expect(snap.spentMicroUsd).toBe(900)
  })

  it('never retries settle on an ambiguous transport failure (no double count)', async () => {
    const { state } = fakeState()
    const doObj = new MeterDurableObject(state)
    const direct = new DurableMeterClient(stubFor(doObj))
    const id = await direct.reserve('c1', 1000, 100)
    const { stub, attempts } = flaky(doObj, ['throw', 'ok'])
    await expect(
      new DurableMeterClient(stub, NO_WAIT).settle(id as string, 'c1', 900, 10, 5),
    ).rejects.toBeInstanceOf(MeterUnavailableError)
    expect(attempts()).toBe(1)
    expect((await direct.snapshot()).requests).toBe(0)
  })
})

describe('mapMeterError', () => {
  it('maps meter unavailability to 503 breaker_open on the closed taxonomy', () => {
    const mapped = mapMeterError(
      new MeterUnavailableError('storage', 'meter storage write failed'),
    )
    expect(mapped.status).toBe(503)
    expect(mapped.body.error).toBe('breaker_open')
  })

  it('maps anything else to 502 provider_down', () => {
    const mapped = mapMeterError(new Error('boom'))
    expect(mapped.status).toBe(502)
    expect(mapped.body.error).toBe('provider_down')
  })
})
