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
 * totals are the ones that govern shutoff and the breaker. Its persistence
 * class is read from the deployment env (meterPersistenceFor): the portal
 * binds the Durable Object store (binding METER, one named instance;
 * src/core/ai/meter-persistence.ts over functions/api/muse/meter-do.ts)
 * and reports `meterPersistence: "durable"`; a deployment without the
 * binding settles against the in-isolate Meter and reports "isolate".
 * The field states the class the deployment actually carries — the
 * pre-union route hard-coded "isolate" from the in-memory-only
 * deployment, and the union draft hard-coded "durable" before the
 * handlers were wired to the client; both are replaced by the env read.
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
import { MeterUnavailableError } from '../../../src/core/ai/meter-persistence'
import {
  meterFor,
  meterPersistenceFor,
  type MuseEnv,
  type PagesContext,
} from '../../../src/server/muse-adapter'

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

  // The meter reads cross the Durable Object hop in the portal
  // deployment. A meter that cannot be read fails closed on the same
  // taxonomy as the proxy routes (503 breaker_open) rather than
  // surfacing as an unhandled error or, worse, a fabricated total.
  let config: Awaited<ReturnType<typeof meter.configSnapshot>>
  let snapshot: Awaited<ReturnType<typeof meter.snapshot>>
  let breaker: Awaited<ReturnType<typeof meter.breakerState>>
  try {
    config = await meter.configSnapshot()
    snapshot = await meter.snapshot()
    breaker = await meter.breakerState()
  } catch (e) {
    if (e instanceof MeterUnavailableError) return json({ error: 'breaker_open' }, 503)
    throw e
  }

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
      meterPersistence: meterPersistenceFor(env),
      budgetCapMicroUsd: config.budgetCapMicroUsd,
      spentMicroUsd: snapshot.spentMicroUsd,
      requests: snapshot.requests,
      tokensIn: snapshot.tokensIn,
      tokensOut: snapshot.tokensOut,
      budgetExhausted: snapshot.budgetExhausted,
      breaker,
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
