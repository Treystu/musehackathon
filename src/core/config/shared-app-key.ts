/**
 * Shared application key — the deployment-supplied Census key.
 *
 * Owner decision (2026-10-31): this repo is the canonical home of the
 * shared application key declaration. CivicScope mirrors this module's
 * shape and the contract in docs/shared-app-key.md, so one deployment
 * value federates into the product unchanged.
 *
 * What this key is — and is not. A Census application key is a
 * per-APPLICATION credential: the Census Bureau issues it to an
 * application, not to a person, so the Census API can attribute and
 * rate-limit that application's traffic. It identifies the app. It
 * carries no user data, unlocks no non-public data (every figure it
 * fetches is published), and is designed to be presented by client
 * software. That is why it may be client-visible here.
 *
 * Contrast with the other two keys in this system:
 * - A visitor's personal Census key is THEIR credential. It stays in
 *   their browser and, when present, always takes precedence.
 * - The shared Meta key is a SPENDING credential. It never ships to a
 *   client; it lives only in the server-side proxy secret. It is out
 *   of scope for this module and must never be declared here.
 *
 * Supply path: the deployment sets the Pages environment variable
 * named by CENSUS_APP_KEY_ENV_VAR; at serve/build time the host page
 * exposes that value to the client in the SHARED_APP_KEYS_GLOBAL slot;
 * this module is the only reader. The value itself never appears in
 * source, commits, issues, or chat.
 *
 * Precedence (highest first): visitor key > shared app key > none.
 * "None" reproduces the pre-existing behaviour exactly — keyless
 * surfaces work and Census-key plugins report their needs-key state —
 * so this module changes nothing until a deployment supplies a value.
 */

/** Pages environment variable that carries the shared Census app key. */
export const CENSUS_APP_KEY_ENV_VAR = 'CENSUS_APP_KEY'

/**
 * Global slot the host page fills from the deployment environment at
 * serve/build time: `{ CENSUS_APP_KEY: <value> }`. The single client-
 * visible home of the value; see docs/shared-app-key.md.
 */
export const SHARED_APP_KEYS_GLOBAL = '__CIVICSCOPE_SHARED_APP_KEYS__'

/** Deployment environment shape this module reads. */
export interface SharedAppKeyEnv {
  CENSUS_APP_KEY?: unknown
}

/** Where the resolved Census key came from. */
export type CensusKeySource = 'visitor' | 'shared' | 'none'

/** A resolved Census key plus its provenance. */
export interface ResolvedCensusKey {
  key: string | null
  source: CensusKeySource
}

/**
 * Normalize a deployment-supplied shared-key value. Only a clean token
 * survives: a non-string, an empty or whitespace-only string, or a
 * value with interior whitespace (a malformed deployment value) all
 * normalize to null — absent — rather than being sent to the Census
 * API as garbage.
 */
export function normalizeSharedAppKeyValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/\s/.test(trimmed)) return null
  return trimmed
}

function deploymentEnv(): SharedAppKeyEnv | null {
  try {
    const slot = (globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL]
    if (slot && typeof slot === 'object') return slot as SharedAppKeyEnv
  } catch {
    // A hostile or broken global must read as "no deployment value".
  }
  return null
}

/**
 * Read the shared Census app key from the deployment environment.
 * Pass `env` explicitly in tests and server-side callers; with no
 * argument it reads the client-visible global slot. Returns null when
 * the deployment supplies no usable value.
 */
export function readSharedCensusAppKey(env?: SharedAppKeyEnv): string | null {
  const source = env ?? deploymentEnv()
  if (!source) return null
  return normalizeSharedAppKeyValue(source.CENSUS_APP_KEY)
}

/**
 * Resolve which Census key the app should use. The visitor key input
 * is the host app's own stored personal key, already normalized by
 * that app's key module; this resolver applies the same absent rules
 * to both inputs so an empty string never wins by accident.
 *
 * Precedence: visitor > shared > none.
 */
export function resolveCensusKey(input: {
  visitorKey?: string | null
  sharedAppKey?: string | null
}): ResolvedCensusKey {
  const visitor = typeof input.visitorKey === 'string' ? input.visitorKey.trim() : ''
  if (visitor) return { key: visitor, source: 'visitor' }
  const shared = normalizeSharedAppKeyValue(input.sharedAppKey)
  if (shared) return { key: shared, source: 'shared' }
  return { key: null, source: 'none' }
}

/**
 * The resolution point a Census-key consumer consults: resolve the
 * visitor's personal key against the deployment's shared app key in
 * one call. `env` is injectable for tests; omit it in the browser.
 */
export function resolveCensusKeyForApp(input: {
  visitorKey?: string | null
  env?: SharedAppKeyEnv
}): ResolvedCensusKey {
  return resolveCensusKey({
    visitorKey: input.visitorKey,
    sharedAppKey: readSharedCensusAppKey(input.env),
  })
}
