import { afterEach, describe, expect, it } from 'vitest'
import {
  CENSUS_APP_KEY_ENV_VAR,
  SHARED_APP_KEYS_GLOBAL,
  normalizeSharedAppKeyValue,
  readSharedCensusAppKey,
  resolveCensusKey,
  resolveCensusKeyForApp,
} from '../../src/core/config/shared-app-key'

// Clearly-fake placeholders, assembled from short segments (<16 chars
// each) so no segment resembles a real credential.
const visitorKey = ['test', 'visitor', 'key', '0001'].join('-')
const sharedKey = ['test', 'shared', 'key', '0002'].join('-')

type GlobalStub = Record<string, unknown>
const g = globalThis as GlobalStub

afterEach(() => {
  delete g[SHARED_APP_KEYS_GLOBAL]
})

describe('shared app key declaration', () => {
  it('names the deployment environment variable', () => {
    expect(CENSUS_APP_KEY_ENV_VAR).toBe('CENSUS_APP_KEY')
  })
})

describe('resolveCensusKey precedence', () => {
  it('visitor key wins over the shared app key', () => {
    expect(resolveCensusKey({ visitorKey, sharedAppKey: sharedKey })).toEqual({
      key: visitorKey,
      source: 'visitor',
    })
  })

  it('visitor key alone resolves as visitor', () => {
    expect(resolveCensusKey({ visitorKey })).toEqual({ key: visitorKey, source: 'visitor' })
  })

  it('shared app key alone resolves as shared', () => {
    expect(resolveCensusKey({ sharedAppKey: sharedKey })).toEqual({
      key: sharedKey,
      source: 'shared',
    })
  })

  it('no key anywhere resolves as none', () => {
    expect(resolveCensusKey({})).toEqual({ key: null, source: 'none' })
    expect(resolveCensusKey({ visitorKey: null, sharedAppKey: null })).toEqual({
      key: null,
      source: 'none',
    })
  })

  it('an empty or whitespace visitor key falls through to the shared key', () => {
    expect(resolveCensusKey({ visitorKey: '', sharedAppKey: sharedKey }).source).toBe('shared')
    expect(resolveCensusKey({ visitorKey: '   ', sharedAppKey: sharedKey }).source).toBe('shared')
  })
})

describe('absent shared value reproduces baseline behaviour', () => {
  it('empty and whitespace-only env values are absent', () => {
    expect(readSharedCensusAppKey({ CENSUS_APP_KEY: '' })).toBeNull()
    expect(readSharedCensusAppKey({ CENSUS_APP_KEY: '   ' })).toBeNull()
    expect(readSharedCensusAppKey({})).toBeNull()
    expect(resolveCensusKeyForApp({ visitorKey: null, env: { CENSUS_APP_KEY: '  ' } })).toEqual({
      key: null,
      source: 'none',
    })
  })

  it('with no deployment value and no visitor key the resolution is none', () => {
    expect(readSharedCensusAppKey({})).toBeNull()
    expect(resolveCensusKeyForApp({ env: {} })).toEqual({ key: null, source: 'none' })
  })
})

describe('normalizeSharedAppKeyValue edge cases', () => {
  it('trims surrounding whitespace from a clean value', () => {
    expect(normalizeSharedAppKeyValue(`  ${sharedKey}  `)).toBe(sharedKey)
  })

  it('treats a value with interior whitespace as absent', () => {
    expect(normalizeSharedAppKeyValue('test shared key')).toBeNull()
    expect(normalizeSharedAppKeyValue('test\tshared')).toBeNull()
  })

  it('treats non-string values as absent', () => {
    expect(normalizeSharedAppKeyValue(undefined)).toBeNull()
    expect(normalizeSharedAppKeyValue(null)).toBeNull()
    expect(normalizeSharedAppKeyValue(42)).toBeNull()
    expect(normalizeSharedAppKeyValue(true)).toBeNull()
    expect(normalizeSharedAppKeyValue({})).toBeNull()
  })
})

describe('readSharedCensusAppKey', () => {
  it('reads an injected env', () => {
    expect(readSharedCensusAppKey({ CENSUS_APP_KEY: sharedKey })).toBe(sharedKey)
  })

  it('reads the global deployment slot when no env is passed', () => {
    g[SHARED_APP_KEYS_GLOBAL] = { CENSUS_APP_KEY: sharedKey }
    expect(readSharedCensusAppKey()).toBe(sharedKey)
  })

  it('a malformed global slot reads as absent', () => {
    g[SHARED_APP_KEYS_GLOBAL] = 'not-an-object'
    expect(readSharedCensusAppKey()).toBeNull()
    g[SHARED_APP_KEYS_GLOBAL] = { CENSUS_APP_KEY: '   ' }
    expect(readSharedCensusAppKey()).toBeNull()
  })
})

describe('resolveCensusKeyForApp', () => {
  it('combines the deployment read with visitor precedence', () => {
    const env = { CENSUS_APP_KEY: sharedKey }
    expect(resolveCensusKeyForApp({ env })).toEqual({ key: sharedKey, source: 'shared' })
    expect(resolveCensusKeyForApp({ visitorKey, env })).toEqual({
      key: visitorKey,
      source: 'visitor',
    })
  })

  it('consults the global slot by default', () => {
    g[SHARED_APP_KEYS_GLOBAL] = { CENSUS_APP_KEY: sharedKey }
    expect(resolveCensusKeyForApp({})).toEqual({ key: sharedKey, source: 'shared' })
    expect(resolveCensusKeyForApp({ visitorKey })).toEqual({ key: visitorKey, source: 'visitor' })
  })
})
