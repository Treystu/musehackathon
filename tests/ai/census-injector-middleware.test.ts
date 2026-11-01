import { describe, expect, it } from 'vitest'
import {
  handleCensusKeyInjection,
  type CensusInjectorEnv,
} from '../../functions/_middleware'

// Obviously fake deployment value; short and non-hex so no literal in
// this file resembles a real Census key.
const FAKE_KEY = 'fake-shared-key-for-tests'

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

/** Extract and JSON-parse the object the injected script assigns. */
function injectedPayload(html: string): { CENSUS_APP_KEY?: unknown } {
  const match = /__CIVICSCOPE_SHARED_APP_KEYS__=(\{.*\});<\/script>/.exec(html)
  if (!match) throw new Error('no injected payload found')
  return JSON.parse(match[1] ?? '') as { CENSUS_APP_KEY?: unknown }
}

describe('root middleware: shared Census key injection', () => {
  it('injects the slot immediately after the opening <head> tag when the key is set and the page is HTML', async () => {
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: FAKE_KEY }, htmlResponse()),
    )
    expect(result.status).toBe(200)
    const body = await result.text()
    const snippet = `<script>globalThis.__CIVICSCOPE_SHARED_APP_KEYS__={"CENSUS_APP_KEY":"${FAKE_KEY}"};</script>`
    // Position is the contract: after <head>, before everything in it,
    // so the slot exists before any app script can read it.
    expect(body).toBe(
      HTML.replace('<head>', `<head>${snippet}`),
    )
    expect(injectedPayload(body).CENSUS_APP_KEY).toBe(FAKE_KEY)
    // The body changed length, so the stale validators must be gone
    // for the runtime to recompute; unrelated headers survive.
    expect(result.headers.get('content-length')).toBeNull()
    expect(result.headers.get('etag')).toBeNull()
    expect(result.headers.get('content-type')).toContain('text/html')
  })

  it('anchors after a <head> tag that carries attributes', async () => {
    const attributed = HTML.replace('<head>', '<head lang="en" data-x="1">')
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: FAKE_KEY }, htmlResponse(attributed)),
    )
    const body = await result.text()
    expect(body.indexOf('<script>globalThis.__CIVICSCOPE_SHARED_APP_KEYS__')).toBe(
      attributed.indexOf('>', attributed.indexOf('<head')) + 1,
    )
    expect(injectedPayload(body).CENSUS_APP_KEY).toBe(FAKE_KEY)
  })

  it('trims a dashboard-pasted value before injecting it', async () => {
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: `  ${FAKE_KEY}\n` }, htmlResponse()),
    )
    expect(injectedPayload(await result.text()).CENSUS_APP_KEY).toBe(FAKE_KEY)
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

  it('escapes quotes and backslashes so the value cannot break out of the script string', async () => {
    const hostile = 'a"b\\c'
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: hostile }, htmlResponse()),
    )
    const body = await result.text()
    expect(body).toContain('\\"')
    expect(body).toContain('\\\\')
    expect(injectedPayload(body).CENSUS_APP_KEY).toBe(hostile)
  })

  it('escapes a value carrying a closing script tag so it cannot terminate the script early', async () => {
    const hostile = 'x</script><script>alert(1)</script>'
    const result = await handleCensusKeyInjection(
      context({ CENSUS_APP_KEY: hostile }, htmlResponse()),
    )
    const body = await result.text()
    // Exactly one literal closing tag in the whole document: the
    // injected script's own. The payload's copies are escaped.
    expect(body.split('</script>')).toHaveLength(2)
    expect(injectedPayload(body).CENSUS_APP_KEY).toBe(hostile)
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
