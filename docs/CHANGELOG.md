# Change and incident record

`docs/governance.md` commits the project to publishing a history, so that
"verified" has a record rather than being a claim about the current state only.
This is that record. One entry per change that altered what a reader sees, what
a claim relied on, or what the gate enforces — with the finding that prompted it,
because the findings are the part a future maintainer cannot reconstruct from a
diff.

Ordered newest first. Commit hashes are the squash merges on `main`.

## 2026-10-16

**Audit reconciliation: align visible behavior, source claims, and the canonical plan.**
The ACS variable itself used occupied housing units, but the methodology lookup still
pointed households to B25001 (all housing units). It now points to B25002, with an
explicit regression assertion. The national table previously fell back to a rent-burden
sort even though governance described no default metric order; it now starts by ZIP code,
and each optional sort is named after its figure. Selected areas now have a shared
comparison matrix limited to a matching publisher, dataset, table, unit, and vintage.
Similarity search remains opt-in and alphabetic; it now shows labeled origin figures and
discloses its equal starting weights and 0.10 cutoff. Fair Housing copy and methodology
describe these actual controls, the limited affordability index, browser storage, and
official HUD/DOJ routes. The school-source description now matches the current code:
NCES district staffing/enrollment, plus NYC DOE named-school data. NYC dataset terms
remain unresolved, so no license is claimed. The canonical backlog and design record now
own status and evidence.

Verification: `npm run verify` passed (333 tests and production build); emoji and
mojibake scans reported 0 findings. Browser smoke, city-search, tour, and axe checks
passed against the local preview. The larger live browser run was stopped after three
minutes before all keyless/live geocoding scenarios completed; Census-key-dependent
national-sweep scenarios were skipped because no key was configured. No roadmap phase
was closed by this entry.

## 2026-10-09

**Four mislabelled figures, found by a reader comparing the map against the drilldown.**
The reader asked why the map showed 45 for five areas whose household figures
are 9, 30, 45, 64 and 2,086. The answer to *that* question is by design — 45 is
the median, so Valentine's 2,086 cannot dominate its rural neighbours — but the
hover never said so, and it now does. Checking the rest of that reader's screen
against the publisher's own variable definitions found four figures that were
not what their labels claimed, in every area of the country, some since the
first version:

- **"Expenditure per pupil $62" was the teacher count.** The NCES EDGE layer
  publishes no finance field at all; the metric read `TOTTCH` under a dollars
  label, and because the education composite weighted it 0.6, every district in
  the country scored exactly 40 on that index. The metric is now the teacher
  count, labelled as the teacher count; the education composite is **removed
  rather than reweighted** — a one-component composite is not a composite, and a
  fabricated input is not a weight. It can return when a real finance source
  (the Census school system finances survey) is wired in.
- **"Households 2,086" was total housing units.** `B25001_001E` includes vacant
  homes; for 69201, owner 995 + renter 626 + vacant 465 = 2,086, displayed as
  households with a note claiming "all occupied". Now `B25002_002E`, occupied —
  and the sum checks.
- **"Mean commute 1,861" (Valentine) was a worker count.** Two drafts of this
  variable were wrong in different directions: first `B08301_001E` (all workers)
  named "meanCommuteMinutes", then a 2026-10-08 "correction" to `B08303_001E`
  believing it the published mean — it is the commuting-worker total. The
  publisher has no mean in this table family; the metric is now the published
  count under an honest label.
- **"No internet subscription 0" was dial-up households.** `B28002_003E` is
  "dial-up with no other type" — a handful of homes everywhere — while the
  label promised households with nothing at all. Now `B28002_013E`, "No
  Internet access".

A district's school count was also being suppressed to "not published" by the
minimum-20 rule meant for small samples about people — a district with 3 schools
is an exact administrative fact — so institution counts now carry their own
`institutions` unit outside that rule.

The sweep stamp moves to v7: three variables changed meaning under the same
metric keys, so cached rows would render the old meanings under the new labels
forever. One full refetch is the honest cost, and it is paid once.

**How it was found is the lesson:** three of the four came from a reader's
question, and the method that confirmed them — reading the publisher's own
variable definitions instead of trusting the code's comments — is the same one
that found the mojibake and the sort-arrow corruption. Two comments in the
source were confidently wrong ("B25001, not B25002"; "mean travel time"), and
each guarded a mislabel that had shipped. The completeness test family now pins
the correct columns, and the gate fails any monetary metric in a plugin whose
source publishes no finance fields.

**`42499bc` — Skip the warm-cache contract without a Census key (#25).**
A CI runner made two saves 0ms apart; the newest-first assertion failed because
the store broke `savedAt` ties by random id tail. The sort is stable and stored
order is newest-first by construction, so ties now keep save order, pinned by a
test that freezes the clock to force the tie — otherwise it passes vacuously on
any runner slower than a millisecond, which is how the bug shipped green
locally.

## 2026-10-08

**`2735a83` — Share exactly what you see: the comparison travels in the URL (#22).**
`?z=` carries the selected ZIP codes and nothing else — no sort, no preset —
because a link that encoded how to look at data would be a recommendation, not a
view. Hand-edited parameters are validated on arrival; malformed entries are
dropped silently. `history.replaceState`, so adding an area adds no back-button
entry.

**`d2820da` — Retry the SEO generator's TIGERweb pages (#23).**
A push-to-main run failed six gate checks; five were cascade from one dropped
TIGERweb connection in `gen-seo.mjs`. The map generator had retried that exact
documented failure mode since it was written; the SEO generator had not.

## 2026-10-07

**`ea7a11d` — Repair the mojibake I shipped, and prompt a first-time visitor for a key (#21).**
Two maintainer reports, both real. First: a broken middle dot on the live site —
my own edits had round-tripped source through a shell decoding UTF-8 as
Windows-1252; the emoji scanner could not see it, because mojibake is not emoji. Repaired by reversing the
double-encoding; `tools/mojibake-scan.mjs` now catches it in both directions, and
`AGENTS.md` documents the pipeline that caused it. Second: the site never asked a
new visitor for an API key — the mount effect only ran the load with a key already
present, so every `needs-key` branch was unreachable. The load now runs on arrival
and the prompt opens once, without stealing focus.

**`f911a1e` — Record the maintainer's stewardship decisions (#18).**
GitHub is where the project lives; personal payment routes are the chosen design.
Both were listed as open weaknesses; the maintainer reviewed and accepted both,
and the record now says decided rather than pending.

**`b249a52` — Fail the gate when production serves an older build than main (#20).**
The maintainer reported the site "regressed: no data, map not loading." Production
was serving a build from before ten merged PRs, and the gate reported it fresh:
the freshness layer checked for markers fixed in history, which a very old build
still contains. On push-to-main, the deployed bundle must now equal the bundle CI
just built. That day it failed in CI as designed, a deploy made it green, and a
docs-only merge after it passed without a deploy because its hash was unchanged —
the check demanding a deploy exactly when one is needed.

**`2425567` — An unreachable upstream is not a place with no district (#19).**
Three live-contract failures on a single NCES blip, each reading
`expected 'not-found' to be 'district'` — indistinguishable from drift. The
plugin folded every upstream error into `not-found`, for users and for the retry
wrapper, which had nothing to catch. `unavailable` is now its own kind, retried
in tests, and surfaced as a source failure rather than an absence.

## 2026-10-06

**`e09cd4d` — Similar-ZIP search: off by default, reader-weighted, alphabetical (#17, Phase 2B).**
Approved without legal review, by maintainer decision: the mitigation is the
default. A similarity result is a ranking, so it exists only when asked for;
weights are the reader's, drawn from the sortable allowlist so no
protected-class measure can be weighted; results are alphabetical with the
distance shown. The plan's 0.5-1 MB baked payload was dropped — the sweep is
already in memory, so the feature added zero bytes.

**`325561f` — Score the product, not its URL (#16).**
The original request asks for "a selected domain", and the selected domain is the
deployment address. The Jev layer's persistent `domain` flag (0.45, top unmet
requirement) was the repo's own evidence describing a met requirement as open.
Corrected in three places; the flag collapsed to 0.01. Nothing was claimed beyond
what is true.

**`a340507` — Let a reader keep the data: CSV export (#14).**
Raw numbers, not formatted strings; empty cells for missing figures, not "N/A"
(which would force the column to text in every tool); OWASP formula-injection
guarding, pinned by test — the kind of defence that gets removed as "unnecessary
quoting" by someone who never saw the attack.

**`ebd5f6a` — Figure filters, and school/health can never be filtered on (#15, closes #5).**
Rent, burden, home value, households — drawn from the same allowlist as the sort
columns, so a demographic filter is a compile error. Rows with no figure for an
active bound are excluded, visibly, because a bound is a question and an area
with no figure is not an answer to it.

**`66e37ef` — Make the protected-class rule mechanical (#13, closes #11).**
`types.ts` called it "the single most important rule in the codebase" while no
plugin set the flag and nothing read it — the guarantee held only because nobody
had wired a demographic metric into a column list yet. Now: the executor stamps
it centrally, CDC PLACES health measures carry it, the composite scorer refuses
it, and sort columns and filters are typed against one allowlist.

## 2026-10-04

**`8786052` — Wire the donation route, drop a false attorney claim, enforce no emoji (#10).**
Three claims that did not match reality. The funding section was built around a
collective slug that was never set — wired to the author's three direct routes,
with the weaker guarantee (funds reach an individual; the balance is not public)
disclosed on the page rather than glossed. `GOVERNANCE.md` claimed a fair-housing
attorney had reviewed the scoring modules; no attorney ever had, so the sentence
was deleted, not softened. And a checkmark in a status line is announced by a
screen reader as "white heavy check mark" before the sentence — the no-emoji rule,
now a scanner and a gate check.

**`b945d1c` — Phase 0: city search, and every ZIP code named with the place it is in (#12).**
Baked from the Census relationship files; a search contacts nothing off-origin.
Three data defects found by reading the publisher's files rather than the code:
`AREALAND_PART` is column 16, not 17 (17 is water, and measuring it implied
4,084 ambiguous ZIPs where the true count is zero); legal-type stripping is
case-sensitive (`Salt Lake City city`); and there are places genuinely named after
counties. A modal on first visit covered the search box — found by the browser
suite failing 22 tests, redesigned to a non-modal notice.

**`99624e7` — First-run orientation (#7, Phase 1).**
The plan's sample-data component was rejected by maintainer decision: the
platform ships no data, the visitor's key unlocks it. The tour states the limit
rather than hiding it. A focus-trap test failed on a WCAG rule that does not
exist — Tab passes through `<body>` at the wrap boundary; the test now asserts the
property that matters.

## Standing position

No attorney has reviewed this project and none is planned; `GOVERNANCE.md` says
so. Deployments are manual (`npm run deploy`), and the gate fails push-to-main CI
until one runs — the alarm that caught the ten-merge drift. The deterministic gate
is the completion contract: `npm run gate`, currently **89/89**.
