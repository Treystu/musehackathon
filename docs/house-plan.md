# House plan — the Muse aspect (Ask only)

**Contest:** Meta Global AI Developer Hackathon, Indie track, solo (Lucas Ballek). Window Oct 26 – Nov 4, 2026; submissions Nov 4, 9:00 PM ET.  
**Baseline:** CivicScope at `3aa7e10` (see [civicscope-audit.md](civicscope-audit.md)). **Strategy:** PAD-FREEZE-HOUSE — pad lands in CivicScope `main` labelled pre-existing, then freezes; the House is the smallest contest integration built workbench-first in Entire (`/et/musehackathon/musehackathon`) and ported later via House branches. This session pushes planning + the smallest buildable slice to Entire only. Nothing here merges to CivicScope `main`.

## 1. What the House is

Ask only: **text + mic (mic LAST)**, one same-origin proxy route to Muse Spark, validator on Ask output only, meter/shutoff, disclosure on the surface. Everything else in the full Muse-layer plan — Explain on all views, briefing-pack AI copy, agent onboarding, voice conversation — is **deferred beyond the contest** (pad shells without AI at most). If mic is ever cut, the product still works fully on text with no dead button left.

Design constraint: model calls sit behind a narrow provider interface (`intent` / `explain` / `briefing` / `transcribe` shapes); validator, meter, and disclosure stay model-agnostic, so the post-contest swap (Harness + cheapest capable models, after the contest only) is a provider swap, not a rewrite. The contest product stays Spark-powered.

### Ruled decisions carried in (not re-opened)

- **D1 hybrid** — shared-$150 proxy first, BYO beyond. **D2** BYO-after-credits. **D3** official Muse workflow inside CivicScope; Entire is the build-first workbench. **D4 strict** — describe/compare cited figures, never call a place good/bad. **D5** proxy-side minimisation (structured slots, not raw query text, wherever the feature allows) + standing disclosure. **D6** briefing pack deferred under minimal scope. **D7** English-only at launch with honest boundary. **D8** "Muse layer" in-product.
- **Q1** — one aggregate counter store (Durable Object, counts only, never content), named plainly in privacy text; hard budget shutoff kept.
- **Q2** — mic is first-class **and** accessible-compatible (both): equal main input, keyboard path intact, transcript as editable chips, no mic-only path.
- **Budget §6.4 (runtime only):** live eval $60 / judging-window shared allowance $52.50 / build iteration $22.50 / reserve $15. This session draws **zero** from it (subscription-billed building; no live Meta API calls). The meter enforces the judging cap + per-client cap in code from day one; the per-client number is set at S10 meter config and is **not invented here**.
- **Non-negotiables:** model never originates a figure; numeral-provenance validator on all model text (word-numerals and derived percentages included — computed in code or rejected); fair-housing mechanical pre- and post-generation (strict line in code, never a prompt request); MOEs/CIs always retained and shown; disclosure on every AI surface; user text is data, never instructions; fallback parity; no tracking; honest pre-existing labelling.

## 2. Components

### 2.1 Provider interface (narrow, model-agnostic neighbours)

```ts
// src/core/ai/provider.ts — shapes only; implementations injected.
interface MuseProvider {
  intent(req: IntentRequest, signal: AbortSignal): Promise<IntentResult>
  explain(req: ExplainRequest, signal: AbortSignal): Promise<ExplainResult>   // specified, deferred
  briefing(req: BriefingRequest, signal: AbortSignal): Promise<BriefingResult> // specified, deferred (D6)
  transcribe(req: TranscribeRequest, signal: AbortSignal): Promise<TranscribeResult> // specified, LAST
}
```

`IntentRequest` carries structured slots (mode, geography hints, metric hints) per D5 — raw query text only where the feature cannot avoid it, and disclosed. Validator, meter, and disclosure import no provider type.

### 2.2 Proxy route (first: intent; others specified)

- Routes: `POST /api/muse/intent` (built), `POST /api/muse/explain`, `POST /api/muse/briefing`, `POST /api/muse/transcribe` (specified; transcribe LAST with audio metering). Same-origin only; any other path/model/shape → `400 { "error": "not_allowlisted" }`.
- Request bodies are CivicScope shapes only (slots / figure-set payloads; never a user identifier; no cookies read or set). Responses are shape-checked server-side (schema conformance for intent) and token-counted into the aggregate meter. Provider errors map to a closed taxonomy — `not_allowlisted`, `shape_invalid`, `rate_limited`, `credits_exhausted`, `provider_down`, `bad_key`, `budget_exhausted`, `breaker_open` — raw provider bodies never forwarded.
- Allowlist: named Muse Spark model(s) only (identifiers fixed at S2 from the live model page — not invented here); per-request token ceilings per shape; the proxy is not a general-purpose relay.

### 2.3 Meter / shutoff (Q1)

One Durable Object aggregate counter: counts only (requests, tokens, budget consumed, error classes), never content. Reservation/settlement per request (reserve ceiling → settle actuals → release remainder), circuit breaker (closed → open on provider failure threshold → half-open probe), per-client cap support (config value set at S10), hard shutoff at the judging-window cap ($52.50 bucket) degrading to BYO prompt / deterministic fallback. The privacy sentence names the store; it does not claim "stores nothing".

### 2.4 Validator wiring (Ask output only; pad owns the implementation)

6-step fail-closed order, enforced before any model prose renders:

1. Pre-generation intent gate (protected-class / filter-legal check on the validated intent).
2. Allowed-numeral set collection (every `MetricValue.value`, MOE, code-computed aggregate, source vintages).
3. Numeral scan including the closed word-form table (digit, comma/decimal, percentage, word-numeral forms).
4. Provenance match (scanned numeral must match an allowed value within displayed rounding; derived figures only if code-supplied).
5. Precision / MOE-CI overlap check (no comparative claim stronger than the MOE bands permit).
6. Construction check + disposition: pass → render with disclosure; fail → **withhold** prose, render plain figures + withholding note, increment the local withhold diagnostic (failure class only).

In Entire the validator is a **defined interface** (`src/core/ai/validator.ts`) imported from the pad path (`../pad/validator` at port time). Local tests use a hermetic stub implementing the same interface. The implementation is **not duplicated** here — single source is the pad.

### 2.5 Ask UI wiring + disclosure

Text input → provider `intent` → schema validation → **editable intent chips** (the parsed intent is visible and correctable before execution) → clarification state when geography/metric is ambiguous (nothing executes until resolved) → execution through the existing DAG executor → figures through existing `MetricCard`/`Comparison` components. Disclosure on the surface, verbatim in substance: *figures are CivicScope's (source + vintage shown); wording is Muse Spark's; this is a reading of the shown figures, not an additional source.* D5 slots disclosed; fallback parity: AI off ⇒ manual path (existing search/sort/filter) untouched, keyless drilldown intact.

### 2.6 Mic (LAST — planned, not built in this session)

Built only after Ask text + proxy + validator + meter + disclosure land, because every mic dependency is pre-built: transcription route (`/api/muse/transcribe` with audio metering), transcript → editable chips UI, spoken-number validation through the same validator, first-use consent before any mic use, audio-transit disclosure. First-class + accessible (Q2): mic as an equal main input **and** fully keyboard/screen-reader compatible; low-confidence transcript → clarification, never a silent substitution. CSP `microphone=()` → `(self)` ships in the same change as mic, never earlier. **This session: mic stays planned.** Dependencies listed in §4.

## 3. LoC breakdown (House is a subset — read this first)

The full Muse-layer plan totals **8,850–12,450 LoC** (F0–F7 + F6 committed). **The House is not that.** House = **F0-lite + F4-wiring** (proxy/meter subset + validator *integration*, not the full F0 key architecture and not the full F4 validator build, which lives in the pad) plus Ask-only UI. Reusing full F0/F4 numbers as House numbers would inflate the estimate; the table below is the House's own.

| House component | LoC (impl + tests + docs lines) | Notes |
|---|---|---|
| Planning docs (this plan + audit) | ~350 | `docs/house-plan.md`, `docs/civicscope-audit.md` |
| Provider interface + intent schema/allowlist | ~200 | `provider.ts`, `intent-schema.ts` (allowlist derived from registry/sortable sets) |
| Proxy route (validation, taxonomy, ceilings) | ~260 | `functions/api/muse/*` |
| Meter (Q1 counter, reservation/settlement, breaker, per-client cap support) | ~220 | Durable Object shape + in-memory hermetic double |
| Validator wiring (interface + hermetic stub) | ~140 | Implementation owned by pad; no duplication |
| Ask UI (panel, chips, clarification, disclosure) | ~420 | React components, keyboard-first |
| Hermetic tests (proxy, meter, schema, wiring) | ~380 | No network, no keys, no credits |
| **Built-slice subtotal (this session's target)** | **~1,970** | Text Ask only |
| Mic (transcribe route + audio metering + chips/consent UI) — LAST, planned | ~300–400 | Not in the subtotal; ships only if §4 verifies |
| **House total if mic lands** | **~2,270–2,370** | vs 8,850–12,450 full plan |

## 4. Build order & mic gate

1. Planning docs → 2. Provider + schema → 3. Proxy + meter → 4. Validator wiring → 5. Ask UI + disclosure → 6. Hermetic tests + secret scan → 7. **Mic only if** 1–6 land **and** these verify: transcription route shape, audio metering, chips UI, spoken-number validation, consent pattern, CSP change reviewed. Otherwise mic stays planned with this list as the blocker record.

Overlay status until the pad lands is **partial** by definition: scratch CivicScope `3aa7e10` + House tree copied over it. Full overlay-green requires the pad in CivicScope `main` and a re-run against the new main SHA. Trail evals are advisory only; overlay verification is the landing authority. Never submission-ready on Trail green.

## 5. Error behaviour (House rows)

| State | Behaviour |
|---|---|
| No/bad Census key | Keyless surfaces work; Ask executes its keyless portion and names what it skipped. |
| Model down / partial output | Discard partial prose; offer chips to complete manually; figure cards throughout. |
| 429 / credits exhausted | Plain-words limit message + what still works (everything non-AI) + BYO route; breaker/shutoff trips on the operator path. |
| Proxy-metric / ranking / out-of-scope ask | Distinct refusal naming the boundary + nearest legitimate action (reader-controlled sort by one published non-proxy figure, MOEs visible). |
| Ambiguous geography | Clarification with real candidates; nothing executes until resolved. |
| Validator withhold | Plain figures + withholding note; never a blank, never the failed prose. |
