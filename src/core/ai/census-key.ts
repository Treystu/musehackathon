/**
 * Census API key state — the pattern meta-key.ts mirrors (audit §Census
 * key), now present in this repo in its own right. The key is supplied by
 * the end user, stored only in their browser (localStorage, with an
 * in-memory fallback where localStorage is unavailable), and never
 * transmitted to any server we control or logged. Validation maps to the
 * same reason taxonomy as the Meta key: malformed / rejected / network,
 * plus valid.
 *
 * Signup cannot be automated: the Census signup form cannot be submitted
 * cross-origin from a browser and the key is delivered by email. The flow
 * is therefore as short as that constraint allows: one click to open the
 * form, one paste to finish.
 */

/** localStorage key for the visitor's own Census key. */
export const CENSUS_KEY_STORAGE_KEY = 'civicscope.censusKey.v1'

/** Dispatched on window/global whenever the stored key changes. */
export const CENSUS_KEY_EVENT = 'civicscope:census-key'

export const CENSUS_SIGNUP_URL = 'https://api.census.gov/data/key_signup.html'

export const CENSUS_ATTRIBUTION =
  'This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.'

/**
 * Census API keys are 40 hexadecimal characters.
 *
 * Keys are emailed, so what arrives in the paste box is frequently not a
 * bare key: it can carry the surrounding sentence, surrounding quotes, a
 * trailing newline, or a copy-paste artefact. Sending that string
 * verbatim to the API returns "Invalid Key" even though the key itself is
 * perfect, which is indistinguishable from a genuinely wrong key.
 * Extracting the token first makes the app tolerant of the realistic
 * cases while still rejecting a genuinely malformed paste.
 */
/**
 * A candidate is a maximal run of exactly 40 hex characters: delimited
 * on both sides by a non-hex character or the edge of the input. Word
 * boundaries (\b) are the wrong delimiter for this: the key sits on its
 * own line in the email, and a single-line paste field strips the
 * newlines (HTML value sanitization), gluing the token directly to the
 * neighbouring words ("...key is: <token>Thank you..."). Across that
 * seam \b sees word characters on both sides and finds no boundary,
 * while the hex run is still exactly the key. Two further rules keep
 * extraction honest: a run longer than 40 holds no delimited token
 * (any 40-char window inside one would be a guess), and two different
 * candidates in one paste are ambiguous — extraction fails rather
 * than picking one.
 */
function extractKeyToken(trimmed: string): string | null {
  const runs = trimmed.match(/[0-9a-fA-F]+/g)
  if (!runs) return null
  let candidate: string | null = null
  for (const run of runs) {
    if (run.length !== 40) continue
    if (candidate !== null && candidate !== run) return null
    candidate = run
  }
  return candidate
}

export type CensusKeyShape = 'ok' | 'not-found'

export function normalizeCensusKey(raw: string): { key: string; shape: CensusKeyShape } {
  if (typeof raw !== 'string') return { key: '', shape: 'not-found' }
  const trimmed = raw.trim()
  const token = extractKeyToken(trimmed)
  if (token) return { key: token, shape: 'ok' }

  // No 40-char token anywhere. If the input is plausibly a key that was
  // truncated or mistyped, compact it so callers can report its length
  // honestly rather than claiming the key was rejected.
  if (trimmed.length > 0 && /^[0-9a-fA-F\s]+$/.test(trimmed)) {
    return { key: trimmed.replace(/\s+/g, ''), shape: 'not-found' }
  }
  return { key: trimmed, shape: 'not-found' }
}

export type CensusKeyValidation = 'valid' | 'malformed' | 'rejected' | 'network'
export type CensusKeyValidationResult = CensusKeyValidation

/**
 * Injected probe for validation. Hermetic in tests; a live implementation
 * must inspect the parsed response body and set `ok` only when the body
 * has the expected shape — the Census API answers HTTP 200 with an HTML
 * error page for a missing, malformed, or invalid key, so the HTTP status
 * alone is never a usable signal.
 */
export interface CensusKeyProbeResult {
  ok: boolean
  /** Explicit parsed-body check; when present it must also pass. */
  bodyValid?: boolean
}

export type CensusKeyFetcher = (key: string) => Promise<CensusKeyProbeResult>

/**
 * Validate a key against the injected fetcher. No network happens here
 * unless the caller's fetcher performs one; tests inject a hermetic fake.
 * The fetcher's `ok` reflects its parsed-body check, not status alone.
 */
export async function validateCensusKey(
  raw: string,
  fetcher: CensusKeyFetcher,
): Promise<CensusKeyValidation> {
  const { key, shape } = normalizeCensusKey(raw)
  if (shape === 'not-found') return 'malformed'
  let result: CensusKeyProbeResult
  try {
    result = await fetcher(key)
  } catch {
    return 'network'
  }
  if (!result || typeof result.ok !== 'boolean') return 'network'
  if (result.bodyValid === false) return 'rejected'
  return result.ok ? 'valid' : 'rejected'
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): StorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage
    if (
      candidate &&
      typeof (candidate as StorageLike).getItem === 'function' &&
      typeof (candidate as StorageLike).setItem === 'function' &&
      typeof (candidate as StorageLike).removeItem === 'function'
    ) {
      return candidate as StorageLike
    }
  } catch {
    // Access itself can throw (e.g. blocked storage); fall back to memory.
  }
  return null
}

/** In-memory fallback used when localStorage is unavailable (e.g. node). */
let memoryKey: string | null = null

function emitCensusKeyChanged(present: boolean): void {
  try {
    const g = globalThis as {
      dispatchEvent?: unknown
      CustomEvent?: new (type: string, init?: { detail?: unknown }) => unknown
      Event?: new (type: string) => unknown
    }
    if (typeof g.dispatchEvent !== 'function') return
    let event: unknown
    if (typeof g.CustomEvent === 'function') {
      event = new g.CustomEvent(CENSUS_KEY_EVENT, { detail: { present } })
    } else if (typeof g.Event === 'function') {
      event = new g.Event(CENSUS_KEY_EVENT)
    } else {
      event = { type: CENSUS_KEY_EVENT, detail: { present } }
    }
    ;(g.dispatchEvent as (e: unknown) => boolean).call(globalThis, event)
  } catch {
    // Event delivery must never break key storage.
  }
}

/** Read the stored key (the extracted token), or null when absent/malformed. */
export function getCensusKey(): string | null {
  const storage = browserStorage()
  if (storage) {
    try {
      const stored = storage.getItem(CENSUS_KEY_STORAGE_KEY)
      if (!stored) return null
      const { key, shape } = normalizeCensusKey(stored)
      return shape === 'ok' ? key : null
    } catch {
      return memoryKey
    }
  }
  return memoryKey
}

/**
 * Store a key after extracting the token from the paste, so the saved
 * value is exactly what the API will receive. Returns false (and stores
 * nothing) when no plausible key is present. Dispatches CENSUS_KEY_EVENT
 * so listeners can re-validate. The key is never logged.
 */
export function setCensusKey(raw: string): boolean {
  const { key, shape } = normalizeCensusKey(raw)
  if (shape !== 'ok') return false
  memoryKey = key
  const storage = browserStorage()
  if (storage) {
    try {
      storage.setItem(CENSUS_KEY_STORAGE_KEY, key)
    } catch {
      // Quota/blocked storage: the in-memory copy above still applies.
    }
  }
  emitCensusKeyChanged(true)
  return true
}

/** Remove the stored key and dispatch CENSUS_KEY_EVENT. */
export function clearCensusKey(): void {
  memoryKey = null
  const storage = browserStorage()
  if (storage) {
    try {
      storage.removeItem(CENSUS_KEY_STORAGE_KEY)
    } catch {
      // Already cleared from memory; nothing else to do.
    }
  }
  emitCensusKeyChanged(false)
}

/** True when a plausible key is currently stored. */
export function hasCensusKey(): boolean {
  return getCensusKey() !== null
}
