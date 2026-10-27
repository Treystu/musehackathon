import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  META_KEY_EVENT,
  META_KEY_STORAGE_KEY,
  buildByoHeaders,
  clearMetaKey,
  getMetaKey,
  normalizeMetaKey,
  setMetaKey,
  validateMetaKey,
} from '../../src/core/ai/meta-key'

// Clearly-fake placeholder, assembled from short segments (<16 chars each)
// so no segment resembles a real credential.
const fakeKey = ['test', 'key', 'abcd', '1234'].join('-')
const shortKey = ['test', 'key', 'ab'].join('-')

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

beforeEach(() => {
  removeStorage()
  delete g.dispatchEvent
  clearMetaKey()
})

afterEach(() => {
  clearMetaKey()
  removeStorage()
  if (originalStorage === undefined) delete g.localStorage
  else g.localStorage = originalStorage
  if (originalDispatch === undefined) delete g.dispatchEvent
  else g.dispatchEvent = originalDispatch
  vi.restoreAllMocks()
})

describe('normalizeMetaKey', () => {
  it('extracts the token from a messy paste', () => {
    expect(normalizeMetaKey(`  \n  "${fakeKey}"  \n`)).toBe(fakeKey)
    expect(normalizeMetaKey(`Bearer  ${fakeKey}`)).toBe(fakeKey)
    expect(normalizeMetaKey('  test-key- abcd- 1234 ')).toBe(fakeKey)
    expect(normalizeMetaKey('test-key-\nabcd-\t1234')).toBe(fakeKey)
  })

  it('returns null for malformed input', () => {
    expect(normalizeMetaKey(shortKey)).toBeNull()
    expect(normalizeMetaKey('   ')).toBeNull()
    expect(normalizeMetaKey('not a key !!')).toBeNull()
  })
})

describe('validateMetaKey', () => {
  it('maps a body-checked ok probe to valid', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, bodyValid: true }))
    await expect(validateMetaKey(`  ${fakeKey} `, fetcher)).resolves.toBe('valid')
    expect(fetcher).toHaveBeenCalledWith(fakeKey)
  })

  it('accepts a fetcher whose ok already reflects its body check', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }))
    await expect(validateMetaKey(fakeKey, fetcher)).resolves.toBe('valid')
  })

  it('returns malformed for a short key without calling the fetcher', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }))
    await expect(validateMetaKey(shortKey, fetcher)).resolves.toBe('malformed')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns rejected when the probe says no', async () => {
    const fetcher = vi.fn(async () => ({ ok: false }))
    await expect(validateMetaKey(fakeKey, fetcher)).resolves.toBe('rejected')
  })

  it('never trusts status alone: ok with a failing body check is rejected', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, bodyValid: false }))
    await expect(validateMetaKey(fakeKey, fetcher)).resolves.toBe('rejected')
  })

  it('returns network when the fetcher throws', async () => {
    const fetcher = vi.fn(async (): Promise<{ ok: boolean }> => {
      throw new Error('offline')
    })
    await expect(validateMetaKey(fakeKey, fetcher)).resolves.toBe('network')
  })
})

describe('storage + event (stubbed localStorage)', () => {
  it('uses the v1 storage key and round-trips set/get/clear', () => {
    const store = installStorage()
    expect(META_KEY_STORAGE_KEY).toBe('civicscope.metaKey.v1')
    expect(setMetaKey(`  ${fakeKey} `)).toBe(true)
    expect(store.get('civicscope.metaKey.v1')).toBe(fakeKey)
    expect(getMetaKey()).toBe(fakeKey)
    clearMetaKey()
    expect(store.has('civicscope.metaKey.v1')).toBe(false)
    expect(getMetaKey()).toBeNull()
  })

  it('refuses to store a malformed key', () => {
    const store = installStorage()
    expect(setMetaKey(shortKey)).toBe(false)
    expect(store.size).toBe(0)
    expect(getMetaKey()).toBeNull()
  })

  it('dispatches the changed event on set and clear', () => {
    installStorage()
    const seen: string[] = []
    g.dispatchEvent = (event: { type: string }) => {
      seen.push(event.type)
      return true
    }
    setMetaKey(fakeKey)
    clearMetaKey()
    expect(META_KEY_EVENT).toBe('civicscope:meta-key-changed')
    expect(seen).toEqual([META_KEY_EVENT, META_KEY_EVENT])
  })
})

describe('in-memory fallback (no localStorage)', () => {
  it('round-trips set/get/clear without localStorage', () => {
    removeStorage()
    expect(setMetaKey(fakeKey)).toBe(true)
    expect(getMetaKey()).toBe(fakeKey)
    clearMetaKey()
    expect(getMetaKey()).toBeNull()
  })
})

describe('buildByoHeaders', () => {
  it('builds the Authorization header without logging the key', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(buildByoHeaders(` ${fakeKey} `)).toEqual({
      Authorization: `Bearer ${fakeKey}`,
    })
    expect(buildByoHeaders(shortKey)).toEqual({})
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
