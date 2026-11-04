# Harness-driven verification of the AI layer (Sovereign-Harness 0.5.1)

This directory is the recorded verification path for the portal's AI layer:
Sovereign-Harness (PyPI `sovereign-harness==0.5.1`) panel + judge
verification of claims about the shipped AI code, with every model in the
run pinned to Meta Muse models, the harness spend governor bounding the
run before dispatch, and the harness autonomy ledger's hash chain verified
afterwards.

## What runs

```
python3 tools/harness-verify/run_harness_verify.py [--only meta-client|answer]
```

The runner (re)builds the claims manifests from current source
(`build_claims.py`: verbatim excerpts of `src/core/ai/meta-client.ts` and
`src/core/ai/answer.ts`, with `source_refs` computed from anchor strings --
a moved anchor fails the build, never silently re-points), lints them with
the harness's hermetic claims lint, then invokes, per manifest:

```
python -m harness.cli verify \
  --claims-file claims-<name>.json --source-file excerpt-<name>.txt \
  --panel muse-spark-1.3,muse-wonder-1.0 --judge muse-wonder-1.0 \
  --convergence-model muse-spark-1.3 \
  --specialist-pool muse-spark-1.3,muse-wonder-1.0 \
  --max-cost 1.00 --task-id civicscope-ai-<name>
```

and finally `python -m harness.cli ledger verify`.

Claims are phrased as DEFECTs (failure modes the shipped code must not
have: a non-Muse runtime model, ungrounded research prose returned as
findings, an unscanned research path, chat-model transcription, figure
drift or uncited claims surviving into a "verified" answer, a fail-open
verify stage). A verification pass = panel + judge reject every defect
claim. A claim upheld is a finding against the code, not a runner failure
to be tuned away.

## The Muse-only invariant (all settings are load-bearing)

* panel + judge are passed explicitly (above), as bare Meta API ids: the
  run dispatches on the harness's direct Meta lane (api.meta.ai) under
  `HARNESS_MODEL_PRESET=muse`, which the runner forces in the subprocess
  env together with `HARNESS_META_BUDGET_USD=2.00` (the harness default
  is 0.0, and a zero cap refuses every Meta call). OpenRouter is not in
  this path: runs through 2026-11-03 used OpenRouter slugs
  (`meta/muse-*`) because the preset was left unset by hand; that rail
  is retired for Muse lane work by owner directive (2026-11-03);
* the convergence specialist and its specialist pool are ALSO passed
  explicitly: harness 0.5.1's default convergence model is a non-Muse
  model, and a live preflight reserve for it was observed on 2026-11-02
  when only panel/judge were pinned. Pinning panel/judge alone does not
  make a structured-claims run Muse-only. The seat renders the
  structured tally (the cheap rung), so it is pinned to Spark; Wonder
  stays on the judge seat;
* the runner forces `HARNESS_USE_FREE=false`, so no free-pool rotation can
  enter the run (judge fallbacks are drawn only from the panel pool);
* after each run the runner audits the harness events file: every model
  named anywhere in it, preflight reserves included, must be in
  {`muse-spark-1.3`, `muse-wonder-1.0`}, or the run is a failure. On
  this rail the audit also proves the route: a stray `meta/` OpenRouter
  slug anywhere in the events would fail the allowlist.

## Credentials and spend

The panel runs on the Muse API key (the hackathon credits), through the
harness's Meta lane: `harness.config.resolve_meta_key` reads
`~/.config/scmorc/meta.env`, then `~/.config/harness/meta.env`, then
`$META_API_KEY` / `$MUSE_API_KEY` in the environment. No key is read or
stored by anything in this directory. Under the preset the spend
governor skips OpenRouter key verification entirely (there is no
OpenRouter key in these runs to verify); the spend controls are the
local Meta budget (`HARNESS_META_BUDGET_USD`, forced to $2.00 by the
runner), the pre-flight worst-case reserve compared against `--max-cost`
before any dispatch, per-call ceilings, and fail-closed aborts. Bare
muse- ids are priced from the committed offers in `harness/meta.py`
(Spark $1.25 in / $4.25 out per 1M, Wonder $4 / $20 per 1M) -- never
the OpenRouter catalog. Historical note: the runs through 2026-11-03
dispatched through OpenRouter and stopped at $0.00 spent on
OpenRouter's account spend limit (HTTP 402 `[provider_spend_limit]`),
so no panel verdicts exist from those attempts. Worst-case reserves:
$0.87 / $0.86 observed 2026-11-02 (OpenRouter shape, pre-re-point
excerpts); recomputed 2026-11-03 for the re-pointed manifests on the
Muse rail (Spark convergence): $0.7896 (meta-client) / $0.7707
(answer) against the $1.00-per-manifest ceiling -- a reserve, not an
expected spend; the audit's expected actual is on the order of
$0.07 per manifest, booked from the API's usage counts at the
committed rates.

## What this does NOT claim

* Request time: nothing here runs in the request path. The portal's
  browser/Worker code calls `https://api.meta.ai/v1` directly through its
  own metered proxy (`src/core/ai/meta-client.ts`,
  `functions/api/muse/*`); sovereign-harness is Python and has no hosted
  endpoint in this project, and a Cloudflare Worker/browser cannot run
  it. The harness drives verification of the AI layer, not its requests.
* `driver_core` (the other half of the 0.5.1 package) is a
  verified-extraction -> Jev-decision -> consented-action driver for
  observing a host machine (CLI/DOM/GUI/MCP targets); its only model
  endpoint is TypeSafe System One (Jev, `jev-latest`), it reads only
  `DRIVER_*` config, and it has no surface that fits a text AI pipeline.
  It is not part of this verification path, and no claim below rests on it.
* The golden corpus replay (`tools/ai-eval/run-golden.mjs`, 91/91 intent
  + 7/7 safety on 2026-11-02) is a hermetic replay through the portal's
  own schema/validator path; it proves schema/validator behaviour, not
  live model accuracy. The live tier (`tools/ai-eval/run-live.mjs`)
  remains the live-accuracy instrument and needs the deployment key or
  the deployed proxy.
