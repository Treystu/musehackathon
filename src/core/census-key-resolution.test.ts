import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CENSUS_KEY_EVENT,
  clearCensusKey,
  getCensusKey,
  getCensusKeySource,
  getSharedCensusKey,
  resolveCensusKey,
  setCensusKey,
} from './censusKey'
import { PluginRegistry, executePlugins } from './executor'
import { runSweep } from './sweep/runSweep'
import type { MetricValue, PluginRequest } from './types'

// Synthetic fixtures in the style of censusKey.test.ts: sequential hex that
// no real key resembles, distinct per source so a mix-up between the two
// values is visible in a failure message.
const PERSONAL_KEY = '0123456789abcdef0123456789abcdef01234567'
const SHARED_KEY = 'fedcba9876543210fedcba9876543210fedcba98'

type GlobalStub = {
  localStorage?: unknown
  window?: unknown
}
const g = globalThis as GlobalStub
const originalStorage = g.localStorage
const originalWindow = g.window

function installStorage() {
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

function removeStorage() {
  delete g.localStorage
}

beforeEach(() => {
  installStorage()
  // Baseline for every case: the deployment supplied nothing. Individual
  // cases stub a value in. An empty string is what an unset variable looks
  // like after Vite's env handling, and the resolver must treat it as absent.
  vi.stubEnv('CENSUS_APP_KEY', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  removeStorage()
  delete g.window
  if (originalStorage === undefined) delete g.localStorage
  else g.localStorage = originalStorage
  if (originalWindow === undefined) delete g.window
  else g.window = originalWindow
})

describe('resolveCensusKey precedence', () => {
  it('resolves to nothing when neither key exists', () => {
    expect(resolveCensusKey()).toBeUndefined()
    expect(getCensusKeySource()).toBeUndefined()
    expect(getSharedCensusKey()).toBeUndefined()
  })

  it('resolves a personal key with source personal', () => {
    setCensusKey(PERSONAL_KEY)
    expect(resolveCensusKey()).toEqual({ key: PERSONAL_KEY, source: 'personal' })
    expect(getCensusKeySource()).toBe('personal')
  })

  it('resolves the shared key with source shared, without touching the personal accessor', () => {
    vi.stubEnv('CENSUS_APP_KEY', SHARED_KEY)
    expect(resolveCensusKey()).toEqual({ key: SHARED_KEY, source: 'shared' })
    expect(getCensusKeySource()).toBe('shared')
    // The personal lifecycle must not observe the deployment's key: surfaces
    // that ask "did the visitor add a key" read getCensusKey, and a shared
    // default is not a visitor action.
    expect(getCensusKey()).toBeUndefined()
  })

  it('prefers the personal key when both exist', () => {
    vi.stubEnv('CENSUS_APP_KEY', SHARED_KEY)
    setCensusKey(PERSONAL_KEY)
    expect(resolveCensusKey()).toEqual({ key: PERSONAL_KEY, source: 'personal' })
  })

  it('treats an empty shared value as absent', () => {
    vi.stubEnv('CENSUS_APP_KEY', '')
    expect(getSharedCensusKey()).toBeUndefined()
    expect(resolveCensusKey()).toBeUndefined()
  })

  it('trims a shared value carrying dashboard whitespace', () => {
    vi.stubEnv('CENSUS_APP_KEY', `  ${SHARED_KEY}\n`)
    expect(getSharedCensusKey()).toBe(SHARED_KEY)
  })

  it('falls back to the shared key when the personal key is removed', () => {
    vi.stubEnv('CENSUS_APP_KEY', SHARED_KEY)
    setCensusKey(PERSONAL_KEY)
    expect(getCensusKeySource()).toBe('personal')
    clearCensusKey()
    expect(resolveCensusKey()).toEqual({ key: SHARED_KEY, source: 'shared' })
  })
})

describe('CENSUS_KEY_EVENT stays a personal-key lifecycle signal', () => {
  function installWindow() {
    const dispatchEvent = vi.fn()
    g.window = { dispatchEvent }
    return dispatchEvent
  }

  it('fires when a personal key is saved and when it is removed', () => {
    const dispatchEvent = installWindow()
    setCensusKey(PERSONAL_KEY)
    clearCensusKey()
    const types = dispatchEvent.mock.calls.map((c) => (c[0] as Event).type)
    expect(types).toEqual([CENSUS_KEY_EVENT, CENSUS_KEY_EVENT])
  })

  it('never fires for the shared key, which is a build-time constant', () => {
    const dispatchEvent = installWindow()
    vi.stubEnv('CENSUS_APP_KEY', SHARED_KEY)
    resolveCensusKey()
    getSharedCensusKey()
    getCensusKeySource()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})

function metric(partial: Partial<MetricValue> = {}): MetricValue {
  return {
    key: 'k',
    label: 'L',
    value: 100,
    unit: 'count',
    category: 'cost',
    source: { publisher: 'p', dataset: 'd', tableId: 't', vintage: 'v', url: 'u' },
    quality: {},
    ...partial,
  }
}

function plugin(partial: Partial<PluginRequest> & { id: string }): PluginRequest {
  return {
    title: partial.id,
    category: 'cost',
    geography: 'tract',
    minZoom: 0,
    legal: {},
    fetch: async () => [],
    ...partial,
  } as PluginRequest
}

/**
 * The seam the app itself uses: useHousingQuery resolves the key and hands
 * the value (not the resolution) to the executor via QueryContext. These
 * cases drive the executor through exactly that seam, per key source.
 */
describe('executor driven by the resolved key', () => {
  function ctxWithResolvedKey() {
    return {
      zoom: 0 as const,
      censusKey: resolveCensusKey()?.key,
      signal: new AbortController().signal,
    }
  }

  async function runBoth() {
    const r = new PluginRegistry().registerAll([
      plugin({ id: 'keyed', requiresCensusKey: true, fetch: async () => [metric()] }),
      plugin({ id: 'keyless', fetch: async () => [metric()] }),
    ])
    return executePlugins({ registry: r, ids: ['keyed', 'keyless'], ctx: ctxWithResolvedKey() })
  }

  it('runs key-requiring plugins on the shared key alone', async () => {
    vi.stubEnv('CENSUS_APP_KEY', SHARED_KEY)
    const out = await runBoth()
    expect(out.find((x) => x.pluginId === 'keyed')?.status).toBe('ok')
    expect(out.find((x) => x.pluginId === 'keyless')?.status).toBe('ok')
  })

  it('runs key-requiring plugins on a personal key', async () => {
    setCensusKey(PERSONAL_KEY)
    const out = await runBoth()
    expect(out.find((x) => x.pluginId === 'keyed')?.status).toBe('ok')
  })

  it('reports needs-key for key-requiring plugins, and still runs keyless ones, with no key at all', async () => {
    const out = await runBoth()
    expect(out.find((x) => x.pluginId === 'keyed')?.status).toBe('needs-key')
    expect(out.find((x) => x.pluginId === 'keyless')?.status).toBe('ok')
  })
})

describe('runSweep key guard', () => {
  it('still refuses with the key-required error when no key exists from either source', async () => {
    await expect(runSweep({ signal: new AbortController().signal })).rejects.toThrow(
      /a Census API key is required/,
    )
  })

  it('gets past the guard on the shared key alone', async () => {
    vi.stubEnv('CENSUS_APP_KEY', SHARED_KEY)
    // Pre-aborted: the sweep must leave the guard behind and fail on the
    // (aborted) enumeration fetch instead of the key check. If the guard
    // still fired, the rejection would name the key.
    const ctrl = new AbortController()
    ctrl.abort()
    const err = await runSweep({ signal: ctrl.signal }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/a Census API key is required/)
  })
})
