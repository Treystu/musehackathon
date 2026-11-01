/**
 * Pages Function adapter for /api/muse/* (F0, plan section 6.5.5).
 *
 * The route handlers are framework-free so hermetic tests can call them
 * directly; this file is the only place that knows about HTTP, and it is thin
 * on purpose. Three properties are deliberate:
 *   - The shared key is read from the environment and never leaves the server.
 *   - Nothing is stored or logged: no body, no query text, no IP, no cookie.
 *     The meter is an in-memory aggregate counter, so a cold isolate starts at
 *     zero rather than inheriting anything durable.
 *   - Per-client cap support is wired to configuration but has no default
 *     value. The cap is S10, the owner's number; inventing one here would
 *     silently decide it.
 */
import { Meter, defaultMeterConfig } from '../core/ai/meter'
import {
  createMetaDirectProvider,
  META_API_BASE,
  MUSE_SPARK_MODEL,
} from '../core/ai/meta-client'
import type { ProxyDeps, ProxyReply } from './muse-proxy'

export interface MuseEnv {
  /** Server-side Meta Model API key. Absent means the proxy cannot serve. */
  MUSE_API_KEY?: string
  /** Runtime model; allowlisted to exactly this value. */
  MUSE_MODEL?: string
  MUSE_BASE_URL?: string
  /** Aggregate shutoff ceiling, micro-USD. Defaults to the plan's judging cap. */
  MUSE_BUDGET_CAP_MICRO_USD?: string
  /** S10 owner value. Unset means no per-client cap is applied. */
  MUSE_PER_CLIENT_CAP_MICRO_USD?: string
  /** Pages platform metadata, read by the diagnostics surface. Public values. */
  CF_PAGES?: string
  CF_PAGES_BRANCH?: string
  CF_PAGES_COMMIT_SHA?: string
}

/** Minimal Pages Function context shape; avoids a types dependency for one file. */
export interface PagesContext<E> {
  request: Request
  env: E
  params: Record<string, string | string[]>
  next(): Promise<Response>
  waitUntil(promise: Promise<unknown>): void
}

let sharedMeter: Meter | null = null

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * The meter is shared by every route in the isolate on purpose: the aggregate
 * shutoff is a property of the deployment, not of one route. Diagnostics reads
 * the same instance rather than keeping a second set of totals.
 */
export function meterFor(env: MuseEnv): Meter {
  if (sharedMeter) return sharedMeter
  const base = defaultMeterConfig()
  const perClient = parsePositiveInt(env.MUSE_PER_CLIENT_CAP_MICRO_USD)
  sharedMeter = new Meter({
    ...base,
    budgetCapMicroUsd: parsePositiveInt(env.MUSE_BUDGET_CAP_MICRO_USD) ?? base.budgetCapMicroUsd,
    ...(perClient === undefined ? {} : { perClientCapMicroUsd: perClient }),
  })
  return sharedMeter
}

/** Test seam: the singleton is per-process, so route tests that change config
 * need a way to start from a fresh meter. Never called by shipped code. */
export function resetMeterForTests(): void {
  sharedMeter = null
}

/** Null when the deployment has no key: the route reports provider_down. */
export function depsFor(env: MuseEnv): ProxyDeps | null {
  const key = env.MUSE_API_KEY
  if (!key) return null
  const model = env.MUSE_MODEL || MUSE_SPARK_MODEL
  return {
    meter: meterFor(env),
    // Direct provider: the server proxy must not call itself. The browser's
    // hybrid client is a separate factory in the same module.
    provider: createMetaDirectProvider({
      baseUrl: env.MUSE_BASE_URL || META_API_BASE,
      model,
      getApiKey: () => key,
    }),
    allowedModels: [model],
  }
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function readBody(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return null
  return request.json().catch(() => null)
}

/**
 * Builds an onRequestPost export. Same-origin is enforced when the browser
 * sends an Origin header; the function serves no CORS headers, so a foreign
 * page cannot use it as a relay even without that check.
 */
export function museRoute(
  handler: (req: { method: string; path: string; body: unknown; clientId: string }, deps: ProxyDeps) => Promise<ProxyReply>,
) {
  return async (context: PagesContext<MuseEnv>): Promise<Response> => {
    const url = new URL(context.request.url)
    const origin = context.request.headers.get('origin')
    if (origin && origin !== url.origin) return json({ error: 'not_allowlisted' }, 403)

    const deps = depsFor(context.env)
    if (!deps) return json({ error: 'provider_down', detail: 'no shared key configured' }, 503)

    const reply = await handler(
      {
        method: context.request.method,
        path: url.pathname,
        body: await readBody(context.request),
        // Aggregate only. A stable per-deployment id, never a visitor id.
        clientId: 'shared',
      },
      deps,
    )
    return json(reply.body, reply.status)
  }
}
