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
  --panel meta/muse-spark-1.3,meta/muse-wonder --judge meta/muse-wonder \
  --convergence-model meta/muse-wonder \
  --specialist-pool meta/muse-wonder,meta/muse-spark-1.3 \
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

## The Muse-only invariant (all four settings are load-bearing)

* panel + judge are passed explicitly (above);
* the convergence specialist and its specialist pool are ALSO passed
  explicitly: harness 0.5.1's default convergence model is a non-Muse
  model, and a live preflight reserve for it was observed on 2026-11-02
  when only panel/judge were pinned. Pinning panel/judge alone does not
  make a structured-claims run Muse-only;
* the runner forces `HARNESS_USE_FREE=false`, so no free-pool rotation can
  enter the run (judge fallbacks are drawn only from the panel pool);
* after each run the runner audits the harness events file: every model
  named anywhere in it, preflight reserves included, must be in
  {`meta/muse-spark-1.3`, `meta/muse-wonder`}, or the run is a failure.

## Credentials and spend

The harness reads its OpenRouter key from its own config path
(`~/.config/harness/openrouter.env`, or `$OPENROUTER_API_KEY`); OpenRouter
serves `meta/muse-spark-1.3` and `meta/muse-wonder` from Meta's endpoint.
No key is read or stored by anything in this directory. The portal's
`MUSE_API_KEY` (deployment env, api.meta.ai) is never used here. Spend
governance is the harness's: a key-identity/spend check, a pre-flight
worst-case reserve compared against `--max-cost` before any dispatch
(observed 2026-11-02: $0.87 / $0.86 reserved against a $1.00 ceiling),
per-call ceilings, and fail-closed aborts -- the same 2026-11-02 runs
stopped at $0.00 known cost when the upstream Meta endpoint returned
HTTP 402 (provider spend limit exhausted), so no panel verdicts exist
from that date; re-run when the endpoint's limit resets.

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
