/**
 * GET /api/muse/diagnostics — the deployment's own diagnostics facts.
 *
 * Exists so a user-exported artifact can say what the deployment actually
 * observes (whether a shared key is configured, meter totals, cap state,
 * build identity) instead of guessing from the browser. It reports booleans,
 * integers, and closed enums only: there is no field that could carry the key,
 * a query, a provider body, or a per-visitor value.
 *
 * The meter is the same instance the proxy routes account against, so
 * these totals are the deployment's actual counts (reporting only
 * since 2026-11-02: they govern no admission decision). Its persistence
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
 *
 * P7 (2026-11-02): two additive blocks extend the flat record, and
 * the schema string stays civicscope.diagnostics.v1 because both are
 * additive -- the client parser rebuilds the fields it knows and
 * drops the rest, so a v1 reader keeps working unchanged.
 *   - `usage`: the meter's per-model / per-route token splits, the
 *     durable search count, and the true costs computed from them
 *     (usage.ts). `usage.readable` is false when the split view
 *     could not be read (for example the standalone meter worker
 *     still runs a pre-P7 class with no usageSnapshot op): the
 *     splits then read as zeros and are labelled unread, never
 *     presented as measured zeros.
 *   - `costs`: the two cost stories side by side, each with its
 *     basis label -- the flat modelled accounting (spentMicroUsd,
 *     unchanged semantics) and the true cost at roster prices.
 * The `hourglass` field now reads the meter's durable mirror of the
 * bookend outcomes when the split view is readable (the in-isolate
 * counters undercount across isolates; see bookend-counters.ts);
 * when it is not, it falls back to the in-isolate counters, which
 * is the most that deployment can truthfully report.
 * Everything here is read-path only: this handler computes costs
 * from recorded counters and writes nothing, so the additions
 * cannot gate, delay, or fail a user request.
 */
import {
  DIAGNOSTICS_SCHEMA,
  safeBranch,
  safeCommit,
} from '../../../src/core/ai/diagnostics'
import { MUSE_SPARK_MODEL } from '../../../src/core/ai/meta-client'
import { PROXY_ERRORS } from '../../../src/core/ai/proxy-errors'
import { VALIDATOR_FAILURES } from '../../../src/core/ai/validator'
import { bookendCountersSnapshot } from '../../../src/core/ai/bookend-counters'
import {
  computeTrueCosts,
  sanitizeUsageSnapshot,
  zeroUsageSnapshot,
  type UsageSnapshot,
} from '../../../src/core/ai/usage'
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
  // deployment. This unmetered read path is the pattern for
  // accounting-only reads: a meter that cannot be read answers 503
  // breaker_open rather than surfacing as an unhandled error or,
  // worse, a fabricated total. (The proxy routes no longer fail on
  // meter errors at all — their writes are best-effort accounting.)
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

  // P7 split view, read separately from the flat totals on purpose:
  // a split view that cannot be read (a pre-P7 meter class behind
  // the binding) must not take the whole diagnostics record down
  // with it, and must not be reported as measured zeros either --
  // hence the readable flag beside zeroed splits. The sanitize pass
  // rebuilds the view from the closed model/route keys only.
  let usage: UsageSnapshot = zeroUsageSnapshot()
  let usageReadable = true
  try {
    usage = sanitizeUsageSnapshot(await meter.usageSnapshot())
  } catch (e) {
    if (!(e instanceof MeterUnavailableError)) throw e
    usageReadable = false
  }
  const trueCosts = computeTrueCosts(usage)

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
      // The two cost stories, labelled (P7). modelledAccounting is
      // the flat settle accounting that spentMicroUsd has always
      // carried; trueCost prices the recorded split tokens at
      // roster rates and adds web-search billing. Neither is a
      // bill; both are reporting, and the bases say which is which.
      costs: {
        modelledAccounting: {
          basis: 'flat modelled accounting: per-route flat settle constants, not prices',
          spentMicroUsd: snapshot.spentMicroUsd,
        },
        trueCost: {
          basis:
            'true cost: split tokens at roster prices by model, plus web searches at $2.50 per 1000; a floor, because briefing and transcribe tokens carry no split',
          tokenCostMicroUsd: trueCosts.tokenCostMicroUsd,
          searchCostMicroUsd: trueCosts.searchCostMicroUsd,
          trueCostMicroUsd: trueCosts.trueCostMicroUsd,
          byModelCostMicroUsd: trueCosts.byModelCostMicroUsd,
        },
      },
      // P7 usage splits: tokens and call counts by model and by
      // route, the durable search count with its own cost line, and
      // whether this view was actually read (see the note above).
      usage: {
        readable: usageReadable,
        byModel: usage.byModel,
        byRoute: usage.byRoute,
        searches: usage.searches,
        searchCostMicroUsd: trueCosts.searchCostMicroUsd,
        tokenCostMicroUsd: trueCosts.tokenCostMicroUsd,
        trueCostMicroUsd: trueCosts.trueCostMicroUsd,
        byModelCostMicroUsd: trueCosts.byModelCostMicroUsd,
      },
      // Hourglass bookend outcomes (C11): aggregate counts only.
      // P7: read from the meter's durable mirror when the split
      // view is readable; the in-isolate counters are the fallback
      // for a deployment whose meter cannot report them.
      hourglass: usageReadable ? usage.hourglass : bookendCountersSnapshot(),
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
