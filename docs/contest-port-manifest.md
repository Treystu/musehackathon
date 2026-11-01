# Contest port manifest

This file is the record of what the Meta hackathon contest work in this
repository is built from. It exists so the submission breakdown (built
during the contest vs pre-existing) is a file in the repo, not a claim in
a form.

## Pre-existing (not contest-built)

The metric registry is CivicScope's own code, written before the contest.
It is retained on the contest base branch unchanged in substance; the only
edits are the pre-existing label headers at the top of each file.

| File | Contents | Source |
| --- | --- | --- |
| `src/core/plugins/acs.ts` | `METRIC_DEFS` (15 keys), `METRIC_DEFS_BY_KEY`, `METRIC_KEYS` | `Sovereign-Communication/civicscope` at `3aa7e10dc59e764a8636aa273d4ff86714a3e782` |
| `src/core/sortable-surface.ts` | `SORTABLE_METRIC_KEYS` (5 keys) | `Sovereign-Communication/civicscope` at `3aa7e10dc59e764a8636aa273d4ff86714a3e782` |
| `src/core/civicscope-registry.ts` | Same 15 + 5 keys, as the House layer's registry module | Pre-existing copy of the two files above, labelled as such in its own header; ported byte-faithful from the contest workbench, and pinned against drift from the registry above by `tests/contest-registry-pin.test.ts` |

`tests/contest-registry-pin.test.ts` pins both key sets exactly, so any
drift in the registry on the contest branch fails the suite instead of
slipping into the submission as an unrecorded change.

Everything else on `main` at the same source SHA is likewise pre-existing:
the registry is called out here because the contest work builds directly
on it.

## Built during the contest

The House work (Ask, Explain, the numeral-provenance validator, the meter
and proxy, the harness fixtures and golden corpus, the disclosure text,
and the provider interface) is tracked as port issues #33-#40. Each item
is recorded in this manifest when its pull request lands on the contest
base branch (`contest/house-port`), with its pull request number.

| Issue | Item | Status |
| --- | --- | --- |
| #33 | Registry, labeled pre-existing | Landed, PR #41, merged at 191d0288 |
| #34 | Ask surface, text only | Components, PR #45, merged at db2b191f: intent-edit, AskPanel, IntentEditor, IntentChips, ClarificationPanel, FigureCard; Explore shell mount and stub-provider wiring, PR #50, merged at aab2c87 |
| #35 | Explain, capability only | ExplainBox + ExplainOnAsk (PR #45, merged at db2b191f), ViewFigure + views/spec-gap tests (PR #46, merged at cb811a53); validated runtime action and app wiring, PR [#52](https://github.com/Sovereign-Communication/civicscope/pull/52), merged at `cb87560f23f7c56a6a72bbc4d60bc5607f542eae`; [issue evidence](https://github.com/Sovereign-Communication/civicscope/issues/35#issuecomment-6487019606) |
| #36 | Validator (F4) | Landed, PR #44, merged at f7329a6a: src/core/ai/validator.ts, src/core/ai/intent-schema.ts (shared Ask foundation) |
| #37 | Meter and proxy (F0) | Landed: byo/meta-key/Byo UI (PR #45, merged at db2b191f); meter.ts + functions/api/muse routes (PR #47, merged at 097f1eff). Per-client cap supported in code, value unset (S10) |
| #38 | Harness fixtures and golden corpus | Landed, PR #48, merged at 27974649: harness.ts + derive/shift/no-shift/adversarial-drift/dependency-direction tests |
| #39 | Privacy and disclosure text | Landed, PR #48, merged at 27974649: privacy.ts + docs/privacy-workbench.md (DRAFT workbench copy) + privacy tests |
| #40 | Provider interface | Landed, PR #43, merged at 676cfd32: src/core/ai/provider.ts, src/core/ai/proxy-errors.ts |

## Submission scope

The submission is scoped to the House work only. This registry and the
rest of the pre-existing application are the pad the House builds upon;
they are not claimed as contest work in any submission material.

## Port queue status (2026-10-28)

Items #33-#40 are landed on this branch, with their issues closed and evidence
recorded. The #35 runtime wiring follow-up landed in PR #52 at
`cb87560f23f7c56a6a72bbc4d60bc5607f542eae`; issue #35 is closed with the
implementation and check evidence linked above. The port queue is complete;
the Pass 3 submission-readiness checklist remains to be recorded. Ported
test setup: jsdom 26.1.0 devDependency (the
workbench's jsdom 30 line cannot load on this repo's Node 20 CI) and
tests/**/*.test.tsx in the vitest include list.

Not ported, by recorded decision: the workbench onboarding files
(onboarding.ts, OnboardingWizard.tsx) - built in the workbench but in
no port issue and imported by nothing in the queue - and the workbench
planning documents (house-plan.md, civicscope-audit.md).

Pages Functions deploy wiring is demonstrated on a preview deployment
(`submission` branch, lane head `d4a7dc6`, 2026-10-30): all three
`/api/muse/*` routes answer from the served build, and the only missing
ingredient there is the shared key. Getting that build onto the production
alias still needs the owner's merge to `main` plus a manual `npm run deploy`;
see `docs/submission-path-deploy.md`. The per-client cap value remains S10 and
unset; the Explain claim count is S11/S12; the privacy copy above is a draft
pending final sign-off. The Ask shell mount and stub-provider wiring landed in
PR #50 at aab2c87.
