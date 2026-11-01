/**
 * GET /api/muse/diagnostics — the deployment's own diagnostics facts.
 *
 * Exists so a user-exported artifact can say what the deployment actually
 * observes (whether a shared key is configured, meter totals, cap state,
 * build identity) instead of guessing from the browser. It reports booleans,
 * integers, and closed enums only: there is no field that could carry the key,
 * a query, a provider body, or a per-visitor value.
 *
 * The meter is the same instance the proxy routes settle against, so these
 * totals are the ones that govern shutoff and the breaker. In the portal
 * deployment that meter's state is backed by the Durable Object store
 * (binding METER, one named instance; src/core/ai/meter-persistence.ts over
 * functions/api/muse/meter-do.ts), so the export states
 * `meterPersistence: "durable"` — the persistence class the deployment
 * actually carries (union change, Panel B4 gap G1: the pre-union route
 * hard-coded "isolate" from the in-memory-only deployment).
 *
 * Public by design: aggregate counters are the F7 operator surface and contain
 * nothing per-visitor. No CORS headers are served, and a foreign Origin is
 * refused outright.
 */
import {
  DIAGNOSTICS_SCHEMA,
  safeBranch,
  safeCommit,
} from '../../../src/core/ai/diagnostics'
import { MUSE_SPARK_MODEL } from '../../../src/core/ai/meta-client'
import { PROXY_ERRORS } from '../../../src/core/ai/proxy-errors'
import { VALIDATOR_FAILURES } from '../../../src/core/ai/validator'
import { meterFor, type MuseEnv, type PagesContext } from '../../../src/server/muse-adapter'

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export async function handleDiagnostics(context: PagesContext<MuseEnv>): Promise<Response> {
  const url = new URL(context.request.url)
  const origin = context.request.headers.get('origin')
  if (origin && origin !== url.origin) return json({ error: 'not_allowlisted' }, 403)
  if (context.request.method !== 'GET') return json({ error: 'not_allowlisted' }, 405)

  const env = context.env
  const keyPresent = typeof env.MUSE_API_KEY === 'string' && env.MUSE_API_KEY.length > 0
  const model = env.MUSE_MODEL || MUSE_SPARK_MODEL
  const meter = meterFor(env)
  const config = meter.configSnapshot()
  const snapshot = meter.snapshot()

  // Allowlist iteration, not passthrough: an error class recorded under any
  // other name is dropped rather than exported as an attacker-chosen string.
  const errors: Record<string, number> = {}
  for (const cls of [...PROXY_ERRORS, ...VALIDATOR_FAILURES]) {
    const count = snapshot.errors[cls]
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
      errors[cls] = count
    }
  }

  return json(
    {
      schema: DIAGNOSTICS_SCHEMA,
      sharedKeyPresent: keyPresent,
      modelIsDefault: model === MUSE_SPARK_MODEL,
      perClientCap: config.perClientCapConfigured ? 'configured' : 'unset',
      meterPersistence: 'durable',
      budgetCapMicroUsd: config.budgetCapMicroUsd,
      spentMicroUsd: snapshot.spentMicroUsd,
      requests: snapshot.requests,
      tokensIn: snapshot.tokensIn,
      tokensOut: snapshot.tokensOut,
      budgetExhausted: snapshot.budgetExhausted,
      breaker: meter.breakerState(),
      errors,
      deployment: {
        pages: env.CF_PAGES === '1',
        branch: safeBranch(env.CF_PAGES_BRANCH),
        commit: safeCommit(env.CF_PAGES_COMMIT_SHA),
      },
    },
    200,
  )
}

/** Pages Function entry point. GET is the whole contract. */
export const onRequestGet = handleDiagnostics
