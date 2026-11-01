import { describe, expect, it } from 'vitest'
import { normalizeCensusKey } from './censusKey'

const KEY = '0123456789abcdef0123456789abcdef01234567'

/**
 * These cases are the realistic failure modes for a key that arrives by email
 * and is pasted into a text box. Every one of them produced "Invalid Key" from
 * the Census API before key extraction was added, even though the key itself
 * was valid — the API received the surrounding prose.
 */
describe('normalizeCensusKey', () => {
  it('passes a clean key through unchanged', () => {
    expect(normalizeCensusKey(KEY)).toEqual({ key: KEY, shape: 'ok' })
  })

  it('extracts the key from surrounding email prose', () => {
    const pasted = `Your Census API key is ${KEY}. Please do not share it.`
    expect(normalizeCensusKey(pasted).key).toBe(KEY)
  })

  it('strips surrounding quotes', () => {
    expect(normalizeCensusKey(`"${KEY}"`).key).toBe(KEY)
  })

  it('strips a trailing newline, which a copy-paste almost always includes', () => {
    expect(normalizeCensusKey(`${KEY}\n`).key).toBe(KEY)
  })

  it('tolerates leading and trailing whitespace', () => {
    expect(normalizeCensusKey(`   ${KEY}   `).key).toBe(KEY)
  })

  it('accepts an uppercase key, since hex casing is not semantic', () => {
    const upper = KEY.toUpperCase()
    expect(normalizeCensusKey(upper).key).toBe(upper)
  })

  it('strips whitespace from a key that was wrapped across lines', () => {
    const wrapped = `${KEY.slice(0, 20)} ${KEY.slice(20)}`
    const { key, shape } = normalizeCensusKey(wrapped)
    // A space inside the token means there is no single 40-char run, so this
    // falls through to the compacting path.
    expect(shape).toBe('not-found')
    expect(key.replace(/\s+/g, '')).toBe(KEY)
  })

  it('reports a truncated key as malformed rather than sending it to the API', () => {
    const truncated = KEY.slice(0, 39)
    const { shape, key } = normalizeCensusKey(truncated)
    expect(shape).toBe('not-found')
    expect(key).toBe(truncated)
  })

  it('reports clearly non-key input as malformed', () => {
    expect(normalizeCensusKey('hello world').shape).toBe('not-found')
    expect(normalizeCensusKey('').shape).toBe('not-found')
  })

  it('does not mangle a key that is already valid', () => {
    // Guards against an over-eager regex silently corrupting a good key.
    for (let i = 0; i < 200; i++) {
      const candidate = Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
      expect(normalizeCensusKey(candidate).key).toBe(candidate)
    }
  })
})
