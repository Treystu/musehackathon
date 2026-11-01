# Submission path: deployment record

Date: 2026-10-30. Issue: #56. Lane: `lane/submission` at `d4a7dc6`.
Production is still untouched: this record describes a **preview** deployment,
because moving the production alias is owner-reserved.

## What was deployed

| Field | Value |
| --- | --- |
| Lane head | `d4a7dc6` (`Record the S12 voice cut criterion by criterion`) |
| Environment | Preview, branch `submission` |
| Deployment id | `390579ff-fcd3-42ce-8be5-408f151e0541` |
| Deployment URL (pinned) | https://390579ff.civicscope.pages.dev |
| Branch alias | https://submission.civicscope.pages.dev |
| Build | `npm run build` (tsc, vite, SEO generator): 50 files, 3.7 MB |
| Functions | `wrangler pages functions build` compiled the Worker, then the deploy uploaded the Functions bundle |
| Tool | wrangler 4.143.0, project `civicscope` |

The command was `npx wrangler pages deploy dist --project-name civicscope
--branch submission`; `--branch main` was deliberately not used, because that
would move the production alias without the owner's merge.

## Served surface, measured

All checks run against `https://submission.civicscope.pages.dev` on 2026-10-30.

| Check | Result |
| --- | --- |
| `GET /` | 200, `text/html`, 2,287 bytes |
| `GET /assets/index-BmVmqjLN.js` | 200, `application/javascript`, 368,152 bytes |
| `GET /z/02139` (deep link / SEO page) | 200, `text/html` |
| `POST /api/muse/intent` | 503, `{"error":"provider_down","detail":"no shared key configured"}`, `cache-control: no-store` |
| `POST /api/muse/explain` | 503, same body |
| `POST /api/muse/transcribe` | 503, same body |
| `POST` with a foreign `Origin` | 403, `{"error":"not_allowlisted"}` |
| `GET /api/muse/intent` | 200, `text/html`: the SPA fallback answers a method the route does not register. POST is the contract; recorded as observed behavior, not as a route error. |

Security headers on the served build are applied: CSP `connect-src` includes
both origins the shipped code calls (`https://api.meta.ai` and
`https://geodata.epa.gov`), plus `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`Permissions-Policy` with `microphone=()`, and HSTS.

The served JavaScript bundle contains the House layer: `Ask CivicScope`,
`Run this request`, `/api/muse/intent`, `api.meta.ai` and `Explain` are all
present.

## Browser flows on the served URL

| Suite | Result |
| --- | --- |
| `src/e2e/ask-shell.e2e.ts` with `E2E_BASE_URL` set to the preview | 3/3 passed: Ask mounts text-only, a typed question is parsed into validated chips, Run executes into the comparison with the network down, and no key appears in the request body |
| `src/e2e/a11y.e2e.ts` with `E2E_BASE_URL` set to the preview | 8/8 passed, 0 axe violations on the explore and methodology views |

## Production is unchanged

| Check | Production |
| --- | --- |
| Deployment | `c08436a3`, branch `main`, source `b0f3577`, one week old |
| `POST /api/muse/intent` | 405 (no Functions on the production build) |
| Bundle | `/assets/index-CFoyZaoo.js`, 0 occurrences of `Ask CivicScope` |

So the House layer answers on the preview and does not on production. This
deployment did not alter production, and no merge to `main` or
`contest/house-port` was made.

## What remains, and who unblocks it

1. **Shared key (owner).** Every `/api/muse/*` route currently answers
   503 `provider_down` because `MUSE_API_KEY` is unset in both Pages
   environments. One Meta Model API key with available credit, set as
   `MUSE_API_KEY` with `MUSE_MODEL=muse-spark-1.3`, turns the proxy from
   refusing to answering. This is the same blocker recorded on #55 and #60.
2. **Per-client cap value (owner, S10).** No value is set, so no per-client
   isolation is applied. The aggregate cap defaults to
   `JUDGING_CAP_MICRO_USD = 52,500,000` (52.50 USD) in `src/core/ai/meter.ts`;
   the ramification of leaving the per-client value unset is that one client
   can consume that shared pool until the global shutoff, after which every
   client receives 429 `budget_exhausted` and the BYO-key path becomes the way
   forward.
3. **Production promotion (owner).** Deploys are manual here
   (`npm run deploy`), so merging is necessary but not sufficient. The recorded
   path is: open a PR from `contest/house-port` (or this lane) into `main`,
   confirm the three check-runs are green on the head, merge, then run
   `npm run deploy` from `main` and verify the served bundle hash before
   repeating this smoke list. That PR must state its PR #32 interaction: #32 is
   on HOLD, changes only `docs/full-muse-layer-plan.md`, and is not merged here
   or included in this path. There is no code dependency between the House
   layer and #32.

## What this does and does not prove

It proves the House layer builds into a Pages deployment, that all three
Functions routes are bundled and answer on a real served origin, that the
always-on gates (CORS refusal, no-store, CSP) behave, and that the Ask flow and
accessibility hold in a browser against that origin. It does not prove the live
provider completion, because no key exists on either environment; that remains
with #55 and #60.
