# Agent onboarding — run record (F5a)

This file is the record artefact for the agent-onboarding workflow
(`workflow.v1.json`, plan §6.2.5 / §6.5.4). A feature claim for agent
onboarding exists only when a completed independent run is recorded
here. Nothing in this file may be filled in by the workflow's author.

## Workflow under test

| Field | Value |
|---|---|
| Workflow artefact | `docs/agent-onboarding/workflow.v1.json` |
| Workflow version | 1.0.0 |
| In-app entry point | "Set up with your agent" (`src/ui/ai/agent-handoff.tsx`) |
| Paths covered | Census API key; personal Meta Model API key |
| Success proof | The app's own re-validation events only: `civicscope:census-key`, `civicscope:meta-key-changed` |
| Graph self-check | `tests/ai/agent-onboarding.test.tsx` (runs in `npm run verify`) |

## Independent run

## PENDING — NO INDEPENDENT RUN HAS BEEN PERFORMED

The independent clean-account run required by §6.2.5 has **not**
happened yet. A non-author must complete setup for a fresh user
following only the workflow artefact, and record the run in the table
below. Until a row exists there, agent onboarding is **not done**,
regardless of how well the workflow works for the author — and the
in-app handoff page says exactly that (run status: PENDING).

### How the cold run is performed (instructions for the non-author runner)

1. Use a clean account and a clean browser profile: no Census key, no
   Meta key, nothing in localStorage for the CivicScope origin.
2. Open the app's "Set up with your agent" entry point and follow
   **only** `workflow.v1.json` — no source code, no asking the author.
3. Run the Census path end to end. Run the Meta path too if a Meta
   account is available; if it is not, record that as a deviation
   rather than skipping silently.
4. At each named human-approval point, stop and obtain the fresh
   user's explicit approval before continuing, as the workflow says.
5. Confirm success the way the workflow defines it: by the app's own
   re-validation event for each key, visible in the app — never by
   the key itself, which must not appear in this record, in chat, or
   in any log.
6. Note every place the artefact was ambiguous, wrong, or silent —
   including any unexpected screen and whether the abort handoff
   landed at the equivalent manual step. Deviations are findings,
   not failures of the runner.
7. Append one row to the record table and fill the result fields.

### Record table (append-only)

| Date | Runner (non-author) | Fresh user | Workflow version | Census path | Meta path | Deviations / abort observations | Result |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | PENDING |

Result values: `complete` (both attempted paths finished, success
confirmed by the app events), `complete-with-deviations` (finished,
with findings recorded), `aborted` (a halt occurred — record where
and whether the manual handoff matched the equivalent step), or
`failed` (setup could not be completed from the artefact alone —
record why; that is a defect in the artefact, and the workflow
version must be bumped when it is fixed).
