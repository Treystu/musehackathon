# S12 voice ship-gate: cut record

Date: 2026-10-30. Issue: #61. Branch: `lane/submission` at `6ae16ea`.
Governing rule: the S12 voice ship-gate checklist is binary. Every criterion met
means voice may ship; any criterion unmet means voice is cut cleanly from
submission claims and the demo.

**Decision: voice is CUT.** This note records the criterion-by-criterion basis so
the decision can be re-checked rather than trusted.

## Criteria applied

Criteria 1-6 and 10 are the ones enumerated in issue #61. Criteria 7-9 are not
written down in any document in this repository or in the issue tracker available
to this lane, so they cannot be applied here; the outcome is already decided by
the enumerated criteria, all of which fail.

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Mic icon next to search, additive | NOT MET | No capture UI exists. `src/e2e/ask-shell.e2e.ts` asserts the count of buttons matching `mic|transcribe|record` is 0, and passes against the served build (3/3, 2026-10-30). |
| 2 | Editable transcript chips | NOT MET | No transcript is ever produced: `MuseProvider.transcribe` is not called by any client module, and the provider implementations refuse. |
| 3 | Low-confidence clarification | NOT MET | Depends on 2; no transcript exists to be uncertain about. |
| 4 | Follow-ups from voice | NOT MET | Depends on 2; the Ask surface is text-only by design. |
| 5 | Last-mile flush-out | NOT MET | Depends on 2. |
| 6 | Spoken numbers through the F4 validator | NOT MET | Depends on 2; no spoken number reaches the validator. |
| 7 | Not enumerated | NOT APPLICABLE | No text for this criterion exists in the repo or tracker. |
| 8 | Not enumerated | NOT APPLICABLE | Same. |
| 9 | Not enumerated | NOT APPLICABLE | Same. |
| 10 | Metered transcription through the proxy | NOT MET | `POST /api/muse/transcribe` exists and refuses with `503 {"error":"provider_down","detail":"transcribe shell: mic wiring is item 12"}`; no client path calls it, so nothing is metered in practice. |

At most the inert server route of criterion 10 exists. Under the binary rule that
is a cut, not a partial pass.

## What was scrubbed

Checked on 2026-10-30 with a case-insensitive repository search for `voice`,
`microphone`, `getUserMedia`, `speech`, `transcribe` and `audio` across source,
tests, `public/`, `README.md` and `docs/`:

- No product, portal, README or planning text claims voice. The only source
  mention is a comment in `src/core/ai/meta-client.ts` saying voice is cut.
- No microphone, recording or speech-capture code exists in `src/`.
- `Permissions-Policy` in `public/_headers` keeps `microphone=()`, so even an
  added script could not open a microphone.
- `tests/ai/ask-completion.test.tsx` asserts the rendered Ask HTML does not
  contain "microphone"; 19/19 tests pass.

Two artifacts do not exist yet and therefore cannot be scrubbed: the portal text
and the demo script belong to #64. The constraint is recorded here so #64 is
written text-only: **the Ask beat is typed, and no narration or caption may say
or imply that the product listens.**

## Owner-reserved item

Issue #61 notes that whether the organiser DM describing the layer as including
voice also gets a correction is an owner call (Q3). That decision is not made
here and is left to the owner; this record only states the product-side cut.

## What would have to change to reverse this

All ten criteria, including the three not enumerated here, would need to be
written down and met in code, with a served-build test proving each one. Until
then the cut stands, and any future voice claim is a claim without an artifact.
