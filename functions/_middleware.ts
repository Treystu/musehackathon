/**
 * Root Pages middleware — serve-time shared Census key injection.
 *
 * Why this exists: the shared Census app key contract
 * (docs/shared-app-key.md) says the deployment's CENSUS_APP_KEY Pages
 * variable reaches the client through the global slot
 * __CIVICSCOPE_SHARED_APP_KEYS__, filled at serve/build time. The
 * build-time half of that path exists (vite envPrefix in
 * src/core/censusKey.ts), but the portal build ships with no value
 * baked in, and until this middleware landed nothing filled the slot
 * at serve time either — so a deployment that set the Pages variable
 * (the portal does) still served a keyless app. This middleware is
 * the missing filler: it reads the variable from the Pages
 * environment per request, so rotating or removing the key is a
 * dashboard act with no rebuild.
 *
 * Why the slot arrives as an external script: the app's
 * Content-Security-Policy is script-src 'self' with no 'unsafe-inline'
 * (public/_headers — a deliberate product property: the policy is the
 * mechanically verifiable form of the no-third-party-scripts claim).
 * Browsers refuse to execute inline <script> elements under that
 * policy, so the original inline assignment was present in the served
 * HTML but never ran — the first portal deployment proved it (key in
 * the page, slot unset, app keyless, verified live 2026-11-01). The
 * middleware therefore serves the assignment itself as a same-origin
 * script at SHARED_KEYS_SCRIPT_PATH and injects only a
 * <script src="..."> tag into the HTML. Same-origin external scripts
 * are exactly what 'self' allows; the CSP does not change.
 *
 * Boundaries, deliberately:
 * - /api/ requests return next() untouched. The Muse proxy routes
 *   must stay byte-identical, and a Census key has no business riding
 *   an API response.
 * - The shared-keys script path is answered by this middleware and
 *   never reaches the asset store. Its response is no-store: the
 *   value must track the deployment variable, not a cache.
 * - Only a 200 text/html response is rewritten; anything else (JSON,
 *   assets, redirects, errors) passes through as the original object.
 * - The middleware never throws. A failure anywhere falls back to the
 *   unmodified response (or, for the script path, to next()): a
 *   missing shared key must degrade to the keyless baseline, never to
 *   a broken page.
 *
 * The value is a per-application credential the Census Bureau issues
 * to the app, designed to be presented by client software; the
 * contract doc covers why it may be client-visible. It is embedded
 * via JSON.stringify with '<' escaped, so no value the deployment
 * could contain can break out of the string in the script body.
 */
import { SHARED_APP_KEYS_GLOBAL } from '../src/core/config/shared-app-key'
import type { PagesContext } from '../src/server/muse-adapter'

/** Deployment environment this middleware reads. */
export interface CensusInjectorEnv {
  CENSUS_APP_KEY?: unknown
}

/** Same-origin path the slot assignment is served from. */
export const SHARED_KEYS_SCRIPT_PATH = '/shared-app-keys.js'

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i

/**
 * JSON-encode a string for embedding inside a script body. Plain
 * JSON.stringify escapes quotes and backslashes but not '<'; escaping
 * '<' as the six-character sequence backslash-u-0-0-3-c keeps the
 * string intact under any downstream HTML parsing while parsing back
 * to the exact same string.
 */
function embedJsonString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** The deployment's shared key, trimmed, or null when not usable. */
function sharedKeyValue(env: CensusInjectorEnv): string | null {
  const raw = env?.CENSUS_APP_KEY
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value ? value : null
}

function sharedKeysScriptBody(value: string | null): string {
  return value
    ? `globalThis.${SHARED_APP_KEYS_GLOBAL}={"CENSUS_APP_KEY":${embedJsonString(value)}};`
    : `globalThis.${SHARED_APP_KEYS_GLOBAL}={};`
}

function sharedKeysScriptResponse(env: CensusInjectorEnv): Response {
  return new Response(sharedKeysScriptBody(sharedKeyValue(env)), {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function injectionSnippet(): string {
  return `<script src="${SHARED_KEYS_SCRIPT_PATH}"></script>`
}

/**
 * Build the injected response, or null when this response is not one
 * the slot belongs in. Returns a NEW Response (the original body has
 * been consumed by the rewrite) with content-length and etag dropped
 * so the runtime recomputes both for the modified body.
 */
async function injectSharedKey(
  env: CensusInjectorEnv,
  response: Response,
): Promise<Response | null> {
  if (!sharedKeyValue(env)) return null
  if (response.status !== 200) return null
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('text/html')) return null

  const html = await response.text()
  const snippet = injectionSnippet()

  // Anchor: immediately after the opening <head...> tag, so the slot
  // is set before any app script can run. A parser-inserted external
  // script blocks parsing until it has loaded and executed, which is
  // the same ordering guarantee the inline form intended. The one
  // fallback is before </head> for a document whose opening tag
  // carries something the pattern cannot match; a document with
  // neither is left alone.
  const headOpen = HEAD_OPEN.exec(html)
  let out: string
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    out = html.slice(0, at) + snippet + html.slice(at)
  } else {
    const closeAt = html.toLowerCase().indexOf('</head>')
    if (closeAt === -1) return null
    out = html.slice(0, closeAt) + snippet + html.slice(closeAt)
  }

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('etag')
  return new Response(out, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function handleCensusKeyInjection(
  context: PagesContext<CensusInjectorEnv>,
): Promise<Response> {
  const { pathname } = new URL(context.request.url)
  if (pathname.startsWith('/api/')) return context.next()
  if (pathname === SHARED_KEYS_SCRIPT_PATH) {
    try {
      return sharedKeysScriptResponse(context.env)
    } catch {
      return context.next()
    }
  }

  const response = await context.next()
  try {
    return (await injectSharedKey(context.env, response)) ?? response
  } catch {
    return response
  }
}

export const onRequest = handleCensusKeyInjection
