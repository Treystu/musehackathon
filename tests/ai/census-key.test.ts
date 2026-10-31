import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CENSUS_KEY_EVENT,
  CENSUS_KEY_STORAGE_KEY,
  clearCensusKey,
  getCensusKey,
  hasCensusKey,
  normalizeCensusKey,
  setCensusKey,
  validateCensusKey,
} from '../../src/core/ai/census-key'

// Clearly-fake placeholder, assembled from short segments (<40 chars
// each) so no literal in this file resembles a real Census key.
const fakeKey = ['0123456789abcdef', '0123456789abcdef', '01234567'].join('')
const truncatedKey = ['0123456789abcdef', '0123456789abcdef', '0123456'].join('')

type GlobalStub = {
  localStorage?: unknown
  dispatchEvent?: unknown
}
const g = globalThis as GlobalStub
const originalStorage = g.localStorage
const originalDispatch = g.dispatchEvent

function installStorage() {
  const store = new Map<string, string>()
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
  }
  g.localStorage = stub
  return store
}

function removeStorage() {
  delete g.localStorage
}

function recordEvents() {
  const events: Array<{ type: string; detail?: { present?: boolean } }> = []
  g.dispatchEvent = (e: { type: string; detail?: { present?: boolean } }) => {
    events.push(e)
    return true
  }
  return events
}

beforeEach(() => {
  removeStorage()
  delete g.dispatchEvent
  clearCensusKey()
})

afterEach(() => {
  clearCensusKey()
  removeStorage()
  if (originalStorage === undefined) delete g.localStorage
  else g.localStorage = originalStorage
  if (originalDispatch === undefined) delete g.dispatchEvent
  else g.dispatchEvent = originalDispatch
  vi.restoreAllMocks()
})

describe('normalizeCensusKey', () => {
  it('extracts the 40-hex token from an emailed paste', () => {
    const paste = `Your Census API key is: "${fakeKey}"\nKeep it somewhere safe.`
    expect(normalizeCensusKey(paste)).toEqual({ key: fakeKey, shape: 'ok' })
    expect(normalizeCensusKey(`  ${fakeKey}  `)).toEqual({ key: fakeKey, shape: 'ok' })
  })

  it('reports not-found for a truncated or non-key paste', () => {
    expect(normalizeCensusKey(truncatedKey).shape).toBe('not-found')
    expect(normalizeCensusKey('not a key at all').shape).toBe('not-found')
    expect(normalizeCensusKey('   ').shape).toBe('not-found')
  })

  it('compacts a spaced-out hex paste so its true length is visible', () => {
    const spaced = truncatedKey.split('').join(' ')
    const result = normalizeCensusKey(spaced)
    expect(result.shape).toBe('not-found')
    expect(result.key).toBe(truncatedKey)
    expect(result.key.length).toBe(39)
  })
})

describe('validateCensusKey', () => {
  it('maps a body-checked ok probe to valid and passes the extracted token', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, bodyValid: true }))
    await expect(validateCensusKey(`key: ${fakeKey}`, fetcher)).resolves.toBe('valid')
    expect(fetcher).toHaveBeenCalledWith(fakeKey)
  })

  it('returns malformed for a paste with no key, without calling the fetcher', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }))
    await expect(validateCensusKey(truncatedKey, fetcher)).resolves.toBe('malformed')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns rejected when the probe says no', async () => {
    const fetcher = vi.fn(async () => ({ ok: false }))
    await expect(validateCensusKey(fakeKey, fetcher)).resolves.toBe('rejected')
  })

  it('never trusts status alone: HTTP 200 with an error body is rejected', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, bodyValid: false }))
    await expect(validateCensusKey(fakeKey, fetcher)).resolves.toBe('rejected')
  })

  it('returns network when the fetcher throws or answers nonsense', async () => {
    const throwing = vi.fn(async (): Promise<{ ok: boolean }> => {
      throw new Error('offline')
    })
    await expect(validateCensusKey(fakeKey, throwing)).resolves.toBe('network')
    const nonsense = vi.fn(async () => ({}) as Promise<{ ok: boolean }>)
    await expect(validateCensusKey(fakeKey, nonsense)).resolves.toBe('network')
  })
})

describe('storage + event (stubbed localStorage)', () => {
  it('uses the v1 storage key and stores the extracted token, not the raw paste', () => {
    const store = installStorage()
    expect(CENSUS_KEY_STORAGE_KEY).toBe('civicscope.censusKey.v1')
    expect(setCensusKey(`Your key is ${fakeKey} — keep it safe`)).toBe(true)
    expect(store.get('civicscope.censusKey.v1')).toBe(fakeKey)
    expect(getCensusKey()).toBe(fakeKey)
    expect(hasCensusKey()).toBe(true)
    clearCensusKey()
    expect(store.has('civicscope.censusKey.v1')).toBe(false)
    expect(getCensusKey()).toBeNull()
    expect(hasCensusKey()).toBe(false)
  })

  it('refuses to store a malformed paste', () => {
    const store = installStorage()
    expect(setCensusKey(truncatedKey)).toBe(false)
    expect(store.size).toBe(0)
    expect(getCensusKey()).toBeNull()
  })

  it('dispatches the re-validation event on store and on clear', () => {
    installStorage()
    const events = recordEvents()
    setCensusKey(fakeKey)
    clearCensusKey()
    const censusEvents = events.filter((e) => e.type === CENSUS_KEY_EVENT)
    expect(CENSUS_KEY_EVENT).toBe('civicscope:census-key')
    expect(censusEvents).toHaveLength(2)
    expect(censusEvents[0]?.detail).toEqual({ present: true })
    expect(censusEvents[1]?.detail).toEqual({ present: false })
  })

  it('falls back to memory when localStorage is unavailable', () => {
    removeStorage()
    expect(setCensusKey(fakeKey)).toBe(true)
    expect(getCensusKey()).toBe(fakeKey)
    clearCensusKey()
    expect(getCensusKey()).toBeNull()
  })
})
