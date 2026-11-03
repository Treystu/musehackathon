/**
 * POST /api/muse/research — grounded web findings (2026-11-01, owner
 * directive: any question answerable). The Census data cannot serve
 * criteria like schools, amenities, or political character; this route
 * runs the Muse Responses API's web_search tool through the provider
 * and returns prose WITH its sources. The provider refuses ungrounded
 * replies (no citations), so a 200 from this route always carries a
 * source list. Counted at a conservative flat rate: web search bills
 * separately ($2.50 per 1,000 searches) on top of tokens, and the flat
 * 5,000 micro-USD covers both at demo scale against the judging
 * allowance. Accounting is best-effort only (2026-11-02): the meter
 * never admits or refuses a request. Counts only; no bodies are
 * stored (Q1).
 *
 * P7 (2026-11-02): the flat modelled settle above is unchanged, and
 * the reply's search activity is now ALSO counted on its own line --
 * the provider reports the web_search_call count from the Responses
 * output (parseResearchResult in meta-client.ts, the issuance point:
 * the Responses call naming the web_search tool), and this route
 * records it in the meter's durable search counter so diagnostics
 * can price searches separately in the true-cost view. A completed
 * reply that reports no count is recorded as one search: the
 * provider's citation gate means a returned result was grounded,
 * and grounding here is a search.
 */
import { findBannedConstruction } from '../../../src/core/ai/validator'
import {
  MUSE_SPARK_MODEL,
  RESEARCH_PLACES_LIMIT,
  RESEARCH_QUERY_MAX_CHARS,
} from '../../../src/core/ai/meta-client'
import { preCallGate, mapProviderError, attemptCall, accountCall, accountSearches, accountError, accountFailure, err, type ProxyDeps, type ProxyReply } from '../../../src/server/muse-proxy'
import { museRoute } from '../../../src/server/muse-adapter'

const ALLOWED_PATHS = new Set(['/api/muse/research'])
// The shared ceiling constant, not a local number: the runner
// composes queryText against RESEARCH_QUERY_MAX_CHARS, and a
// local literal here would let the two sides drift apart again
// (the places ceiling below drifted exactly that way).
const MAX_QUERY_CHARS = RESEARCH_QUERY_MAX_CHARS
// The shared seam constant, not a local number: this ceiling sat at
// 8 while the client's screened-research cap sent 10, and every
// 9-10-place research pass was refused here as shape_invalid before
// any upstream call (measured 2026-11-02; see RESEARCH_PLACES_LIMIT
// in meta-client.ts). The two values are one contract.
const MAX_PLACES = RESEARCH_PLACES_LIMIT
const MAX_PLACE_CHARS = 120
const ACTUAL_COST_MICRO = 5000
const ACTUAL_TOKENS_IN = 256
const ACTUAL_TOKENS_OUT = 512

export async function handleResearch(
  req: { method: string; path: string; body: unknown; clientId: string },
  deps: ProxyDeps,
): Promise<ProxyReply> {
  const gate = await preCallGate(req, deps, ALLOWED_PATHS, req.path)
  if (gate) return gate

  const body = req.body as Record<string, unknown>
  if (
    typeof body.queryText !== 'string' ||
    body.queryText.trim().length === 0 ||
    body.queryText.length > MAX_QUERY_CHARS
  ) {
    return err(400, 'shape_invalid', 'research needs a queryText within the ceiling')
  }
  let places: string[] = []
  if (body.places !== undefined) {
    if (
      !Array.isArray(body.places) ||
      body.places.length > MAX_PLACES ||
      body.places.some((p) => typeof p !== 'string' || p.length > MAX_PLACE_CHARS)
    ) {
      return err(400, 'shape_invalid', 'research places must be short strings')
    }
    places = body.places as string[]
  }

  try {
    const result = await attemptCall(deps, () =>
      deps.provider.research(
        { queryText: body.queryText as string, places },
        new AbortController().signal,
      ),
    )
    // The provider answered: count the call at its flat cost. Best
    // effort — a failed accounting hop changes nothing the user sees.
    // P7: the same tokens bucket by model and route, and the reply's
    // searches count on their own line (they were billed whether or
    // not the prose below survives the gates, so they count here,
    // before them).
    accountCall(deps, req.clientId, ACTUAL_COST_MICRO, ACTUAL_TOKENS_IN, ACTUAL_TOKENS_OUT, {
      model: deps.model ?? MUSE_SPARK_MODEL,
      route: 'research',
    })
    accountSearches(
      deps,
      typeof result.searchCalls === 'number' && result.searchCalls > 0
        ? Math.trunc(result.searchCalls)
        : 1,
    )
    if (
      typeof result.prose !== 'string' ||
      !result.prose.trim() ||
      !Array.isArray(result.sources) ||
      result.sources.length === 0
    ) {
      accountError(deps, 'provider_down')
      return err(502, 'provider_down', 'research returned no sourced findings')
    }
    // Fair-housing gate (2026-11-02): research prose was prompt-guarded
    // and citation-gated only, while figure prose is validator-gated —
    // and the shipped privacy text claims mechanical gates. Numeral
    // provenance does not apply (the prose legitimately cites web
    // figures), so the validator's banned-construction step is the
    // gate. Rescoped the same day for criteria-grounded answers: the
    // prose may name the screened places that meet the reader's own
    // stated criteria, while steering or characterising by race,
    // ethnicity, religion, or national origin, personal
    // recommendation, and superlative ranking still withhold the
    // findings, recorded by class.
    if (findBannedConstruction(result.prose, { criteriaGrounded: true })) {
      accountError(deps, 'banned_construction')
      return { status: 200, body: { withheld: true, failure: 'banned_construction' } }
    }
    return {
      status: 200,
      body: {
        prose: result.prose,
        sources: result.sources.map((s) => ({ title: s.title, url: s.url })),
      },
    }
  } catch (e) {
    accountFailure(deps)
    const mapped = mapProviderError(e)
    accountError(deps, String(mapped.body.error))
    return mapped
  }
}

/** Pages Function entry point. The handler above stays framework-free. */
export const onRequestPost = museRoute(handleResearch)
