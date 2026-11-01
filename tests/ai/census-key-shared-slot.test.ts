import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSharedCensusKey, resolveCensusKey } from '../../src/core/censusKey'
import { SHARED_APP_KEYS_GLOBAL } from '../../src/core/config/shared-app-key'

/**
 * The serve-time half of getSharedCensusKey: when the build shipped
 * no CENSUS_APP_KEY (the portal's case), resolution must fall back to
 * the global slot the root Pages middleware fills from the deployment
 * environment (docs/shared-app-key.md). Fake values throughout.
 */
const PERSONAL_KEY = 'fake-personal-key-for-tests'
const SLOT_KEY = 'fake-slot-shared-key-for-tests'
const BUILD_TIME_KEY = 'fake-build-time-key-for-tests'

// The storage key src/core/censusKey.ts keeps the personal key under.
const PERSONAL_STORAGE_KEY = 'civicscope.censusKey.v1'

const g = globalThis as Record<string, unknown>
const originalStorage = g.localStorage

function installStorage(): Map<string, string> {
  const store = new Map<string, string>()
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
  }
  return store
}

function setSlot(value: unknown): void {
  g[SHARED_APP_KEYS_GLOBAL] = value
}

function clearSlot(): void {
  delete g[SHARED_APP_KEYS_GLOBAL]
}

beforeEach(() => {
  clearSlot()
  installStorage()
  // Pin the build-time path to absent so each test controls exactly
  // one supply path at a time; tests that exercise it stub a value.
  vi.stubEnv('CENSUS_APP_KEY', '')
})

afterEach(() => {
  clearSlot()
  vi.unstubAllEnvs()
  if (originalStorage === undefined) delete g.localStorage
  else g.localStorage = originalStorage
})

describe('getSharedCensusKey serve-time slot fallback', () => {
  it('returns the slot value when the build shipped no key', () => {
    setSlot({ CENSUS_APP_KEY: SLOT_KEY })
    expect(getSharedCensusKey()).toBe(SLOT_KEY)
    expect(resolveCensusKey()).toEqual({ key: SLOT_KEY, source: 'shared' })
  })

  it('trims the slot value and treats a malformed one as absent', () => {
    setSlot({ CENSUS_APP_KEY: `  ${SLOT_KEY}  ` })
    expect(getSharedCensusKey()).toBe(SLOT_KEY)
    // Interior whitespace is a malformed deployment value; the shared
    // reader normalizes it to absent rather than sending garbage.
    setSlot({ CENSUS_APP_KEY: 'two words' })
    expect(getSharedCensusKey()).toBeUndefined()
    setSlot({ CENSUS_APP_KEY: '   ' })
    expect(getSharedCensusKey()).toBeUndefined()
  })

  it('prefers the build-time value over the slot when both are present', () => {
    vi.stubEnv('CENSUS_APP_KEY', BUILD_TIME_KEY)
    setSlot({ CENSUS_APP_KEY: SLOT_KEY })
    expect(getSharedCensusKey()).toBe(BUILD_TIME_KEY)
    expect(resolveCensusKey()).toEqual({ key: BUILD_TIME_KEY, source: 'shared' })
  })

  it('resolves to no key when neither path supplies one', () => {
    expect(getSharedCensusKey()).toBeUndefined()
    expect(resolveCensusKey()).toBeUndefined()
  })

  it('keeps the personal key winning over the slot value', () => {
    const store = installStorage()
    store.set(PERSONAL_STORAGE_KEY, PERSONAL_KEY)
    setSlot({ CENSUS_APP_KEY: SLOT_KEY })
    expect(resolveCensusKey()).toEqual({ key: PERSONAL_KEY, source: 'personal' })
    // The shared getter itself still reports the slot value; only
    // resolution applies the personal-over-shared precedence.
    expect(getSharedCensusKey()).toBe(SLOT_KEY)
  })
})
