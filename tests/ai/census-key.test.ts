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
// A second, distinct 40-hex token, for the ambiguous-paste cases.
const otherKey = ['fedcba9876543210', 'fedcba9876543210', 'fedcba98'].join('')

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

  it('extracts the token from a whole-message paste with newlines intact', () => {
    const original = `Your Census API key is: ${fakeKey}\nThank you for signing up.`
    expect(normalizeCensusKey(original)).toEqual({ key: fakeKey, shape: 'ok' })
    const blankLine = `Your Census API key is: ${fakeKey}\n\nThank you for signing up.`
    expect(normalizeCensusKey(blankLine)).toEqual({ key: fakeKey, shape: 'ok' })
  })

  it('extracts the token when stripped newlines glue it to the neighbouring words', () => {
    // What a single-line paste field actually delivers for the pastes
    // above: HTML value sanitization removes the newlines, gluing the
    // token directly to the following word character (and, in the
    // second shape, to the preceding one too).
    const gluedAfter = `Your Census API key is: ${fakeKey}Thank you for signing up.`
    expect(normalizeCensusKey(gluedAfter)).toEqual({ key: fakeKey, shape: 'ok' })
    const gluedBefore = `Here is your key:${fakeKey}Thank you for signing up.`
    expect(normalizeCensusKey(gluedBefore)).toEqual({ key: fakeKey, shape: 'ok' })
  })

  it('extracts a glued token at the very start or end of the paste', () => {
    expect(normalizeCensusKey(`${fakeKey}Thank you for signing up.`)).toEqual({
      key: fakeKey,
      shape: 'ok',
    })
    expect(normalizeCensusKey(`Your Census API key is:${fakeKey}`)).toEqual({
      key: fakeKey,
      shape: 'ok',
    })
  })

  it('fails loudly when a paste carries two different tokens, never guessing', () => {
    const paste = `Old key ${fakeKey} was replaced by ${otherKey}`
    expect(normalizeCensusKey(paste).shape).toBe('not-found')
  })

  it('accepts the same token repeated in one paste (not ambiguity)', () => {
    const paste = `Key: ${fakeKey}\nAgain, your key is ${fakeKey}`
    expect(normalizeCensusKey(paste)).toEqual({ key: fakeKey, shape: 'ok' })
  })

  it('never returns a 40-char window out of a longer hex run', () => {
    // 41 hex chars: any 40-char window inside would be a guess.
    expect(normalizeCensusKey(`${fakeKey}a`).shape).toBe('not-found')
    const longRun = `${fakeKey}${otherKey.slice(0, 24)}`
    expect(normalizeCensusKey(longRun).shape).toBe('not-found')
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

  it('returns malformed for an ambiguous paste, without calling the fetcher', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, bodyValid: true }))
    const paste = `Old key ${fakeKey} was replaced by ${otherKey}`
    await expect(validateCensusKey(paste, fetcher)).resolves.toBe('malformed')
    expect(fetcher).not.toHaveBeenCalled()
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

  it('stores the token from a newline-stripped whole-message paste (the mounted-form shape)', () => {
    const store = installStorage()
    const events = recordEvents()
    // The whole-message paste after a single-line field strips its
    // newlines: the token arrives glued to the following word.
    const sanitized = `Your Census API key is: ${fakeKey}Thank you for signing up.`
    expect(setCensusKey(sanitized)).toBe(true)
    expect(store.get('civicscope.censusKey.v1')).toBe(fakeKey)
    expect(getCensusKey()).toBe(fakeKey)
    const censusEvents = events.filter((e) => e.type === CENSUS_KEY_EVENT)
    expect(censusEvents).toHaveLength(1)
    expect(censusEvents[0]?.detail).toEqual({ present: true })
  })

  it('refuses to store an ambiguous paste carrying two different tokens', () => {
    const store = installStorage()
    expect(setCensusKey(`Old key ${fakeKey} was replaced by ${otherKey}`)).toBe(false)
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
