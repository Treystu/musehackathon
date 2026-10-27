/**
 * BYO Meta key state — mirrors the Census-key pattern (audit §Census key):
 * the key lives only in the browser (localStorage, with an in-memory
 * fallback where localStorage is unavailable), is never logged, and the
 * headers built here must only be sent to the Meta origin by the caller.
 * Validation maps to the same reason taxonomy: malformed / rejected /
 * network, plus valid.
 */

/** localStorage key for the visitor's own Meta key. */
export const META_KEY_STORAGE_KEY = 'civicscope.metaKey.v1'

/** Dispatched on window/global whenever the stored key changes. */
export const META_KEY_EVENT = 'civicscope:meta-key-changed'

/** Minimum length of a plausible key token. */
export const META_KEY_MIN_LENGTH = 16

/** Plausible key shape: alphanumeric / dash / underscore, 16+ chars. */
const KEY_TOKEN_RE = /[A-Za-z0-9_-]{16,}/g

export type MetaKeyValidation = 'valid' | 'malformed' | 'rejected' | 'network'
export type MetaKeyValidationResult = MetaKeyValidation

/**
 * Injected probe for validation. Hermetic in tests; a live implementation
 * must inspect the parsed response body and set `ok` only when the body
 * has the expected shape — never from the HTTP status alone (a provider
 * can return HTTP 200 with an error body).
 */
export interface MetaKeyProbeResult {
  ok: boolean
  /** Explicit parsed-body check; when present it must also pass. */
  bodyValid?: boolean
}

export type MetaKeyFetcher = (key: string) => Promise<MetaKeyProbeResult>

/**
 * Normalize a pasted key: trim, tolerate surrounding quotes / a `Bearer`
 * prefix / an `Authorization:`-style label, strip interior whitespace
 * (a paste may wrap or space the key out), then extract the first
 * plausible key token. Returns null when nothing plausible is present.
 */
export function normalizeMetaKey(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!trimmed) return null
  const direct = trimmed.match(KEY_TOKEN_RE)
  if (direct?.[0]) return direct[0]
  const withoutBearer = trimmed.replace(/^bearer\s+/i, '')
  const compact = withoutBearer.replace(/\s+/g, '')
  const extracted = compact.match(KEY_TOKEN_RE)
  return extracted?.[0] ?? null
}

function isPlausibleKey(key: string | null): key is string {
  return key !== null && key.length >= META_KEY_MIN_LENGTH
}

/**
 * Validate a key against the injected fetcher. No network happens here
 * unless the caller's fetcher performs one; tests inject a hermetic fake.
 * The fetcher's `ok` reflects its parsed-body check, not status alone.
 */
export async function validateMetaKey(
  key: string,
  fetcher: MetaKeyFetcher,
): Promise<MetaKeyValidation> {
  const normalized = normalizeMetaKey(key)
  if (!isPlausibleKey(normalized)) return 'malformed'
  let result: MetaKeyProbeResult
  try {
    result = await fetcher(normalized)
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

function emitMetaKeyChanged(present: boolean): void {
  try {
    const g = globalThis as {
      dispatchEvent?: unknown
      CustomEvent?: new (type: string, init?: { detail?: unknown }) => unknown
      Event?: new (type: string) => unknown
    }
    if (typeof g.dispatchEvent !== 'function') return
    let event: unknown
    if (typeof g.CustomEvent === 'function') {
      event = new g.CustomEvent(META_KEY_EVENT, { detail: { present } })
    } else if (typeof g.Event === 'function') {
      event = new g.Event(META_KEY_EVENT)
    } else {
      event = { type: META_KEY_EVENT, detail: { present } }
    }
    ;(g.dispatchEvent as (e: unknown) => boolean).call(globalThis, event)
  } catch {
    // Event delivery must never break key storage.
  }
}

/** Read the stored key (normalized), or null when absent/malformed. */
export function getMetaKey(): string | null {
  const storage = browserStorage()
  if (storage) {
    try {
      const stored = storage.getItem(META_KEY_STORAGE_KEY)
      return stored ? normalizeMetaKey(stored) : null
    } catch {
      return memoryKey
    }
  }
  return memoryKey
}

/**
 * Store a key after normalization. Returns false (and stores nothing)
 * for malformed input. Dispatches META_KEY_EVENT so listeners can
 * re-validate. The key is never logged.
 */
export function setMetaKey(raw: string): boolean {
  const normalized = normalizeMetaKey(raw)
  if (!isPlausibleKey(normalized)) return false
  memoryKey = normalized
  const storage = browserStorage()
  if (storage) {
    try {
      storage.setItem(META_KEY_STORAGE_KEY, normalized)
    } catch {
      // Quota/blocked storage: the in-memory copy above still applies.
    }
  }
  emitMetaKeyChanged(true)
  return true
}

/** Remove the stored key and dispatch META_KEY_EVENT. */
export function clearMetaKey(): void {
  memoryKey = null
  const storage = browserStorage()
  if (storage) {
    try {
      storage.removeItem(META_KEY_STORAGE_KEY)
    } catch {
      // Already cleared from memory; nothing else to do.
    }
  }
  emitMetaKeyChanged(false)
}

/** True when a plausible key is currently stored. */
export function hasMetaKey(): boolean {
  return getMetaKey() !== null
}

/**
 * Headers for a BYO-direct call to the Meta origin. Returns an empty
 * object for a malformed key so a bad key is never sent. Never logs.
 * Callers must attach these headers only to Meta-origin requests.
 */
export function buildByoHeaders(key: string): Record<string, string> {
  const normalized = normalizeMetaKey(key)
  if (!isPlausibleKey(normalized)) return {}
  return { Authorization: `Bearer ${normalized}` }
}
