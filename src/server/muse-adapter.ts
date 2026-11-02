/**
 * Pages Function adapter for /api/muse/* (F0, plan section 6.5.5).
 *
 * The route handlers are framework-free so hermetic tests can call them
 * directly; this file is the only place that knows about HTTP, and it is thin
 * on purpose. Three properties are deliberate:
 *   - The shared key is read from the environment and never leaves the server.
 *   - Nothing is stored or logged: no body, no query text, no IP, no cookie.
 *     The meter holds aggregate counters only. Where the deployment binds
 *     the METER Durable Object (the portal), that one named instance is
 *     the counter store, so totals survive isolate restarts; where no
 *     binding is configured, the meter is in-isolate memory and a cold
 *     isolate starts at zero. Diagnostics reports which of the two a
 *     deployment carries (meterPersistenceFor) — the claim is read from
 *     the same env that chooses the meter, never hard-coded.
 *   - Per-client cap configuration is read for diagnostics truthfulness
 *     only. The judged flow enforces no per-client cap (owner
 *     resolution, 2026-11-02: the meter is accounting only), so an
 *     unset value is the truthful default, not a missing decision.
 */
import {
  getMeterClient,
  type DurableObjectNamespaceLike,
} from '../../functions/api/muse/meter-do'
import { Meter, defaultMeterConfig } from '../core/ai/meter'
import {
  createMetaDirectProvider,
  META_API_BASE,
  MUSE_SPARK_MODEL,
  PROXY_ALLOWED_MODELS,
} from '../core/ai/meta-client'
import type { MeterContract, ProxyDeps, ProxyReply } from './muse-proxy'

export interface MuseEnv {
  /** Server-side Meta Model API key. Absent means the proxy cannot serve. */
  MUSE_API_KEY?: string
  /** Runtime model; allowlisted to exactly this value. */
  MUSE_MODEL?: string
  MUSE_BASE_URL?: string
  /** Budget reporting threshold, micro-USD. Defaults to the plan's judging cap. */
  MUSE_BUDGET_CAP_MICRO_USD?: string
  /** Read for diagnostics reporting only; never enforced (2026-11-02). */
  MUSE_PER_CLIENT_CAP_MICRO_USD?: string
  /**
   * TypeSafe System One key for the Jev evaluation route (C3). Read
   * only by that route, which is an independent failure domain: its
   * absence degrades Jev consumers and touches nothing else.
   */
  TYPESAFE_API_KEY?: string
  /**
   * Meter Durable Object binding (wrangler.toml, portal deployment).
   * Present means the meter is the durable DO-backed client; absent
   * means the in-isolate Meter.
   */
  METER?: DurableObjectNamespaceLike
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

let sharedMeter: MeterContract | null = null

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * The meter is shared by every route in the deployment on purpose: the
 * aggregate accounting is a property of the deployment, not of one
 * route. Diagnostics reads the same instance rather than keeping a
 * second set of totals. With the METER binding the shared instance is
 * the Durable
 * Object client (one named instance, 'judging-window-v1'); without it,
 * the in-isolate Meter configured from env as before.
 */
export function meterFor(env: MuseEnv): MeterContract {
  if (sharedMeter) return sharedMeter
  if (env.METER) {
    sharedMeter = getMeterClient(env.METER)
    return sharedMeter
  }
  const base = defaultMeterConfig()
  const perClient = parsePositiveInt(env.MUSE_PER_CLIENT_CAP_MICRO_USD)
  sharedMeter = new Meter({
    ...base,
    budgetCapMicroUsd: parsePositiveInt(env.MUSE_BUDGET_CAP_MICRO_USD) ?? base.budgetCapMicroUsd,
    ...(perClient === undefined ? {} : { perClientCapMicroUsd: perClient }),
  })
  return sharedMeter
}

/**
 * The persistence class the diagnostics surface reports for this env:
 * 'durable' exactly when meterFor would hand out the DO-backed client.
 */
export function meterPersistenceFor(env: MuseEnv): 'durable' | 'isolate' {
  return env.METER ? 'durable' : 'isolate'
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
  // Direct provider: the server proxy must not call itself. The browser's
  // hybrid client is a separate factory in the same module. The same
  // instance serves stage-scoped calls (C1): its stageChat carries a
  // per-call model, so the bookend stages can name the Wonder
  // candidate without changing this provider's configured model.
  const provider = createMetaDirectProvider({
    baseUrl: env.MUSE_BASE_URL || META_API_BASE,
    model,
    getApiKey: () => key,
  })
  return {
    meter: meterFor(env),
    provider,
    stageProvider: provider,
    // Per-call model selection (C1): a request may name any allowlisted
    // stage model; the configured model stays the default when a
    // request names none. The configured value is added when an
    // operator pin differs from the shipped allowlist.
    allowedModels: PROXY_ALLOWED_MODELS.includes(model)
      ? [...PROXY_ALLOWED_MODELS]
      : [model, ...PROXY_ALLOWED_MODELS],
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

    // Best-effort accounting rides the runtime's waitUntil: a meter
    // hop may finish after the reply is sent instead of delaying it
    // (accounting-only meter, 2026-11-02). depsFor returns a fresh
    // deps object per request, so wiring the hook here cannot leak
    // one request's context into another.
    if (typeof context.waitUntil === 'function') {
      deps.defer = (promise) => context.waitUntil(promise)
    }

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
