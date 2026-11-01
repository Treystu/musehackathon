# AGENTS.md

Canonical working rules for coding agents on CivicScope.

Read this before changing anything. It is short on purpose — a long file of rules
is a file nobody follows. Where a rule exists because something here was measured
rather than believed, the measurement is stated, so the rule can be retired when
it stops being true.

The project's own position, from `GOVERNANCE.md`: claims here are enforced in code
rather than promised. A rule that is not checkable is not a rule, so most of what
follows is also a completion-gate check.

---

## 1. No weird characters

**Do not put emoji in shipped source.** `docs/` is exempt — planning documents are
agent-facing notes, and a checkmark in a status line there harms nobody.

Not a style preference. A screen reader announces `✅` as "white heavy check mark"
before it gets to the sentence, and this project treats WCAG 2.2 AA as a legal
requirement (ADA Title III), not a goal.

**Not emoji, and left alone:** `▲ ▼ ↕` (the sort indicators in
`src/ui/SweepTable.tsx`), arrows, and typographic characters like `± × § — ≥`.
`▲`/`▼`/`↕` are `aria-hidden` and paired with `aria-sort` on the header cell —
they are the only *visual* sort state a sighted reader gets. Do not delete them to
satisfy this rule.

**No mojibake and no byte-order marks, anywhere — including `docs/`.** On
2026-10-07 the maintainer found a broken middle dot on the live site: edits had
round-tripped source through a shell that decoded UTF-8 as Windows-1252, turning
every `·`, `—` and `±` in the affected files into two or three characters of
garbage, so the sort arrow drew as box-drawing noise where `▲` belongs. The same
round-trips left byte-order marks on eight files. Neither is emoji, so the emoji
check below saw nothing.

**The trap, so you can avoid it:** doing
`Get-Content -Raw | -replace ... | Set-Content -Encoding UTF8` in PowerShell 5.1
decodes UTF-8 as the local codepage and writes a BOM. Use the editor tools for
edits, or a Node script (`readFileSync(f, 'utf8')`) if a script is genuinely
needed — never a shell text pipeline.

**Enforced by:** `tools/completion-gate.mjs`, via `tools/emoji-scan.mjs` and
`tools/mojibake-scan.mjs`, pinned by `tests/emoji-scan.test.ts` and
`tests/mojibake-scan.test.ts`. Check your work with:

```
node tools/emoji-scan.mjs .
node tools/mojibake-scan.mjs .
```

The emoji scanner treats a pictograph as emoji only when it is actually rendered
as one — emoji presentation by default, or a following U+FE0F. That distinction is
deliberate and tested both ways; `↕️` (with the variation selector) is an emoji,
`↕` on its own is a sort indicator. The mojibake scanner is narrow in the same
spirit: it flags a UTF-8 lead byte decoded as cp1252 — `Â Ã â Å` immediately
followed by a cp1252 special — so a real `·` or `—` or a name like `Ângela` passes
- a double-encoded middle dot (a UTF-8 middle dot decoded as Windows-1252) does not. Both are pinned in both directions.

---

## 2. Traps that will silently waste your time

Each of these was verified against this tree, not inferred. None of them fail
loudly.

| Trap | What actually happens |
|---|---|
| `src/**/*.test.tsx` | **Never collected.** `vite.config.ts` includes `*.test.ts`, not `.tsx`. The file is not run, not failed, not reported. |
| Component unit tests | Impossible. Vitest `environment: 'node'`, and there is no jsdom, happy-dom or testing-library. Rendering assertions go in `src/e2e/*.e2e.ts` (Playwright). |
| `npm run test:a11y` | Does not exist. Accessibility is `npm run gate` against a served build. |
| `npm run verify` | Does not include E2E or accessibility. A green verify says nothing about either. |
| `npm run typecheck` | Writes 56 `.js` files next to every `.ts` source (`--noEmit false`), untracked and unignored. Delete them before committing. `npm run verify` does not have this problem. |
| Top-level `e2e/` | Never collected. Browser tests are `src/e2e/**/*.e2e.ts`. |
| `scripts/` | Does not exist. Generators live in `tools/` and are wired as npm scripts. |
| `ResolvedPlace` | Has `name` and `zip`, **not** `zcta` and `city`. See `src/core/types.ts`. |
| `selectPlace()` | Returns immediately without `zip` (`useHousingQuery.ts`). A suggestion with no ZIP is a silent no-op. |
| **No offline/external judgement calls.** | Do not hand a decision off to a skill, script, or outside command as if that were the analysis. The Jev pass for this project is run here in-session over the planning docs, with reasoning in [docs/jev-alignment-2026-10-16.md](docs/jev-alignment-2026-10-16.md) and executable work statuses in [docs/canon-work-mission.md](docs/canon-work-mission.md). If a choice is genuinely consequential and not resolvable from the repo, say so in prose rather than dispatching it. |

## 3. Conventions

- **Comments explain why, and record what was measured.** The house style is a
  comment naming the measurement and the defect it prevents. A comment restating
  the code is noise.
- **Never let a placeholder reach a user.** Census missing-value encodings
  (`-666666666` and friends) must parse to null and render as a labelled absence.
  `npm run gate` checks this.
- **`docs/jev-roadmap.md` is the single source of truth for phase status.** It is
  edited only *after* the evidence exists. Never write a status row describing
  work that has not happened.
- **Do not add a phase row, or claim a UX score, without measuring it.** Several
  rows in that roadmap were closed by measuring rather than reviewing, and the
  difference is the point of the file.
- **Keep planning decisions discoverable.** If a decision is worth keeping, it goes
  into a canonical doc (roadmap, governance, alignment pass, or audit), not into a
  throwaway scratch note.

## LANE PROTOCOL - all agent lanes, all sessions (added 2026-10-29)
1. ONE BRANCH, ONE CLONE. Work in the canonical clone only. Never create worktrees or scratch/backup branches. Your lane branch (THIS REPO line below) is the only branch you work on; it carries ONE standing DRAFT PR into the base - oversight's live view of all your work, WIP included.
2. PUSH MANDATE. If it isn't pushed, it doesn't exist. Commit + push incomplete work (prefix "wip:" + what state it's in) at every turn end, every sub-step, before any risky operation, and at least every 20 minutes. Never end a session unpushed. Before every push: git status - never commit secrets, API keys, .env files, private keys, credentials, build output, or binaries; if a file matters but can't be committed, leave it untracked and name it in your status comment. Never push main or the base directly. No force-push except --force-with-lease on your own lane branch, and never rewrite a commit a comment already references.
3. STEERING LOOP. At every turn start, and again after every push: read new comments on your draft PR, on every open PR you own, and on every issue you're working, plus newly filed issues. Comments from Treystu are authoritative directives (the owner and his oversight agent): they outrank your prompt and your plan; newest wins. Acknowledge each in-thread, do it, then reply with evidence (SHA, check-runs, test results). If one is ambiguous, ask ONE clarifying question in-thread and keep working on everything else.
4. STATUS + RESUME. End every turn with a status comment on the draft PR (mirror to the tracker in the THIS REPO line): DONE / WIP / NEXT / BLOCKERS / DIRECTIVES, with SHAs. Resume from GitHub alone: fetch, read the latest status comment + every newer Treystu comment, verify lane-branch HEAD matches the status SHA. GitHub beats local state and local notes, always.
5. LANDING + GATES. Work reaches the base only under your tasking's merge rules (green + verified + non-destructive; CI from check-runs, never the combined status; revert first if a landing turns the base red). WIP on the lane branch may be red - say so in the commit message. Lucas Gate v2 first, Jev for decisions/dispositions, on every comment, review, and disposition you post. No emoji in repo content.
THIS REPO: lane branch lane/workbench; base main; status comments go on the civicscope issue currently under work. (Union tree: this repo is the Entire musehackathon repo; the CivicScope project rules above govern the app code that lives here now — hand-merge, Panel B1.)
