# STATUS-HM — Hail Mary quality lane

Branch: `lane/hail-mary`. Base: `origin/main` at `728801b` (Radius cure round 2, production pin per steering).
Discipline: one item per commit series, `hail-mary H<n>:` prefix; suite (`npx vitest run`) + golden replay (`node tools/ai-eval/run-golden.mjs`) green at every push; `npx tsc --noEmit` clean; emoji/mojibake scans clean.

## H1 — W4 answer-only presentation
Status: DONE (this push).
Cure: Ask view answer-only — in-answer map behind collapsed `Show the map` disclosure (state-gated mount, no paths until expanded); data section behind collapsed `Explore the full results` disclosure when a composed answer lands for the current generation (`askAnswerVisible`), with `SweepTable`/comparisons/briefing gated on expansion; manual Explore (no landed answer) keeps full renders; Map tab untouched. Reworded the two pointers to name the expansion (`open 'Explore the full results' to see them`) in `AnswerCard` overflow + `ResultMap` name list (+ matching failure lines in `ResultMap`/`GateStatesMap` for consistency).
Pins: `tests/ai/hail-mary-h1.test.tsx` (labels, overflow copy, map collapsed no paths + expansion reveals); updated `result-map.test.tsx` failure lines, `breadth-map-ui.test.tsx` (expand map disclosure), `ask-reset-lockout.test.tsx` (expand data disclosure for briefing, verify reset still clears after expansion).
Evidence: `npx vitest run` 202 files / 2176 tests green; golden replay exactIntent 91/91 safety 7/7; `npx tsc --noEmit` exit 0; emoji 0 / mojibake 0.

## H2 — W3 labeled reset + input persistence
Status: DONE (this push).
Cure: visible `Start over` in Ask surface (`START_OVER_LABEL`) calling `resetAskSession` (panel + answer + stage) plus App `onStartOver` clearing screens (deselect all, filters, preliminary, mode ask, close data disclosure); AskPanel mount condition widened to `(mode === 'ask' || askAnswerVisible)` so the input survives the sweep mode-switch (fix at mount, no duplicate input).
Pins: `tests/ai/hail-mary-h2.test.tsx` (reset clears store; Start over visible + clears; input present after sweep terminal). Full suite + golden re-verified green before push.

## H3 — W1 chained refinement
Status: DONE (this push).
Cure: `fragment-carry.ts` — standing screen from last answer request; `isFragmentFollowUp` lexical gate (standing + criteria-only signals, fresh names pass through); `mergeFragmentIntent` carries geography/measure/filters (union, no silent drops) before completions/handoff/radius/execution; slots filled with standing hints (existing contract). Stated radius routes via existing `detectRadiusFrame` on the merged intent. `RefinementChips` on AnswerCard show carried criteria (criterionEvidence) as removable chips (display-level removal; re-screen via new ask).
Pins: `hail-mary-h3.test.tsx` (gate fresh vs fragment; merge carries; Colorado → Walmart chain with slots + superseded request; chips visible + removable). Suite neighbors 34/34 + golden 8/8 green; tsc clean.

## H4 — W2 uncatalogued criteria + bare-near distance
Status: QUEUED.
Plan: generic proximity criterion in decision catalog + deterministic unstated-distance proposal modal; stated distance used as stated. Pins: uncatalogued specimen reaches modal; bare-near proposes; stated used.

## H5 — stretch residuals
Status: QUEUED (only after H1–H4 pushed green).
(a) Guided-tour Skip keyboard/AT activation. (b) `hourglassLastSettle.bottom` settle write path; if structural, write trace and stop.

## Blockers / notes
- `node_modules` in this tree is a tracked pointer file (`/home/hatch/workspace/musehackathon-union/node_modules`); local `npm install` needs the directory. Do not commit the pointer deletion. See commit message for handling.
- Full suite runtime ~65s; golden ~1s. No live probing, no deploys, no main pushes.
