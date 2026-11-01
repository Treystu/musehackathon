import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registry } from './core/plugin-catalog'

const root = join(dirname(fileURLToPath(import.meta.url)), '.')
const headers = readFileSync(join(root, '..', 'public', '_headers'), 'utf8')

function csp(): string {
  const line = headers
    .split('\n')
    .find((l) => l.includes('Content-Security-Policy:'))
  if (!line) throw new Error('No Content-Security-Policy in _headers')
  return line.split('Content-Security-Policy:')[1]!.trim()
}

describe('deployment security headers', () => {
  it('sets a Content-Security-Policy', () => {
    expect(csp()).toContain("default-src 'self'")
  })

  it('forbids inline and eval scripts', () => {
    const policy = csp()
    const scriptSrc = policy.split(';').find((d) => d.trim().startsWith('script-src'))!
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(scriptSrc).not.toContain('unsafe-eval')
  })

  it('locks the document against framing', () => {
    expect(csp()).toContain("frame-ancestors 'none'")
    expect(headers).toContain('X-Frame-Options: DENY')
  })

  it('enables HSTS and disables unused browser capabilities', () => {
    expect(headers).toContain('Strict-Transport-Security')
    const perms = headers.split('\n').find((l) => l.includes('Permissions-Policy:'))!
    expect(perms).toContain('camera=()')
    // Union change (Panel B1): microphone is (self), not disabled — the
    // Item 12 mic implementation ships in this tree, and the Entire
    // tree's decision was that the Permissions-Policy flip lands in the
    // same change as the mic, never earlier and never without it.
    expect(perms).toContain('microphone=(self)')
  })

  it('caches hashed assets immutably but not the HTML shell', () => {
    // Match only real header block openers, not the `/*` inside a comment.
    const blocks = headers.split(/\n(?=\S)/).filter((b) => b.startsWith('/'))
    const assets = blocks.find((b) => b.startsWith('/assets/*'))
    expect(assets).toMatch(/immutable/)

    // A bare `/*` block would apply immutable caching to index.html, which
    // would pin users to a stale shell after a deploy.
    const catchAll = blocks.find((b) => b.trim() === '/*')
    expect(catchAll ?? '').not.toMatch(/immutable/)
  })
})

/**
 * The connect-src allowlist is a public claim about who this app talks to. If a
 * module starts calling a new origin and the allowlist is not updated, the
 * request is blocked in production and nobody notices in development.
 *
 * The previous version of this test named ten files by hand. That list was the
 * defect: `src/core/ai/meta-client.ts` was added later, was not on it, and the
 * deployed policy blocked `https://api.meta.ai` for every visitor using their
 * own Meta key. An enumerated list silently missing a file cannot be fixed by
 * adding a line, because the next file is missed the same way.
 *
 * So the scan is by capability, not by name. Every non-test module under src/
 * that contains a network-call token is read; every quoted absolute URL in it
 * is an origin this app can call. Test tiers (src/e2e, src/live, *.test.*) are
 * excluded because they are not shipped and legitimately name fake origins.
 */
const NETWORK_CALL = /\b(fetch|WebSocket|EventSource|sendBeacon)\s*\(/
const QUOTED_ABSOLUTE_URL = /['"`](https:\/\/[^'"`\s]+)['"`]/g

function networkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      networkSourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

/** Hosts named by quoted absolute URLs in one source text. */
function hostsIn(source: string): string[] {
  const hosts = new Set<string>()
  for (const match of source.matchAll(QUOTED_ABSOLUTE_URL)) {
    try {
      hosts.add(new URL(match[1]!).host.toLowerCase())
    } catch {
      // A malformed literal is not an origin; the compiler owns that mistake.
    }
  }
  return [...hosts]
}

describe('CSP allowlist matches the code', () => {
  const files = networkSourceFiles(root).filter(
    (path) => !path.includes(`${sep}e2e${sep}`) && !path.includes(`${sep}live${sep}`),
  )
  const byOrigin = new Map<string, string[]>()
  for (const path of files) {
    const source = readFileSync(path, 'utf8')
    if (!NETWORK_CALL.test(source)) continue
    for (const host of hostsIn(source)) {
      byOrigin.set(host, [...(byOrigin.get(host) ?? []), path.slice(root.length + 1)])
    }
  }

  it('finds the data origins in the source', () => {
    expect(byOrigin.size).toBeGreaterThan(0)
    expect([...byOrigin.keys()]).toContain('api.census.gov')
  })

  it('scans the AI client, which the enumerated list missed', () => {
    // The specific miss this rewrite exists to prevent. A named-file list can
    // silently exclude a directory; a capability scan cannot, and this fails
    // loudly if a future refactor makes the AI client stop looking like a
    // network module (for example by moving transport behind another name).
    expect([...byOrigin.keys()]).toContain('api.meta.ai')
    expect(byOrigin.get('api.meta.ai')).toContain(join('core', 'ai', 'meta-client.ts'))
  })

  it('allows every origin any shipped module actually calls', () => {
    const policy = csp()
    const connectSrc = policy.split(';').find((d) => d.trim().startsWith('connect-src'))!
    const missing = [...byOrigin.entries()].filter(([host]) => !connectSrc.includes(host))
    expect(
      missing.map(([host, paths]) => `${host} (${[...new Set(paths)].join(', ')})`),
      'Add these to connect-src in public/_headers',
    ).toEqual([])
  })

  it('would catch an origin added to a network module without a policy entry', () => {
    // Proves the check has teeth independently of today's origins: a new
    // fetch-bearing source contributes its host, and a host that is absent
    // from the policy is reported rather than ignored.
    const added = "const res = await fetch('https://new-origin.example/api')"
    const hosts = hostsIn(added)
    expect(hosts).toEqual(['new-origin.example'])
    const connectSrc = csp().split(';').find((d) => d.trim().startsWith('connect-src'))!
    expect(connectSrc.includes(hosts[0]!)).toBe(false)
  })

  it('every registered plugin is reachable under the policy', () => {
    // Guards the inverse direction: a plugin that cannot fetch is worse than
    // one that is absent, so the count is asserted rather than assumed.
    expect(registry.all().length).toBeGreaterThan(0)
  })
})
