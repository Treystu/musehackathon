import { describe, expect, it } from 'vitest'
import {
  SHARED_KEYS_SCRIPT_PATH,
  handleCensusKeyInjection,
  type CensusInjectorEnv,
} from '../../functions/_middleware'

// Obviously fake deployment value; short and non-hex so no literal in
// this file resembles a real Census key.
const FAKE_KEY = 'fake-shared-key-for-tests'

const SCRIPT_TAG = `<script src="${SHARED_KEYS_SCRIPT_PATH}"></script>`

const HTML =
  '<!doctype html><html><head><title>CivicScope</title></head><body><div id="root"></div></body></html>'

function htmlResponse(
  body: string = HTML,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      etag: '"fixture-etag"',
      ...init.headers,
    },
  })
}

function context(
  env: CensusInjectorEnv,
  nextResponse: Response,
  url = 'https://app.test/',
): Parameters<typeof handleCensusKeyInjection>[0] {
  return {
    request: new Request(url),
    env,
    params: {},
    next: async () => nextResponse,
    waitUntil: () => {},
  }
}

function scriptContext(
  env: CensusInjectorEnv,
): Parameters<typeof handleCensusKeyInjection>[0] {
  return context(
    env,
    new Response('asset-store response that must not be served', {
      status: 404,
    }),
    `https://app.test${SHARED_KEYS_SCRIPT_PATH}`,
  )
}

/** Extract and JSON-parse the object the served script assigns. */
function scriptPayload(body: string): { CENSUS_APP_KEY?: unknown } {
  const match = /__CIVICSCOPE_SHARED_APP_KEYS__=(\{.*\});$/.exec(body)
  if (!match) throw new Error('no assignment found in script body')
  return JSON.parse(match[1] ?? '') as { CENSUS_APP_KEY?: unknown }
}

describe('root middleware: shared Census key injection', () => {
  it('injects the script tag immediately after the opening <head> tag when the key is set and the page is HTML', async () => {
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: FAKE_KEY }, htmlResponse()),
    )
    expect(result.status).toBe(200)
    const body = await result.text()
    // Position is the contract: after <head>, before everything in
    // it, so the slot script loads and runs before any app script
    // can read the slot.
    expect(body).toBe(HTML.replace('<head>', `<head>${SCRIPT_TAG}`))
    // The body changed length, so the stale validators must be gone
    // for the runtime to recompute; unrelated headers survive.
    expect(result.headers.get('content-length')).toBeNull()
    expect(result.headers.get('etag')).toBeNull()
    expect(result.headers.get('content-type')).toContain('text/html')
  })

  it('never places the key value or an inline assignment in the HTML (the CSP refuses inline scripts)', async () => {
    // Regression tripwire for the 2026-11-01 live finding: under
    // script-src 'self' an inline assignment is served but never
    // executed, so the app reads as keyless. The HTML may carry only
    // the external tag.
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: FAKE_KEY }, htmlResponse()),
    )
    const body = await result.text()
    expect(body).not.toContain(FAKE_KEY)
    expect(body).not.toContain('globalThis.__CIVICSCOPE_SHARED_APP_KEYS__')
    expect(body).toContain(SCRIPT_TAG)
  })

  it('anchors after a <head> tag that carries attributes', async () => {
    const attributed = HTML.replace('<head>', '<head lang="en" data-x="1">')
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: FAKE_KEY }, htmlResponse(attributed)),
    )
    const body = await result.text()
    expect(body.indexOf(SCRIPT_TAG)).toBe(
      attributed.indexOf('>', attributed.indexOf('<head')) + 1,
    )
  })

  it('falls back to before </head> when the opening tag cannot be matched', async () => {
    // `<head/>` defeats the opening-tag pattern (it requires whitespace
    // or an immediate '>'), so the fallback anchor is the one that fires.
    const noOpen = '<!doctype html><html><head/><title>x</title></head><body></body></html>'
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: FAKE_KEY }, htmlResponse(noOpen)),
    )
    const body = await result.text()
    expect(body).toBe(noOpen.replace('</head>', `${SCRIPT_TAG}</head>`))
  })

  it('passes the response through byte-identical when the key is unset', async () => {
    const original = htmlResponse()
    const result = await handleCensusKeyInjection(context({}, original))
    expect(result).toBe(original)
    expect(await result.text()).toBe(HTML)
  })

  it('passes through when the key is whitespace-only or not a string', async () => {
    const blank = htmlResponse()
    await expect(
      handleCensusKeyInjection(context({ CENSUS_APP_KEY: '   ' }, blank)),
    ).resolves.toBe(blank)
    const numeric = htmlResponse()
    await expect(
      handleCensusKeyInjection(context({ CENSUS_APP_KEY: 42 }, numeric)),
    ).resolves.toBe(numeric)
  })

  it('never touches /api/ responses, even with the key set and an HTML body', async () => {
    const original = htmlResponse()
    const result = await handleCensusKeyInjection(
      context(
        { CENSUS_APP_KEY: FAKE_KEY },
        original,
        'https://app.test/api/muse/intent',
      ),
    )
    expect(result).toBe(original)
    expect(await result.text()).toBe(HTML)
  })

  it('passes non-HTML responses through untouched', async () => {
    const original = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: FAKE_KEY }, original),
    )
    expect(result).toBe(original)
  })

  it('passes non-200 HTML through untouched', async () => {
    const original = htmlResponse(HTML, { status: 404 })
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: FAKE_KEY }, original),
    )
    expect(result).toBe(original)
  })

  it('falls back to the original response instead of throwing when the body cannot be read', async () => {
    const original = htmlResponse()
    Object.defineProperty(original, 'text', {
      value: async () => {
        throw new Error('read failed')
      },
    })
    await expect(
      handleCensusKeyInjection(
        context({ CENSUS_APP_KEY: FAKE_KEY }, original),
      ),
    ).resolves.toBe(original)
  })
})

describe('root middleware: shared-keys script route', () => {
  it('serves the slot assignment as a no-store JavaScript response when the key is set', async () => {
    const result = await handleCensusKeyInjection(
      scriptContext({ CENSUS_APP_KEY: FAKE_KEY }),
    )
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toContain('javascript')
    expect(result.headers.get('cache-control')).toBe('no-store')
    const body = await result.text()
    expect(body).toBe(
      `globalThis.__CIVICSCOPE_SHARED_APP_KEYS__={"CENSUS_APP_KEY":"${FAKE_KEY}"};`,
    )
    expect(scriptPayload(body).CENSUS_APP_KEY).toBe(FAKE_KEY)
  })

  it('trims a dashboard-pasted value before serving it', async () => {
    const result = await handleCensusKeyInjection(
      scriptContext({ CENSUS_APP_KEY: `  ${FAKE_KEY}\n` }),
    )
    expect(scriptPayload(await result.text()).CENSUS_APP_KEY).toBe(FAKE_KEY)
  })

  it('serves an empty slot when the key is unset, blank, or not a string', async () => {
    for (const env of [
      {},
      { CENSUS_APP_KEY: '   ' },
      { CENSUS_APP_KEY: 42 },
    ] as CensusInjectorEnv[]) {
      const result = await handleCensusKeyInjection(scriptContext(env))
      expect(result.status).toBe(200)
      const body = await result.text()
      expect(body).toBe('globalThis.__CIVICSCOPE_SHARED_APP_KEYS__={};')
      expect(scriptPayload(body).CENSUS_APP_KEY).toBeUndefined()
    }
  })

  it('escapes quotes and backslashes so the value cannot break out of the script string', async () => {
    const hostile = 'a"b\\c'
    const result = await handleCensusKeyInjection(
      scriptContext({ CENSUS_APP_KEY: hostile }),
    )
    const body = await result.text()
    expect(body).toContain('\\"')
    expect(body).toContain('\\\\')
    expect(scriptPayload(body).CENSUS_APP_KEY).toBe(hostile)
  })

  it('escapes a value carrying a closing script tag', async () => {
    const hostile = 'x</script><script>alert(1)</script>'
    const result = await handleCensusKeyInjection(
      scriptContext({ CENSUS_APP_KEY: hostile }),
    )
    const body = await result.text()
    expect(body).not.toContain('</script>')
    expect(body).toContain('\\u003c')
    expect(scriptPayload(body).CENSUS_APP_KEY).toBe(hostile)
  })
})
