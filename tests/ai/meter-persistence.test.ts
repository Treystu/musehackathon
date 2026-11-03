import { describe, expect, it } from 'vitest'
import { defaultMeterConfig, type MeterConfig } from '../../src/core/ai/meter'
import {
  MemoryMeterStorage,
  MeterUnavailableError,
  PersistentMeter,
  RESERVATION_TTL_MS,
  emptyPersistedState,
  type MeterStorage,
  type PersistedMeterState,
} from '../../src/core/ai/meter-persistence'

function cfg(overrides: Partial<MeterConfig> = {}): MeterConfig {
  return { ...defaultMeterConfig(), ...overrides }
}

describe('persistent meter', () => {
  it('round-trips: ops through one instance are observed by a fresh instance', async () => {
    const storage = new MemoryMeterStorage()
    const a = new PersistentMeter(storage, cfg())
    const id = await a.reserve('c1', 1000, 100)
    expect(id).toBe('r1')
    await a.settle('r1', 'c1', 900, 10, 5)
    await a.recordError('provider_down')

    const b = new PersistentMeter(storage, cfg())
    expect(await b.snapshot()).toEqual({
      requests: 1,
      tokensIn: 10,
      tokensOut: 5,
      spentMicroUsd: 900,
      budgetExhausted: false,
      errors: { provider_down: 1 },
    })
    // Reservation ids never restart across incarnations (no r1 reuse).
    expect(await b.reserve('c1', 100, 10)).toBe('r2')
  })

  it('enforces one global cap across instances sharing a store', async () => {
    const storage = new MemoryMeterStorage()
    const c = cfg({ budgetCapMicroUsd: 1000 })
    const a = new PersistentMeter(storage, c)
    const b = new PersistentMeter(storage, c)
    expect(await a.reserve('c1', 600, 10)).not.toBeNull()
    expect(await b.reserve('c2', 600, 10)).toBeNull()
    expect(await b.reserve('c2', 400, 10)).not.toBeNull()
  })

  it('settles a reservation through a different instance than reserved it', async () => {
    const storage = new MemoryMeterStorage()
    const a = new PersistentMeter(storage, cfg())
    const b = new PersistentMeter(storage, cfg())
    const id = await a.reserve('c1', 500, 10)
    await b.settle(id as string, 'c1', 450, 3, 2)
    const snap = await new PersistentMeter(storage, cfg()).snapshot()
    expect(snap.requests).toBe(1)
    expect(snap.spentMicroUsd).toBe(450)
  })

  it('expires reservations after the TTL so their budget returns to the pool', async () => {
    let now = 1_000_000
    const clock = () => now
    const storage = new MemoryMeterStorage()
    const c = cfg({ budgetCapMicroUsd: 1000 })
    const a = new PersistentMeter(storage, c, { now: clock })
    expect(await a.reserve('c1', 600, 10)).not.toBeNull()
    expect(await a.reserve('c1', 600, 10)).toBeNull()

    now += RESERVATION_TTL_MS + 1
    const b = new PersistentMeter(storage, c, { now: clock })
    expect(await b.reserve('c1', 600, 10)).not.toBeNull()
    expect(Object.keys(storage.peek()?.reservations ?? {})).toEqual(['r2'])
  })

  it('shares breaker state: failures in one instance open the breaker for all', async () => {
    // Anchored at the real wall clock: Meter.reserve() consults the
    // breaker with Date.now() internally, so a fake epoch far in the
    // past would read as "cooldown already elapsed" there.
    const now = Date.now()
    const clock = () => now
    const storage = new MemoryMeterStorage()
    const c = cfg({ breakerFailureThreshold: 2 })
    const a = new PersistentMeter(storage, c, { now: clock })
    await a.recordFailure()
    await a.recordFailure()

    const b = new PersistentMeter(storage, c, { now: clock })
    expect(await b.breakerState()).toBe('open')
    expect(await b.reserve('c1', 100, 10)).toBeNull()
  })

  it('persists per-client spend so the S10 cap survives instance churn', async () => {
    const storage = new MemoryMeterStorage()
    const c = cfg({ perClientCapMicroUsd: 500 })
    const a = new PersistentMeter(storage, c)
    const id = await a.reserve('c1', 400, 10)
    await a.settle(id as string, 'c1', 400, 1, 1)

    const b = new PersistentMeter(storage, c)
    expect(await b.reserve('c1', 200, 10)).toBeNull()
    expect(await b.reserve('c1', 100, 10)).not.toBeNull()
    expect(await b.reserve('c2', 500, 10)).not.toBeNull()
  })

  it('initializes an empty store at v1 on first use (designed cutover)', async () => {
    const storage = new MemoryMeterStorage()
    const pm = new PersistentMeter(storage, cfg())
    const snap = await pm.snapshot()
    expect(snap.requests).toBe(0)
    expect(snap.spentMicroUsd).toBe(0)
    expect(storage.peek()?.version).toBe(1)
  })

  it('fails closed when the storage write throws, leaving the record untouched', async () => {
    const inner = new MemoryMeterStorage()
    const throwing: MeterStorage = {
      get: () => inner.get(),
      put: () => Promise.reject(new Error('storage down')),
    }
    const pm = new PersistentMeter(throwing, cfg())
    await expect(pm.reserve('c1', 100, 10)).rejects.toBeInstanceOf(
      MeterUnavailableError,
    )
    await expect(pm.reserve('c1', 100, 10)).rejects.toMatchObject({
      reason: 'storage',
    })
    expect(inner.peek()).toBeUndefined()
  })

  it('fails closed when the storage read throws', async () => {
    const throwing: MeterStorage = {
      get: () => Promise.reject(new Error('storage down')),
      put: () => Promise.resolve(),
    }
    const pm = new PersistentMeter(throwing, cfg())
    await expect(pm.snapshot()).rejects.toBeInstanceOf(MeterUnavailableError)
  })

  it('fails closed on an unknown schema version and does not overwrite it', async () => {
    const seeded = {
      ...(new MemoryMeterStorage().peek() ?? {}),
      version: 99,
    } as unknown as PersistedMeterState
    const storage = new MemoryMeterStorage()
    await storage.put(seeded)
    const pm = new PersistentMeter(storage, cfg())
    await expect(pm.snapshot()).rejects.toMatchObject({
      reason: 'version_unknown',
    })
    expect(storage.peek()?.version).toBe(99 as unknown as 1)
  })

  it('fails closed on a corrupt record and does not overwrite it', async () => {
    const storage = new MemoryMeterStorage()
    await storage.put({
      version: 1,
      requests: 'not-a-number',
    } as unknown as PersistedMeterState)
    const pm = new PersistentMeter(storage, cfg())
    await expect(pm.snapshot()).rejects.toMatchObject({
      reason: 'state_invalid',
    })
    const after = storage.peek() as unknown as Record<string, unknown>
    expect(after.requests).toBe('not-a-number')
  })

  it('hourglassLastSettle: a pre-cure record loads as null/null and a cured record round-trips (Item 2, pin E)', async () => {
    const legacy = emptyPersistedState() as unknown as Record<string, unknown>
    delete legacy.hourglassLastSettle
    legacy.requests = 3
    const legacyStorage = new MemoryMeterStorage(legacy as unknown as PersistedMeterState)
    const legacyMeter = new PersistentMeter(legacyStorage, cfg())
    expect((await legacyMeter.snapshot()).requests).toBe(3)
    expect((await legacyMeter.usageSnapshot()).hourglassLastSettle).toEqual({
      top: null,
      bottom: null,
    })

    const storage = new MemoryMeterStorage()
    const a = new PersistentMeter(storage, cfg())
    await a.recordTopBookend('sound', 'settled-ok')
    await a.recordBottomBookend('notRun', 'skipped')
    // The raw record carries the field under version 1 (additive).
    const raw = storage.peek()
    expect(raw?.hourglassLastSettle?.top?.outcome).toBe('sound')
    expect(raw?.hourglassLastSettle?.bottom?.settle).toBe('skipped')

    const b = new PersistentMeter(storage, cfg())
    const usage = await b.usageSnapshot()
    expect(usage.hourglass.top.sound).toBe(1)
    expect(usage.hourglass.bottom.notRun).toBe(1)
    expect(usage.hourglassLastSettle.top?.outcome).toBe('sound')
    expect(usage.hourglassLastSettle.top?.settle).toBe('settled-ok')
    expect(Number.isNaN(Date.parse(usage.hourglassLastSettle.top?.at ?? ''))).toBe(false)
    expect(usage.hourglassLastSettle.bottom?.outcome).toBe('notRun')
    expect(usage.hourglassLastSettle.bottom?.settle).toBe('skipped')
  })

  it('operatorReset is the only path that overwrites an invalid record', async () => {
    const storage = new MemoryMeterStorage()
    await storage.put({ version: 99 } as unknown as PersistedMeterState)
    const pm = new PersistentMeter(storage, cfg())
    await expect(pm.snapshot()).rejects.toBeInstanceOf(MeterUnavailableError)

    await pm.operatorReset()
    const snap = await pm.snapshot()
    expect(snap.requests).toBe(0)
    expect(snap.errors.meter_state_invalid).toBe(1)
    expect(storage.peek()?.version).toBe(1)
  })
})
