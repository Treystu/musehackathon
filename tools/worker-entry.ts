/**
 * Advanced-mode worker entry for the portal deployment (deploy-fix).
 *
 * Why this file exists, measured rather than believed: the standard
 * Pages Functions build (`wrangler pages functions build functions`)
 * compiles this tree cleanly but emits a bundle with ZERO occurrences
 * of MeterDurableObject — no route module imports meter-do.ts or
 * shared.ts, and the functions compiler ignores middleware exports, so
 * the class never enters the module graph and the METER Durable Object
 * binding has nothing to resolve. A Pages deployment therefore needs
 * advanced mode: a dist/_worker.js whose module graph names the class
 * as a top-level export. This entry is that graph. functions/ remains
 * the source of truth; this file is dispatch glue only and changes no
 * handler, meter, or middleware behavior.
 *
 * Dispatch mirrors what the Pages runtime does with functions/:
 *   - an exact route path invokes the module's method-specific export
 *     (onRequestPost, onRequestGet, ...) or its generic onRequest;
 *   - a matched path with no export for the method is refused 405 with
 *     the same JSON shape handleDiagnostics uses for its own method
 *     guard ({ error: 'not_allowlisted' }) — the only method-mismatch
 *     shape in the tree;
 *   - an /api/ path no module owns falls through to the asset server,
 *     exactly as an unmatched function route does under Pages;
 *   - every other request runs the root middleware (the Census
 *     shared-key injector) with next() bound to env.ASSETS, which is
 *     the middleware's whole contract. The middleware is itself a
 *     pass-through for /api/, so routing API traffic here first is
 *     equivalent, not a shortcut.
 */
import * as briefingRoute from '../functions/api/muse/briefing'
import * as diagnosticsRoute from '../functions/api/muse/diagnostics'
import * as explainRoute from '../functions/api/muse/explain'
import * as flexibleRoute from '../functions/api/muse/flexible'
import * as generalRoute from '../functions/api/muse/general'
import * as intentRoute from '../functions/api/muse/intent'
import * as jevRoute from '../functions/api/muse/jev'
import * as planRoute from '../functions/api/muse/plan'
import * as researchRoute from '../functions/api/muse/research'
import * as transcribeRoute from '../functions/api/muse/transcribe'
import * as verifyRoute from '../functions/api/muse/verify'
import { onRequest as censusInjector } from '../functions/_middleware'
import type { CensusInjectorEnv } from '../functions/_middleware'
import type { MuseEnv, PagesContext } from '../src/server/muse-adapter'

export { MeterDurableObject } from '../functions/api/muse/meter-do'

/** The asset server binding Pages injects in advanced mode. */
export interface AssetFetcher {
  fetch(request: Request): Promise<Response>
}

/** Deployment env as the worker sees it: proxy + injector + assets. */
export interface WorkerEnv extends MuseEnv, CensusInjectorEnv {
  ASSETS: AssetFetcher
}

/** The slice of the Workers execution context this glue relies on. */
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

type RouteHandler<E> = (context: PagesContext<E>) => Promise<Response>

interface RouteModule {
  onRequest?: RouteHandler<MuseEnv>
  [exportName: string]: unknown
}

const ROUTES: ReadonlyMap<string, RouteModule> = new Map<string, RouteModule>([
  ['/api/muse/briefing', briefingRoute],
  ['/api/muse/diagnostics', diagnosticsRoute],
  ['/api/muse/explain', explainRoute],
  ['/api/muse/flexible', flexibleRoute],
  ['/api/muse/general', generalRoute],
  ['/api/muse/intent', intentRoute],
  ['/api/muse/jev', jevRoute],
  ['/api/muse/plan', planRoute],
  ['/api/muse/research', researchRoute],
  ['/api/muse/transcribe', transcribeRoute],
  ['/api/muse/verify', verifyRoute],
])

/** Pages export suffix per method: onRequest + Get/Post/Put/... */
const METHOD_SUFFIX: Readonly<Record<string, string>> = {
  GET: 'Get',
  POST: 'Post',
  PUT: 'Put',
  PATCH: 'Patch',
  DELETE: 'Delete',
  HEAD: 'Head',
  OPTIONS: 'Options',
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

function pagesContext<E>(
  request: Request,
  env: WorkerEnv,
  exec: WorkerExecutionContext,
  next: () => Promise<Response>,
): PagesContext<E> {
  return {
    request,
    env: env as E,
    params: {},
    next,
    waitUntil: (promise) => exec.waitUntil(promise),
  }
}

/**
 * The whole dispatch, exported so hermetic tests drive it with a fake
 * ASSETS binding instead of a server. The default export below is the
 * thin runtime adapter over it.
 */
export async function dispatchFetch(
  request: Request,
  env: WorkerEnv,
  exec: WorkerExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const serveAssets = () => env.ASSETS.fetch(request)

  const route = ROUTES.get(pathname)
  if (route) {
    const suffix = METHOD_SUFFIX[request.method.toUpperCase()]
    const methodHandler = suffix ? route[`onRequest${suffix}`] : undefined
    const handler = (typeof methodHandler === 'function' ? methodHandler : route.onRequest) as
      | RouteHandler<MuseEnv>
      | undefined
    if (!handler) return json({ error: 'not_allowlisted' }, 405)
    return handler(pagesContext<MuseEnv>(request, env, exec, serveAssets))
  }

  if (pathname.startsWith('/api/')) return serveAssets()

  return censusInjector(pagesContext<CensusInjectorEnv>(request, env, exec, serveAssets))
}

export default {
  fetch(request: Request, env: WorkerEnv, exec: WorkerExecutionContext): Promise<Response> {
    return dispatchFetch(request, env, exec)
  },
}
