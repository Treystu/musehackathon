/**
 * URL-state intent serialization: a validated intent rides in the query
 * string as one additive parameter, so a view built from a natural-
 * language ask is shareable and restorable (the civicscope audit's
 * "additive param, not built in this slice" — built here).
 *
 * Parsing is schema-checked through the same validateIntent the Ask
 * path uses, and the restored intent is re-stamped by withRunnability,
 * the single owner of the clarification flag. An invalid parameter is
 * ignored (null), never executed blindly: a restored intent still
 * passes through the normal clarification and run gates before
 * anything executes.
 */
import { validateIntent, withRunnability } from './intent-schema'
import type { ValidatedIntent } from './provider'

export const INTENT_URL_PARAM = 'intent'

/** Refuse absurd inputs before spending any decode/parse work. */
const MAX_PARAM_CHARS = 4096

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** Serialize a validated intent into the parameter value (base64url). */
export function serializeIntentParam(intent: ValidatedIntent): string {
  return toBase64Url(JSON.stringify(intent))
}

/**
 * Return the query string with the intent parameter set, preserving
 * every other parameter already present (additive, not a rewrite).
 */
export function withIntentParam(
  search: string,
  intent: ValidatedIntent,
): string {
  const params = new URLSearchParams(search)
  params.set(INTENT_URL_PARAM, serializeIntentParam(intent))
  return params.toString()
}

/**
 * Restore the intent from a query string. Returns null when the
 * parameter is absent, malformed, or fails schema validation.
 */
export function intentFromSearch(
  search: string | URLSearchParams,
): ValidatedIntent | null {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search
  const raw = params.get(INTENT_URL_PARAM)
  if (!raw || raw.length > MAX_PARAM_CHARS) return null
  const text = fromBase64Url(raw)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const check = validateIntent(parsed)
  if (!check.ok) return null
  return withRunnability(check.intent)
}
