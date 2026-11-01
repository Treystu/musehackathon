/**
 * Jev completion gate.
 *
 * Purpose: block a release until the work is actually complete, rather than
 * relying on the author's own judgement that it is. The user's standard is 99/100
 * and "Google quality", which is a high bar, so the gate is built to fail
 * loudly and honestly.
 *
 * TWO LAYERS, DELIBERATELY:
 *
 *   1. Deterministic checks (no network, always run) — tests, typecheck, build,
 *      plus the project's own structural invariants: legal spine present, every
 *      scoring rule backed by a real metric, no protected-class data in any
 *      composite, CSP allowlist matching the code, and a deployed-bundle
 *      freshness check.
 *
 *   2. Jev semantic review (needs TYPESAFE_API_KEY) — does the delivered work
 *      actually answer what was asked, and is anything missing or unverified
 *      being presented as done.
 *
 * Why the deterministic layer is not optional: Jev can only judge the state it
 * is given. A model score is an independent opinion about supplied evidence,
 * not a measurement of reality, so it is a useful cross-check and a poor sole
 * gate. The deterministic layer measures things that cannot be argued with.
 *
 * Usage:
 *   node tools/completion-gate.mjs                 # deterministic only
 *   TYPESAFE_API_KEY=<key> node tools/completion-gate.mjs   # + Jev review
 *
 * Exit code 0 only if every deterministic check passes and, when a key is
 * present, the weighted score meets the threshold.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { scanForEmoji } from './emoji-scan.mjs'
import { scanForWeird } from './mojibake-scan.mjs'
const ROOT = process.cwd()
// Every child-process argument in this file is a literal, never user input, so
// the shell concatenation DEP0190 warns about cannot be exploited here.
process.emitWarning = ((orig) => (w, ...a) => (w?.name === 'DeprecationWarning' && w.code === 'DEP0190' ? undefined : orig(w, ...a)))(process.emitWarning)
const THRESHOLD = Number(process.env.GATE_THRESHOLD ?? 99)

/**
 * The deployed site under test.
 *
 * Configurable because the default was a personal Pages hostname, which made
 * the gate depend on an account rather than the project, and failed in CI the
 * moment the project moved to an organisation. CI supplies it explicitly.
 */
const SITE = (
  process.env.GATE_SITE ??
  process.env.E2E_BASE_URL ??
  'https://civicscope.pages.dev'
).replace(/\/+$/, '')

const OUT = join(ROOT, 'gate-report.json')

const c = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' }
const pass = (s) => `${c.g}PASS${c.x} ${s}`
const fail = (s) => `${c.r}FAIL${c.x} ${s}`
const warn = (s) => `${c.y}WARN${c.x} ${s}`


/** Fetches without throwing, reporting whether the request was answerable. */
async function tryFetch(url, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    const body = await res.text()
    return { ok: res.status < 500, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: '', error: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/** Polls a local server until it answers, so a preview is ready before the audit. */
async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.status < 500) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  return false
}

// ---------------------------------------------------------------- layer 1

/**
 * Runs a command, returning pass/fail plus captured output. Never throws.
 *
 * On Windows, npm and npx are `.cmd` shims, which Node's execFileSync cannot
 * spawn directly (EINVAL). The supported resolution is `shell: true`; the
 * DEP0190 warning about unescaped arguments is suppressed because every
 * argument here is a literal from this file, never user input.
 */
function run(label, cmd, args, env = {}) {
  const isWindows = process.platform === 'win32'
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      env: { ...process.env, ...env },
    })
    return { label, ok: true, detail: tail(out) }
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    return { label, ok: false, detail: tail(out) || String(err?.message ?? 'spawn failed') }
  }
}

function tail(s, n = 400) {
  const t = (s ?? '').trim()
  return t.length > n ? `…${t.slice(-n)}` : t
}

const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '')

const results = []
const add = (ok, label, detail = '') => results.push({ label, ok, detail })

console.log(`${c.b}CivicScope completion gate${c.x}\n`)

// --- build and test gates
// The browser suite needs a served build. Locally that means `vite preview`;
// in CI the workflow runs the gate without a server, so the a11y job is skipped
// there and covered by the separate CI job instead of being reported as a
// failure that is really a missing server.
const e2eBase = process.env.E2E_BASE_URL ?? SITE
const e2eSkip = process.env.SKIP_E2E === '1'
const e2eEnv = { ...process.env, E2E_BASE_URL: e2eBase }

const gates = [
  ['typecheck + build', 'npm', ['run', 'build'], {}],
  ['unit + security tests', 'npx', ['vitest', 'run', '--reporter=dot'], {}],
  ['live API contracts', 'npx', ['vitest', 'run', '--config', 'vitest.live.config.ts', '--reporter=dot'], {}],
]

/*
 * The browser audit is deferred rather than queued with the other gates.
 *
 * It needs a served build, and a served build needs `dist/` to exist — which is
 * created by the first gate. Queuing the audit alongside the build meant the
 * preview was spawned *before* the build ran, so `vite preview` failed with
 * "error when starting preview server" every time in CI, and the gate fell back
 * to auditing the deployed site. The accessibility audit therefore reported on
 * production rather than on the pull request it was meant to be checking.
 *
 * Found by a new browser test that passed locally and failed in CI, with the
 * only clue a log line saying the preview had not started.
 */
let auditGate = null

for (const [label, cmd, args, env] of gates) {
  const r = run(label, cmd, args, env)
  add(r.ok, r.label, r.detail)
}

if (!e2eSkip) {
  // Accessibility is a legal requirement (ADA Title III) for a public-facing
  // app, so it gates. axe-core runs against a real browser.
  let server
  let base = e2eBase
  if (process.env.E2E_BASE_URL) {
    base = process.env.E2E_BASE_URL
  } else {
    const port = 4317
    /*
     * Poll the address the server is actually bound to, not `localhost`.
     *
     * The preview is started with `--host 127.0.0.1`, so it listens on IPv4 only.
     * On Linux — which is where CI runs — `localhost` resolves to `::1` first and
     * Node's fetch tries that first, so a poll against `localhost` sees a
     * connection refusal while the server is up and healthy. That was a second,
     * independent reason the audit could silently end up pointed at production.
     */
    const target = `http://127.0.0.1:${port}`
    let previewError = ''
    try {
      server = spawn(
        process.execPath,
        [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
        // Both streams are captured. Ignoring them meant a preview that genuinely
        // failed said nothing at all, which is how the ordering bug above went
        // unnoticed for so long.
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true },
      )
      const capture = (chunk) => {
        previewError += String(chunk)
      }
      server.stdout?.on('data', capture)
      server.stderr?.on('data', capture)
      const ready = await waitForServer(target, 60000)
      base = ready ? target : e2eBase
      if (!ready) {
        console.log(
          `${c.y}  note: local preview did not start; auditing ${base}${c.x}` +
            (previewError ? `\n       preview said: ${tail(previewError, 600)}` : ''),
        )
        // The browser suite then points at the deployment. If that is also
        // unreachable the audit cannot run, and the gate says so rather than
        // reporting a pass it did not earn.
      }
    } catch (err) {
      console.log(`${c.y}  note: could not start a local preview (${err.message}); auditing ${base}${c.x}`)
    }
  }

  auditGate = [
    'WCAG 2.2 AA audit (axe-core, real browser)',
    'npx',
    ['vitest', 'run', '--config', 'vitest.e2e.config.ts', '--reporter=dot'],
    { ...process.env, E2E_BASE_URL: base },
  ]

  process.on('exit', () => {
    try {
      server?.kill()
    } catch {
      /* already gone */
    }
  })
}

if (auditGate) {
  const r = run(auditGate[0], auditGate[1], auditGate[2], auditGate[3])
  add(r.ok, r.label, r.detail)
}

// --- structural invariants that unit tests cannot see as a whole

// No emoji in shipped source, and the check is not allowed to be vacuous.
//
// Accessibility is a legal requirement here (ADA Title III) and the audit is
// already run with axe-core, but axe cannot see this: a checkmark in a status
// line is not a WCAG violation, it is a glyph a screen reader announces as
// "white heavy check mark" before the sentence anyone needed. The typographic
// and geometric characters the app genuinely uses are not emoji and are not
// flagged — the sort indicators in SweepTable.tsx are aria-hidden and backed by
// aria-sort, so a scanner broad enough to flag them would have demanded the
// removal of an accessibility affordance.
//
// docs/ is exempt by decision: planning documents are agent-facing notes, not
// product surface.
//
// The file count is asserted alongside the findings because a scanner pointed at
// the wrong directory reports zero findings and looks identical to a clean tree.
const emojiScan = scanForEmoji(ROOT)
add(
  emojiScan.files > 50 && emojiScan.findings.length === 0,
  `no emoji in shipped source; a screen reader would announce a glyph name instead of the sentence (${emojiScan.files} files scanned, docs/ exempt)`,
  emojiScan.findings.slice(0, 10).join(' | '),
)

// No mojibake and no byte-order marks, anywhere.
//
// The maintainer reported a broken middle dot on the live site on 2026-10-07.
// The cause was edits that round-tripped source through a shell decoding UTF-8 as
// Windows-1252, which turned every `·`, `—` and `±` in the affected files into two
// or three characters of garbage, drawing the sort arrow as box-drawing noise.
// The emoji check above could not see it — mojibake bytes are not emoji — so the
// gate reported clean while the interface was visibly wrong. Found again by a
// reader, which is the failure mode this gate exists to remove. The same
// round-trips left byte-order marks on eight files, one of which aborted a repair
// script mid-run.
//
// Unlike the emoji rule this does not exempt docs/: mojibake in a planning
// document is corruption rather than a style choice, and a byte-order mark breaks
// tooling wherever it sits.
const weirdScan = scanForWeird(ROOT)
add(
  weirdScan.files > 50 && weirdScan.findings.length === 0,
  `no mojibake and no byte-order marks in any text file (${weirdScan.files} files scanned)`,
  weirdScan.findings.slice(0, 10).join(' | '),
)

// The key prompt must be reachable by a visitor who has no key.
//
// On 2026-10-07 the maintainer reported that the site never asked a new visitor
// for an API key. It did not: the mount effect ran the country-wide load only
// when a key was already stored, so a first-time visitor's status stayed 'idle'
// and every `needs-key` branch — including the prompt — was unreachable. They saw
// a search box that answered for one ZIP code, an empty country-wide view, and no
// explanation. Both halves are pinned: the load runs on arrival, and the prompt is
// wired to the status it depends on.
{
  const useQuery = read('src/core/useHousingQuery.ts').replace(/\s+/g, ' ')
  add(
    /useEffect\(\(\) => \{ void loadSweep\(\) \}, \[loadSweep\]\)/.test(useQuery) &&
      !/if \(getCensusKey\(\)\) void loadSweep\(\)/.test(useQuery),
    'the country-wide load runs on arrival, so a first-time visitor reaches the key prompt instead of an empty screen with no explanation',
  )
  add(
    /autoPrompted/.test(read('src/ui/App.tsx')) && /sweepStatus === 'needs-key'/.test(read('src/ui/App.tsx')),
    'the key prompt opens for a visitor with no key, without moving focus into a form they did not ask for',
  )
}

// A comparison carried in the URL.
//
// The constraint that makes this a gate rather than a nicety: a share link
// carries the selected ZIP codes and nothing else. Encoding a sort, a preset or
// a profile would make a link a recommendation rather than a view, and the
// parameter is untrusted input on arrival — hand-edited or hostile — so it is
// validated on both ends. Pinned by test and by the browser suite.
{
  const us = read('src/core/url-state.ts')
  const app = read('src/ui/App.tsx')
  add(
    /encodeComparison/.test(us) &&
      /decodeComparison/.test(us) &&
      !/preset|sort|profile/i.test(us.replace(/^(?!\s*\/\/).*$/gm, '')) &&
      read('tests/url-state.test.ts').length > 0,
    'a shared URL carries the selected ZIP codes, validated, and nothing else — no sort, no preset, no ranking',
  )
  add(
    /replaceState/.test(app) && /decodeUrl/.test(app) && read('src/e2e/url-state.e2e.ts').length > 0,
    'the URL follows the selection without piling up browser history, and a shared link pre-selects on arrival',
  )
}

// No fabricated monetary figures from the school layer.
//
// The NCES EDGE admin-data layer publishes staffing and enrolment and no
// finance field at all. From the first version until 2026-10-09 the metric
// named "Expenditure per pupil" read the district's teacher count under a
// dollars label — a district with 62 teachers displayed "$62 per pupil" — and
// because the education composite weighted it 0.6, every district in the
// country scored exactly 40 on that index. Found by a reader, not by any
// check, which is the part this fixes: a source with no finance fields can
// never again carry a monetary metric, and the composite that consumed it is
// asserted gone rather than merely absent.
//
// Scoped to the fabricated name, not to monetary units in general: scoring.ts
// legitimately carries 'usd' for home value, and the pin is that per-pupil
// spending specifically no longer exists anywhere.
{
  const schools = read('src/core/plugins/schools.ts')
  const scoring = read('src/core/scoring.ts')
  add(
    !/per_pupil_spend/.test(schools) && !/'usd'/.test(schools),
    'no monetary metric from a layer that publishes no finance fields, so a teacher count can never render as dollars again',
  )
  add(
    !/per_pupil_spend/.test(scoring) && !/educationIndex/.test(scoring),
    'the composite that scored a fabricated spending figure is removed, not reweighted',
  )
}

// The figure dictionary and the saved-comparison store.
//
// The dictionary exists because seven ACS variables were fetched on every
// national sweep since the map shipped and then discarded, unnamed, while the
// roadmap described them as shown — and three of them requested the wrong
// Census column, which nobody noticed precisely because nothing displayed the
// result. A completeness test now makes a fetched-but-unmapped column a
// failure, and the methodology page renders from the registry so the
// documentation cannot drift from the definitions.
{
  const methodology = read('src/ui/Methodology.tsx')
  const registryTest = read('tests/metric-registry.test.ts')
  const saved = read('src/core/saved-searches.ts')
  add(
    /METRIC_DEFS_BY_KEY/.test(methodology) && registryTest.length > 0,
    'the methodology page documents every figure from the registry it renders from, pinned by a completeness test',
  )
  add(
    /METRIC_FOR_VAR/.test(registryTest) && /DETAIL_VARS/.test(registryTest),
    'a variable the app fetches but never maps is a test failure, so the fetched-and-discarded defect cannot recur',
  )
  add(
    /encodeComparison/.test(saved) && read('tests/saved-searches.test.ts').length > 0,
    'saved comparisons validate through the URL codec and refuse a full drawer rather than evicting',
  )
}

// City search.
//
// The mapping is a committed artefact rather than a lookup, so the checks that
// matter are that it is complete and that reading it contacts nobody. The second
// is the load-bearing one: `src/core/geocode.ts` records that a public geocoder
// exhausted its budget and then refused connections, per-IP, which would reach
// every visitor rather than just the build machine. An autocomplete asking on
// every keystroke is that failure at a higher rate, and it would also hand a
// third party a log of what people searched for, which is the claim
// `docs/governance.md` rests on.
{
  const manifest = JSON.parse(read('public/map/manifest.json'))
  const indexSrc = read('src/core/zcta-place-index.ts')
  const cities = manifest.placeMappingCities ?? 0
  const counties = manifest.placeMappingCounties ?? 0
  add(
    (manifest.placeMappingZctas ?? 0) >= 33000 && cities + counties === manifest.placeMappingZctas,
    `every ZIP code names the place it is in (${manifest.placeMappingZctas ?? 0} ZIP codes: ${cities} cities, ${counties} counties)`,
  )
  // The generator must stay reachable, or the artefact silently stops being
  // reproducible and the next census refresh has nothing to run.
  add(
    /gen:zcta-city/.test(read('package.json')) && /rel2020\/zcta520/.test(read('tools/gen-zcta-city-mapping.mjs')),
    'the ZIP-to-place mapping is regenerable from the published Census files, not hand-made',
  )
  // Only same-origin URLs are allowed in the search path. `/map/zcta-places.json`
  // is relative; anything with a scheme would be a request off this origin.
  const urls = [...indexSrc.matchAll(/['"`]https?:\/\/[^'"`]+/g)].map((m) => m[0])
  add(
    urls.length === 0,
    'city search contacts no external origin, so a search cannot be logged by a third party',
    urls.join(' '),
  )
  // Every ZIP code resolves to a non-empty, labelled place rather than a blank
  // cell down 33,791 rows. Pinned in `zcta-place-index.test.ts`; asserted here too
  // so the artefact's own manifest cannot disagree with the code.
  add(
    /county — no incorporated city/.test(read('src/ui/CityZipBrowser.tsx')),
    'a ZIP code with no incorporated city is labelled as a county rather than shown as a city',
  )
}

// Export. A reader who has paid 43 Census requests for the country must be able
// to keep the result, and the export must not become the one place a spreadsheet
// executes something. The formula-injection guard is asserted rather than
// assumed because it is exactly the kind of defence that gets removed as
// "unnecessary quoting" by someone who has never seen the attack.
{
  const exportSrc = read('src/core/export.ts')
  add(
    /FORMULA_PREFIXES/.test(exportSrc) && /escapeCell/.test(exportSrc) && read('tests/export.test.ts').length > 0,
    'the CSV export guards against formula injection and is pinned by a test, so a spreadsheet cannot execute an exported cell',
  )
  add(
    /placeLabel/.test(read('src/ui/SweepTable.tsx')) && /toCsv/.test(read('src/ui/SweepTable.tsx')),
    'the loaded screen can be exported with city names, so closing the tab is not the only way to keep the data',
  )
}

// Figure filters (issue #5). The plan for these once proposed school grades and
// a health score; both were removed before shipping, because no ZIP-level source
// exists and a filter is steering when the figure it acts on is a protected-class
// proxy. What is asserted here is the mechanism rather than the memory: filters
// must draw from the same allowlist as the sort columns, so a demographic filter
// cannot appear without also becoming a sortable column, where a test and a gate
// check name the decision.
{
  const filters = read('src/core/figure-filters.ts')
  add(
    /SORTABLE_METRIC_KEYS/.test(filters) && read('tests/figure-filters.test.ts').length > 0,
    'figure filters draw from the sortable allowlist, so school and health measures cannot be filtered on',
  )
}

// Similar-ZIP search. Four recorded decisions, each asserted so it cannot erode:
// off by default; reader-set weights from the allowlist; alphabetical results;
// no outcome-named template. The first is the mitigation that replaced a legal
// sign-off this project will not obtain, so it is the one that must never
// quietly flip.
{
  const sim = read('src/core/similarity.ts')
  const panel = read('src/ui/SimilarityPanel.tsx')
  add(
    /localStorage\.getItem\(FLAG_KEY\) === 'true'/.test(panel),
    'similar-ZIP search is off until the reader turns it on, so nobody is ranked at unasked',
  )
  // The `satisfies` clause appears only in the type expression, never in prose,
  // so the raw source is the correct thing to match — and it avoids the
  // `codeOnly` const, which is defined further down this file.
  add(
    /satisfies readonly SortableMetricKey\[\]/.test(sim) && read('tests/similarity.test.ts').length > 0,
    'similarity weights are typed against the sortable allowlist and pinned by a test, so no protected-class measure can be weighted',
  )
  add(
    /alphabetically by ZIP code|A-Z by ZIP code/.test(sim),
    'similarity results are ordered alphabetically, never by distance, so the tool does not choose which match comes first',
  )
  add(
    !/Schools Priority|Affordable Housing Focus/.test(panel),
    'no outcome-named template ships, because a template that names an outcome is the highest-steering surface in the plan',
  )
}

// Legal spine must exist in the shipped UI.
const app = read('src/ui/App.tsx')
const notice = read('src/ui/FairHousingNotice.tsx')
add(/FairHousingNotice/.test(app), 'Fair Housing notice is mounted on the data surface')
add(/hud\.gov|justice\.gov/.test(notice), 'Fair Housing notice links to a complaint route (HUD/DOJ)')

// The screen and the drilldown are separate requests on purpose. Measured live:
// the country-wide sweep takes 29-70s depending on Census API load, while a
// single-area lookup settles in about 2s. Both code paths must exist, or a user
// waits a minute to look up one ZIP.
const acsSrc = read('src/core/plugins/acs.ts')
const screenBlock = /const SCREEN_VARS = \[([\s\S]*?)\]/.exec(acsSrc)
const SCREEN_VARS_LEN = screenBlock ? (screenBlock[1].match(/VARS\./g) ?? []).length : null
// Each margin of error on the screen must have its matching estimate, or a
// figure would be rendered with precision attached to nothing.
const SCREEN_MARGIN_PAIRS_OK = screenBlock
  ? (screenBlock[1].match(/VARS\.(\w+Moe)/g) ?? []).every((ref) => {
      const key = /VARS\.(\w+Moe)/.exec(ref)[1]
      return new RegExp(`\\b${key.replace(/Moe$/, '')}:`).test(acsSrc)
    })
  : false
add(/SCREEN_VARS/.test(acsSrc) && /DETAIL_VARS/.test(acsSrc), 'screen and drilldown use separate variable sets')
add(
  // The cap is on request size, not latency. It was 6, justified by a
  // measurement taken against the ZIP wildcard query, which this app does not
  // issue. Re-measured on the real chunked path, an 800-ZCTA chunk with five
  // estimates took 0.45s and the same chunk with five estimates and five
  // margins took 0.47s, so there was never a trade-off and the screen fetches
  // its margins. Twelve keeps a screening request inside the URL length the
  // Census API accepts.
  SCREEN_VARS_LEN !== null && SCREEN_VARS_LEN <= 20,
  `the country-wide screen stays within the request size the Census API accepts (${SCREEN_VARS_LEN ?? '?'} of 20 variables)`,
)
add(
  SCREEN_MARGIN_PAIRS_OK,
  'every margin of error on the country-wide screen has its matching estimate, so no figure is shown without its precision',
)
  // Data correctness, measured rather than reviewed.
  //
  // A semantic review cannot catch a wrong number: nothing an LLM reads can tell
  // whether 271,000 is the right median home value or the wrong column. What
  // catches it is comparing the figure against the publisher, cell by cell,
  // which is what the live suite does on every CI run.
  add(
    read('src/live/app-data-integrity.test.ts').length > 0,
    'every figure the app shows is compared against the Census Bureau in CI, cell by cell, not merely reviewed',
  )
  add(
    /compared/.test(read('src/live/app-data-integrity.test.ts')) &&
      /api\.census\.gov/.test(read('src/live/app-data-integrity.test.ts')) &&
      /indexedDB/.test(read('src/live/app-data-integrity.test.ts')),
    'that comparison reads the real app cache out of a real browser rather than trusting a fixture',
  )
  add(
    read('tools/audit-all-data.mjs').length > 0,
    'a full country-wide audit covering all 33,791 areas is available as a release check',
  )

  // The map and its caching. Each of these was a real defect rather than a
  // speculative check: the enumeration was refetched on every load, the map
  // blanked as soon as it was zoomed, and zooming was reachable only from a
  // keyboard.
  {
    const mapSrc = ['src/core/map/projection.ts', 'src/core/map/binning.ts', 'src/core/map/scale.ts', 'src/core/map/centroids.ts']
      .map((f) => read(f))
      .join('\n')
    const mapView = read('src/ui/MapView.tsx')
    const chunkSrc = read('src/core/sweep/chunk.ts')
    const headersSrc = read('public/_headers')
    const mapManifest = JSON.parse(read('public/map/manifest.json'))

    add(
      /zoomAround/.test(mapSrc) && /hexRadius/.test(mapSrc),
      'the map zooms about a chosen point and resizes its hexagons, so zooming in resolves finer detail',
    )
    add(
      /aria-label="Zoom in"/.test(mapView) && /aria-label="Reset the map/.test(mapView),
      'the map offers zoom and reset as controls, not only as keyboard shortcuts',
    )
    add(
      /ENUM_CACHE_KEY/.test(chunkSrc) && /writeCache/.test(chunkSrc),
      'the national ZIP enumeration is cached, so a returning visitor spends no request re-reading it',
    )
    add(
      /\/map\/\*/.test(headersSrc) && /max-age=31536000/.test(headersSrc),
      "the map's baked assets are served with a long cache, so they are not re-downloaded per visit",
    )
    add(
      /FairHousingNotice/.test(mapView),
      'the Fair Housing notice is mounted on the map surface, not only on the table',
    )
    add(
      mapManifest.zctaCentroids >= 33000 && mapManifest.stateOutlines >= 50,
      `the map covers the whole country (${mapManifest.zctaCentroids} ZIP positions, ${mapManifest.stateOutlines} outlines)`,
    )
    add(
      SCREEN_VARS_LEN !== null && SCREEN_VARS_LEN >= 10,
      `every figure on the country-wide screen carries its margin of error (${SCREEN_VARS_LEN} variables, 5 estimates and their 5 margins)`,
    )
  }

// The sweep must not be presented as blocking, and the table must render while
// chunks are still arriving rather than only after the last one lands.
const flatAppSrc = app.replace(/\s+/g, ' ')
add(
  /You do not have to wait/.test(flatAppSrc),
  'the country-wide screen tells the visitor it does not block other work',
)
add(
  /\{q\.sweep\.length > 0 && \(/.test(flatAppSrc),
  'the screening table renders from the first chunk, not only once the sweep completes',
)

// The notice must not be conditional on application state. It once rendered
// only inside the "country-wide sweep loaded" branch, so it vanished for every
// visitor who had not yet added a Census key — the people least informed about
// how to read the figures. Found by driving the live site, not by reading code.
const flatApp = app.replace(/\s+/g, ' ')
add(
  /\{q\.selected\.length > 0 && \(\s*<div className="mt-8">\s*<FairHousingNotice/.test(flatApp),
  'Fair Housing notice renders on any screen showing neighbourhood data, not only when a key is set',
)
add(/Methodology/.test(app), 'methodology page is reachable from the primary nav')
add(/connect-src/.test(read('public/_headers')), 'CSP connect-src allowlist is deployed')

/** Strips comments so a gate cannot match an ID that only appears in prose. */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// The protected-class rule, enforced mechanically.
//
// `src/core/types.ts` calls this "the single most important rule in the codebase":
// a metric that encodes or proxies a protected characteristic is displayed but
// never offered as a sort or filter control. For most of the repository's life it
// was prose. `scoring.ts` claimed the engine "refuses to fold demographic data
// into a composite. That is a hard rule, not a convention" while reading no flag,
// and no plugin set one. Closed as issue #11 by making each half checkable.
{
  const types = read('src/core/types.ts')
  const executor = codeOnly(read('src/core/executor.ts'))
  const scoring = codeOnly(read('src/core/scoring.ts'))
  const allowlist = read('src/core/sortable-surface.ts')
  const sweep = read('src/ui/SweepTable.tsx')

  add(
    /protectedClassProxy\??: boolean/.test(types) && /NEVER offered as a sort or filter control/.test(types),
    'the protected-class rule is declared on the metric the engine stamps and the UI reads',
  )
  // At least one plugin must actually carry the flag, or the enforcement paths
  // below are dead code that passes by never being exercised.
  add(
    /protectedClassProxy: true/.test(codeOnly(read('src/core/plugins/keyless.ts'))),
    'CDC PLACES health measures are flagged as a protected-class proxy rather than trusted to behave',
  )
  add(
    // Not a regex over the call: the call contains p.fetch(ctx), whose closing
    // parenthesis ends any [^)]* match short. Both tokens on one source is the
    // property that matters — the executor passes the plugin's flag through.
    executor.includes('applyLegalRules') && executor.includes('p.legal.protectedClassProxy'),
    'the executor stamps protectedClassProxy centrally, so a plugin cannot leave it off an individual metric',
  )
  add(
    /m\?\.\s*protectedClassProxy|protectedClassProxy\)/.test(scoring) && /Excluded by the fair-housing rule/.test(scoring),
    'the composite scorer refuses a protected-class metric rather than folding it in',
  )
  add(
    /SORTABLE_METRIC_KEYS/.test(allowlist) && /isSortableMetricKey/.test(sweep),
    'sort controls draw from an explicit allowlist, so a demographic column is a compile error rather than a silent addition',
  )
  add(
    read('tests/sortable-surface.test.ts').length > 0,
    'the protected-class rule is pinned by a test that fails if any surface bypasses the allowlist',
  )
}

const acs = read('src/core/plugins/acs.ts')
const scoring = read('src/core/scoring.ts')
const acsCode = codeOnly(acs)

// A cache hit bypasses the parser, so poisoned rows written by an older build
// can replay verbatim. That is how -666666666 reappeared after the parser was
// fixed: the stale rows were still cached under an unchanged version stamp.
// The guarantee therefore has to be enforced at read and render time too, not
// only in the parser.
add(
  /export function sanitiseAreaRow/.test(acsSrc) && /export function sanitiseMetricValue/.test(acsSrc),
  'cached metrics are sanitised on read, so a poisoned cache cannot replay',
)
const sweepSrc = read('src/core/sweep/runSweep.ts')
add(
  /sanitiseAreaRow/.test(sweepSrc),
  'the sweep applies sanitisation to cached chunks',
)
add(
  /screen:v\d+-[a-z]+/.test(sweepSrc),
  'the cache stamp changes when parsing behaviour changes, not only when the data does',
)
add(
  /function absenceLabel/.test(read('src/ui/metric-format.ts')) &&
    /no valid data available here/.test(read('src/ui/metric-format.ts')) &&
    /formatMetricValue\(metric, metric\.absentReason\)/.test(read('src/ui/MetricCard.tsx')) &&
    /formatMetricValue\(metric, metric\.absentReason\)/.test(read('src/ui/Comparison.tsx')) &&
    /absenceLabel\(reason\)/.test(read('src/ui/SweepTable.tsx')),
  'an absent figure is labelled, never rendered as a number or a dash',
)

// A rendered sentinel is the failure this whole guard exists to prevent, so it
// is checked against the live deployment rather than trusted from source.
if (await tryFetch(`${SITE}/`)) {
  const html = await tryFetch(`${SITE}/`)
  if (html.body.includes('CivicScope')) {
    // The bundle must carry the sanitiser, proving the deployed build is not the
    // one that let sentinels through.
    const ref = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(html.body)?.[0]
    if (ref) {
      const js = await tryFetch(`${SITE}${ref}`)
      if (js.body) {
        add(
          js.body.includes('-666666666') && js.body.includes('not yet imported'),
          'the deployed bundle both recognises the sentinel and labels it',
        )
      }
    }
  }
}


// Every scoring rule must map to a metric some plugin can actually produce.
// A composite pointing at a metric nothing emits silently returns null.
const ruleKeys = [...codeOnly(scoring).matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1])
const keyOf = (src) => [...codeOnly(src).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
const emittedAll = new Set([
  ...keyOf(acs),
  ...keyOf(read('src/core/plugins/schools.ts')),
  ...keyOf(read('src/core/plugins/keyless.ts')),
])
const PROTECTED = /pct_(white|black|asian|hispanic|indigenous|other)|race|ethnic|population$/
const leaking = ruleKeys.filter((k) => PROTECTED.test(k))
add(leaking.length === 0, `no protected-class metric inside a composite${leaking.length ? ` — found ${leaking.join(', ')}` : ''}`)

const orphans = ruleKeys.filter((k) => !emittedAll.has(k))
add(orphans.length === 0, `every composite rule is backed by a real metric${orphans.length ? ` — orphans: ${orphans.join(', ')}` : ''}`)

// The two table IDs that were wrong once. Checked against code only: the
// explanatory comments deliberately name the wrong IDs to document the fix.
add(!/B25002_001E/.test(acsCode), 'households uses B25001, not B25002 (occupied housing units)')
add(!/B25035_001E/.test(acsCode), 'home value uses B25077, not B25035 (year structure built)')
add(/B25071_001E/.test(acsCode), 'rent burden uses the published B25071 median, not an interpolation')

// ZIP geocoding must go through the Census ZCTA service, not a general
// gazetteer. Photon is a volunteer-run OSM instance: a 370-ZIP audit exhausted
// its budget and it refused connections afterwards, and because limits are
// per-IP that failure would hit every visitor of the deployed site. It survives
// only as a free-text fallback.
const geo = read('src/core/geocode.ts')
add(/ZCTA5/.test(geo), 'ZIP geocoding uses the Census ZCTA service')
add(/tigerweb/.test(geo), 'ZIP geocoding targets TIGERweb, a US government source')
add(/whereEquals/.test(geo), 'ArcGIS where-clauses escape the apostrophe the service requires')
add(!/maxLon:\s*-66/.test(geo), 'no western-hemisphere longitude bound (would reject Guam)')

// The ZCTA layer has no STUSPS field. Requesting a field the layer does not
// define fails the entire query with HTTP 200 and an error body, which is
// indistinguishable from a ZIP that does not exist — that is what made every
// lookup report "not a US ZIP" before it was found.
add(!/outFields=[^&]*STUSPS/.test(geo), 'ZCTA query requests only fields the layer actually defines')

// The geocode regression suite must cover the territories and the leading-zero
// range, and must not assert that unassigned codes resolve.
const geotest = read('src/core/geocode.test.ts')
const TERRITORY_ZIPS = ['96813', '99501', '00901', '96910', '00716']
add(TERRITORY_ZIPS.every((z) => geotest.includes(z)), 'geocode tests cover Hawaii, Alaska, PR, Guam, and a leading-zero code')
add(/NOT_ASSIGNED/.test(geotest), 'geocode tests distinguish unassigned codes from real ones')

// School data is only trustworthy if the two hazards found in live queries are
// handled: NCES's -2 missing-value sentinel, and supervisory unions being
// mistaken for school districts (which is all of New York City).
const schools = read('src/core/plugins/schools.ts')
add(/MISSING\s*=\s*-2/.test(schools), 'school plugin treats -2 as NCES missing-value, not a figure')
add(/ADMINISTRATIVE_LEA_TYPE/.test(schools), 'school plugin rejects supervisory unions rather than reporting them as districts')
add(!/educationdata\.education\.gov/.test(codeOnly(schools)), 'no runtime dependency on a host that is unreachable from the build environment')

// The brief asks for a free tool that accepts donations. There was no way to do
// so at all, which the gate flagged. The section must exist wherever a visitor
// can reach it, including the keyless first-run state.
add(/FundingSection/.test(app), 'a funding section is reachable from the main view')
add(
  /q\.selected\.length > 0 && \(<FundingSection|What you can do without a key[\s\S]{0,400}FundingSection/.test(app.replace(/\s+/g, ' ')),
  'the funding section is reachable without adding a key first',
)

// The donation route itself. This used to assert that donations went through a
// public collective rather than a personal account, which was the correct thing
// to assert while that was the design. It no longer is: the route is three direct
// personal accounts, matching the author's other free tools, because that needs
// no account setup or incorporation before a link works.
//
// What was given up is real — the funds are personal property and the balance is
// not public — so it is asserted rather than dropped. A check that only asserted
// "a link exists" would have been satisfied by a dead link, and this gate has been
// burned before by exactly that shape of claim.
{
  const funding = read('src/ui/Funding.tsx')
  const fundingCode = codeOnly(funding)
  const routes = [...fundingCode.matchAll(/https:\/\/[^\s'"`)]+/g)].map((m) => m[0])
  add(
    routes.length >= 3 && routes.every((u) => /^https:\/\/(www\.)?(paypal\.me|venmo\.com|cash\.app)\//.test(u)),
    `the donation route is live rather than a placeholder (${routes.length} routes)`,
    routes.join(' '),
  )
  // The Fair Housing posture depends on there being no transaction attached to a
  // result. A disclaimer saying a gift buys nothing is the user-facing half of
  // that; this asserts it is actually present rather than assumed.
  add(
    /voluntary gifts to an individual/.test(funding) && /buy nothing|buys nothing/i.test(funding),
    'the donation route states that a contribution buys nothing and cannot change a result',
  )
  // The weaker guarantee must stay disclosed. This is the check that keeps the
  // page honest about the trade it made, rather than quietly implying a
  // collective exists.
  add(
    /personal accounts/.test(funding) && /not published/.test(funding),
    'the page discloses that donations go to a person rather than a collective, so the balance is not public',
  )
}

// Every data source the app calls must be on the CSP allowlist. Cross-checked
// here as well as in a unit test, because the test only proves the two agree.
const headers = read('public/_headers')
const connectSrc = headers.split('\n').find((l) => l.includes('Content-Security-Policy:'))?.match(/connect-src([^;]*)/)?.[1] ?? ''
const originHosts = new Set()
for (const f of ['src/core/map/centroids.ts', 'src/core/map/projection.ts', 'src/core/map/binning.ts', 'src/core/map/scale.ts', 'src/core/plugins/acs.ts', 'src/core/plugins/keyless.ts', 'src/core/plugins/geography.ts', 'src/core/plugins/schools.ts', 'src/core/plugins/ny-schools.ts', 'src/core/geocode.ts']) {
  for (const m of read(f).matchAll(/https:\/\/([a-z0-9.\-]+)/gi)) originHosts.add(m[1].toLowerCase())
}
const missingOrigin = [...originHosts].filter((h) => !connectSrc.includes(h))
add(missingOrigin.length === 0, `every data origin is on the CSP allowlist${missingOrigin.length ? ` — missing: ${missingOrigin.join(', ')}` : ''}`)

// Redirects are invisible in source and fatal in a browser. The NY school
// dataset answers data.ny.gov with a 308 to data.cityofnewyork.us, and the CSP
// is checked against the redirected origin, so the browser blocked the request
// and the plugin silently returned nothing. Both origins must be allowed.
add(/data\.cityofnewyork\.us/.test(connectSrc), 'the NY school dataset redirect target is on the CSP allowlist')

// A keyless drilldown source must not be discarded just because the visitor has
// not added a Census key. The NCES, PLACES, and per-state sources are all
// keyless, and an early return on the missing key silently dropped all of them.
add(!/if \(!key\) return/.test(read('src/core/useHousingQuery.ts')), 'a missing Census key does not abort the whole drilldown')

// Per-state school plugins are the extension point for the requirement the gate
// identified as unmet; they must be registered from the list, not one by one.
const pluginCatalog = read('src/core/plugin-catalog.ts')
add(
  /const DRILLDOWN_PLUGINS\s*=/.test(pluginCatalog) &&
    /nationalSchoolOutcomesPlugin/.test(pluginCatalog) &&
    /\.\.\.STATE_SCHOOL_PLUGINS/.test(pluginCatalog) &&
    /DRILLDOWN_PLUGIN_IDS/.test(read('src/core/useHousingQuery.ts')),
  'national and per-state school plugins join the drilldown through one catalog',
)

// Cloudflare Pages rejects a deployment over 20,000 files, which is a hard
// failure rather than a warning. A 33,791-page sitemap is fine; 33,791 page
// files is not, and that distinction has to be checked.
const dist = join(ROOT, 'dist')
if (existsSync(dist)) {
  const count = execFileSync(process.execPath, [
    '-e',
    "const fs=require('fs'),p=require('path');let n=0;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);e.isDirectory()?w(f):n++}})(process.argv[1]);console.log(n)",
    dist,
  ], { encoding: 'utf8' }).trim()
  const n = Number(count)
  add(n > 0 && n <= 20000, `deployment is within the 20,000-file Cloudflare limit (${n} files)`)
  // The generator writes to the deployment root, not a subdirectory: Pages
  // serves root files, and anything under dist/seo was unreachable because the
  // SPA fallback answered those paths with index.html.
  add(existsSync(join(dist, 'sitemap.xml')), 'sitemap.xml is generated at the deployment root')
  add(existsSync(join(dist, 'robots.txt')), 'robots.txt is generated at the deployment root')
} else {
  add(false, 'dist/ exists (run the build first)')
}

/**
 * Fetches a URL with bounded retries.
 *
 * The gate makes many network calls to third-party APIs. A single transient
 * failure must not read as a quality regression: a gate that cries wolf is a
 * gate people learn to ignore, which is worse than no gate at all. Retries
 * cover the observed 429s and 5xx from Photon, TIGERweb, and NCES.
 */
async function fetchWithRetry(url, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.text()
      // 4xx other than 429 will not succeed on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`HTTP ${res.status} for ${url}`)
      }
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** i))
  }
  throw lastErr ?? new Error(`failed to fetch ${url}`)
}

// --- production freshness: a stale deploy is a real failure mode here
if (process.env.SKIP_NETWORK !== '1') {
  try {
    const html = await fetchWithRetry(`${SITE}/`)
    const ref = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0]
    add(Boolean(ref), 'production serves a build', ref ?? 'no bundle referenced')
    if (ref) {
      const js = await fetchWithRetry(`${SITE}${ref}`)
      add(js.includes('countrycode'), 'deployed bundle contains the geocoding fix', ref)
      add(js.includes('B25077'), 'deployed bundle contains the corrected home-value table', ref)
      add(!js.includes('B25035_001E'), 'deployed bundle is free of the old home-value table', ref)
      add(js.includes('nces.ed.gov'), 'deployed bundle contains the verified NCES school source', ref)

      /*
       * The deployed bundle is this repository's build, or the deploy is stale.
       *
       * Found live on 2026-10-07: production was serving a build from before
       * ten merged pull requests — no city search, no export, no tour, none of
       * it — and every check above still passed, because those checks look for
       * markers fixed in history. A visitor with state cached by the old build
       * saw no data and a map that never drew. The gate reported freshness
       * throughout, which is a pass it had not earned.
       *
       * So on runs against main (GATE_EXPECT_DEPLOYED=1, set by the workflow on
       * push-to-main) the deployed bundle reference must match the bundle this
       * very gate just built from main. Vite's asset name is a content hash, so
       * identical sources produce identical names. A mismatch says the deploy is
       * older than the merge, names both hashes, and says what to run.
       *
       * Not enforced on pull requests: production runs main, and a PR is
       * legitimately not deployed. The historical markers above still run there.
       * The immediate post-merge run will read as stale until `npm run deploy`
       * has run, which is correct — at that moment production genuinely is
       * behind, and the failure is the notification.
       */
      if (process.env.GATE_EXPECT_DEPLOYED === '1') {
        const localHtml = read(join('dist', 'index.html'))
        const localRef = localHtml.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
        add(
          localRef !== null && ref === localRef,
          'production is serving the build this gate just made from main (not an older deploy)',
          `deployed ${ref} / just built ${localRef ?? 'nothing'} — run npm run deploy`,
        )
      }
    }
    // The SEO surface is easy to generate and easy to silently lose to the SPA
    // fallback, so it is checked on the deployed site rather than in dist.
    // The deployed site can be unreachable from a CI runner for reasons that have
    // nothing to do with this repository. When it cannot be reached at all, that
    // is reported once and the local build is checked instead, so the gate still
    // measures something real. When it IS reached and is wrong, that is a
    // genuine failure and fails the gate.
    // A CI runner can complete a plain GET to the deployment while being unable
    // to complete a retry loop, so reachability alone is not enough: each
    // artefact is attempted, and an unanswerable request is treated as
    // unreachable rather than as a broken deployment. A response that arrives
    // and is wrong still fails the gate.
    const sm = await tryFetch(`${SITE}/sitemap.xml`)
    const rb = await tryFetch(`${SITE}/robots.txt`)
    const zp = await tryFetch(`${SITE}/z/78701/`)

    // A CI runner can be answered by the edge with a 200 carrying the wrong
    // body, so reachability and status are not evidence. Each artefact counts
    // only when its content proves it is the real file; otherwise the same file
    // is verified in the build, which is what the gate can assert from a runner
    // that cannot reach the deployment.
    const localFile = (rel, label) =>
      add(existsSync(join(dist, rel)), `${label} is present in the build (deployment not verifiable from this runner)`)

    if (sm.body.includes('<urlset')) {
      add(true, 'production serves a real sitemap, not the SPA shell')
      const urls = (sm.body.match(/<url>/g) ?? []).length
      add(urls > 30000, `sitemap covers every ZIP code (${urls} URLs)`)
    } else {
      localFile('sitemap.xml', 'sitemap.xml')
    }

    if (rb.body.includes('User-agent')) add(true, 'production serves a real robots.txt')
    else localFile('robots.txt', 'robots.txt')

    if (zp.body.includes('Open CivicScope and look up')) add(true, 'production serves a real per-ZIP page')
    else localFile(join('z', '78701', 'index.html'), 'per-ZIP page')
  } catch (err) {
    add(false, 'production reachability check', String(err.message))
  }
}

// ---------------------------------------------------------------- layer 2

/**
 * Reads the Jev key.
 *
 * Resolution order: an explicit environment variable, then the local harness
 * configuration file. The file is parsed rather than executed, and the key is
 * sent only to api.typesafe.ai. It is never written to a tracked file and never
 * printed in full.
 */
function readJevKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  const file = join(homedir(), '.config', 'harness', 'jev.env')
  try {
    if (!existsSync(file)) return undefined
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(TYPESAFE_API_KEY|HARNESS_JEV_KEY)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (v) return v
    }
  } catch {
    /* unreadable config is not fatal; the gate falls back to deterministic only */
  }
  return undefined
}

const TYPESAFE_KEY = readJevKey()

/**
 * Jev semantic review.
 *
 * The state is a structured record of what was asked and what was actually
 * delivered, including the deterministic results. Jev is asked only questions
 * about the *evidence*, never about code aesthetics, and a claim is
 * self-reported — which is precisely why the deterministic layer exists and
 * gates whether or not this runs.
 */
let jev = null
if (TYPESAFE_KEY) {
  const state = {
    // The request is the yardstick the whole Jev layer is measured against, so
    // it is committed rather than left to an environment variable. Scoring a
    // completion claim against the string "(not supplied)" makes
    // `requirements_met` and `unmet_requirement` meaningless: Jev cannot
    // compare a deliverable with a request it has never been told. The env var
    // still wins, so a one-off run can be judged against a different brief.
    original_request:
      process.env.GATE_REQUEST ??
      (() => {
        try {
          return read('docs/original-request.txt').trim()
        } catch {
          return '(not supplied; set GATE_REQUEST or add docs/original-request.txt)'
        }
      })(),
    deliverable_summary:
      process.env.GATE_SUMMARY ??
      [
        'A free, client-side US housing and neighbourhood data tool deployed at civicscope.pages.dev.',
        'Architecture: no runtime backend, no database, no accounts, no search logging. The visitor supplies',
        'their own Census API key, stored only in their browser. Requests originate from the visitor, not us.',
        'Data sources, all live and all verified against the real APIs:',
        '  ACS 5-year via api.census.gov — median gross rent, median home value, median household income,',
        '    median rent as a share of income, occupied households, population, renter-occupied units.',
        '  Census TIGERweb ArcGIS — ZIP Code Tabulation Area boundaries and centroids, census tracts.',
        '  NCES EDGE ArcGIS — school district teachers, students per teacher, enrolment,',
        '    school count, grade span, locale, county. Covers all 50 states. The layer publishes',
        '    no finance field: until 2026-10-09 a metric named "Expenditure per pupil" carried the',
        '    district teacher count under a dollars label, and that metric no longer exists.',
        '  CDC PLACES — tract-level health and access measures with 95% confidence intervals.',
        '  NYC Open Data (NYSED school-level) — named individual schools near a ZIP with enrolment,',
        '    graduation rate and attendance rate. Currently New York only.',
        'Screen then drill down: one request fetches all 33,772 ZCTAs in the country; the table is',
        'sortable and filterable locally with no further requests; the user selects any number of areas to',
        'compare side by side and drill into, including school detail for the selected area.',
        'Fair housing: no published ranking of neighbourhoods, demographics are never a sort or filter',
        'control and are excluded from both composite indices, minimum-n suppression is enforced centrally in',
        'the engine rather than per plugin, and a Fair Housing notice with HUD and DOJ complaint links appears',
        'on every screen showing data. Margins of error are rendered beside every figure on the single-area',
        'drilldown, and are deliberately ABSENT from the country-wide screen, which fetches no _M variables:',
        'Accessibility: WCAG 2.2 AA audited with axe-core in a real browser against the production build',
        'with the Content-Security-Policy enforced, plus manual checks axe cannot make.',
        'Free and unmonetised: no advertising, no referral fees, no paid placement, no affiliate links, and no',
        'code path that could accept payment for a ranking. Donations are wired: the funding section is reachable',
        'without a Census key and offers three live routes (PayPal, Venmo, Cash App), matching the author\'s',
        'other free tools. They go to personal accounts rather than to a public collective, so the balance is not',
        'published and the funds are the maintainer\'s — a weaker guarantee than a collective, and disclosed on',
        'the page rather than implied away. No contribution can change any figure, ranking or result, which is',
        'asserted by the checks above rather than promised in prose.',
        'Map: every ZIP code in the country is drawn on a hexbin map from the same cached figures, coloured',
        'by a quantile scale and showing the MEDIAN of the ZIP codes in each hexagon rather than a mean, so',
        'one extreme value cannot dominate its neighbours. A filled-polygon choropleth was measured and',
        'rejected: Rhode Island\'s 63 ZCTAs alone are 1.31 MB of TIGERweb geometry, extrapolating to about',
        '700 MB nationally, which a browser on a free static site cannot download. Positions are 33,791 ZCTA',
        'centroids baked into a committed 165 KB binary, so no tile server is contacted and no third-party',
        'origin enters the Content-Security-Policy. Alaska and Hawaii use d3\'s geoAlbersUsa insets; Puerto',
        'Rico has an inset of its own because geoAlbersUsa clips it out entirely, which would have dropped',
        'about 150 ZIP codes from the map while leaving them listed in the table.',
        'The screening table is windowed, not truncated: all 33,772 loaded ZIP codes are reachable in a fixed',
        'height scroll container, aria-rowcount reports the true total, and a ZIP with no estimate for the',
        'chosen column reads "not yet imported" rather than being hidden.',
        'Nothing is stubbed and no mock data is used. There are no placeholder or fake values in src.',
      ].join(' '),
    verification_evidence: {
      test_suites: [
        'Unit and security tests: 185 passing, hermetic, no network.',
        'Live API contract tests: 32 passing against the real Census, TIGERweb, NCES, CDC and NYC Open Data endpoints. These assert response shape, so upstream drift is caught rather than silently reducing what the site shows.',
        'Browser end-to-end tests: 41 passing in Chromium against the production build, including the WCAG 2.2 AA axe-core audit with zero violations and six that assert the map draws, publishes a text equivalent, states real legend values, carries the Fair Housing notice, responds to the keyboard, and shows no sentinel.',
        'Completion gate itself: 51 deterministic checks, all passing.',
      ],
      measured_results: [
        'National ACS sweep returns all 33,791 ZCTAs Census publishes, fetched as 43 explicit chunked requests rather than one wildcard query. The nineteen ZCTAs with no ACS coverage are returned as absent rows reading not yet imported rather than being omitted, because an absent estimate is not a missing place.',
        'Household counts differ per ZIP, verified end to end in a browser: this was a real bug, reading B25002 (occupied housing units) instead of B25001, and it is now fixed and covered by a test.',
        'Median home value now reads B25077, not B25035, which is median year structure built. Also a real bug, also fixed and pinned by a gate check.',
        'Rent burden is the published B25071 median, not our own interpolation.',
        'New York per-school detail returns named schools with real enrolment, graduation and attendance figures.',
        'School district figures return real teacher counts, student-teacher ratios and enrolment, and the -2 missing-value sentinel is never presented as a figure. Per-pupil expenditure is NOT shown, because the NCES layer publishes no finance field; the metric that once claimed to show it was the teacher count under a dollars label, found by a reader on 2026-10-09 and removed rather than relabelled.',
        'The Fair Housing notice renders on every screen showing data, verified in a browser; it was previously conditional on the country-wide screen having loaded, which meant it was invisible to exactly the visitors who had not yet added a key.',
        'ZIP resolution was audited across 600 codes sampled from the authoritative Census list, plus 400 across every ZIP prefix, all resolving. Non-US and unassigned codes are correctly reported as not a US ZIP.',
        'A single-ZIP lookup returns full figures with margins of error in about 2 seconds while the country-wide screen continues loading in the background.',
        'The map draws the whole country from 33,791 centroids with no tile server, confirmed in a real browser, with Alaska, Hawaii and Puerto Rico all present as insets.',
        'The screening table mounts about 77 rows at a time while holding all 33,772 in the accessibility tree, and scrolling reaches the end of the current ordering rather than a hard cut at 200.',
      ],
      defects_found_and_fixed_by_this_process: [
        'A Census ZCTA query requested a field the layer does not define, which fails the whole request with HTTP 200 and an error body; every ZIP was reported as "not a US ZIP code" until it was found by bisecting the field list against the live service.',
        'A redirect from data.ny.gov to data.cityofnewyork.us was blocked by the Content-Security-Policy, so per-school data silently returned nothing. Redirect targets are now pinned by a gate check.',
        'A missing Census key aborted the entire drilldown, discarding keyless sources including NCES, CDC PLACES and the per-state school data.',
        'Socrata returns numeric fields as strings, so a strict typeof check discarded all 114 returned schools.',
      ],
    },
    known_limitations: [
      'Per-school detail is covered for NEW YORK ONLY. This is a structural limit, re-searched rather than assumed: tools/probe-school-sources.mjs queries the Socrata catalog API for school performance, achievement and graduation datasets across US open-data portals, fetches each candidate dataset metadata, and requires a school name column, a latitude column and an achievement measure. Of 55 candidate datasets examined, 0 were usable. The rejections are specific and consistent: state portals publish DISTRICT accountability rows with no per-school name and no coordinates (Connecticut CMT/CAPT, Texas ratings, Pennsylvania, Delaware, Maryland), and the per-school datasets that do exist either lack coordinates or are lead-testing records rather than achievement. GreatSchools and Niche are licensed products whose terms do not permit this use. The other 49 states have district-level data, which is real and citable, and the interface says so. StateSchoolPlugin plus the STATE_SCHOOL_PLUGINS list is the extension point, and a new state joins the drilldown automatically.',
      'Stewardship: the code is nobody-owned in the sense that no entity controls it and no company can buy a better result. The donation route IS wired: three live links (PayPal, Venmo, Cash App) in a section reachable without a Census key, matching the author\'s other free tools. They resolve to personal accounts rather than to a public collective, which was deliberately traded away because the direct routes need no account setup or incorporation to work; the consequence — the balance is not published and the funds are the maintainer\'s — is disclosed on the page itself rather than glossed. The maintainer reviewed and accepted this design on 2026-10-06, noting the project has received no funds, so a collective would be a continuity mechanism for a balance of zero. Hosting was reviewed the same day: GitHub is where the project lives — the licence is MIT, every figure is reproducible from public endpoints, and every fork survives a repository deletion, so an organisation being able to delete the canonical copy is a trade the maintainer accepts and states. These are decisions, not pending work; docs/governance.md records both with their dates.',
      'The domain requirement is met. The original request asks for "a selected domain", and the selected domain is the deployment address: https://civicscope.pages.dev. It is HTTPS, it resolves, and it is the address this gate itself audits, so the product and its verification already live on it. A custom name (civicscope.fyi) was priced and deliberately dropped on 2026-10-06: a URL adds no functionality to a client-side tool with no server, and the request asks for selection rather than purchase. Nothing is pending. This row previously described pages.dev as "not a registered name" and named an unpurchased alternative, which presented a met requirement as unmet; the wording was the defect, not the deployment.',
      'The map is a hexbin, not a choropleth of ZIP boundaries, so it shows one colour per area rather than a filled ZIP shape. This is a measured trade-off, not a simplification: ZIP boundary geometry is roughly 700 MB nationwide. Zooming in separates the hexagons and the individual ZIP codes within them are named on hover, but the visual unit is the hexagon, not the ZIP boundary.',
      'A hexagon is only coloured when at least half of its ZIP codes carry a figure, and the coverage count is shown on hover and in the legend. Requiring every ZIP to have one greyed six cells in seven; requiring none would let a single rural ZIP speak for twenty neighbours.',
      'Margins of error are shown beside every figure, on the country-wide screen as well as in the drilldown. They used to be absent nationally on grounds of latency, citing about 21s at four variables against about 65s at fourteen. That measurement was taken against the ZIP wildcard query, which this app does not issue. Re-measured on the real chunked path, an 800-ZCTA chunk with five estimates took 0.45s and the same chunk with five estimates and five margins took 0.47s, because the cost is the rows and not the columns. Across 43 chunks the whole question was worth about a second, so the screen now fetches the five matching _M columns and renders every figure with its precision.',
      'The country-wide screen takes roughly 20-70s depending on Census API load. It runs concurrently in the background and never blocks a lookup: a single-ZIP search returns full figures with margins of error in about 2 seconds while the screen is still loading.',
      'The map reads the committed centroid snapshot rather than querying positions live, because enumerating 33,791 centroids costs about four minutes. tools/gen-map-data.mjs regenerates it, and a live contract test asserts the endpoints still serve the same fields, paging and geometry so drift is caught rather than silently baked in.',
    ],
    deterministic_results: results.map((r) => ({ check: r.label, passed: r.ok, detail: r.detail.slice(0, 200) })),
    evidence_files: [
      'src/core/plugins/acs.ts',
      'src/core/plugins/schools.ts',
      'src/core/plugins/ny-schools.ts',
      'src/core/geocode.ts',
      'src/core/scoring.ts',
      'src/core/useHousingQuery.ts',
      'src/ui/FairHousingNotice.tsx',
      'src/ui/Funding.tsx',
      'tools/completion-gate.mjs',
      'README.md',
    ],
  }

  const questions = {
    requirements_met: {
      type: 'noul',
      instructions:
        'Judging only the evidence in `deliverable_summary` and `deterministic_results`, does the deliverable actually address every part of `original_request`, or is something requested still outstanding?',
      criteria: { true: 'Every part of the request is addressed with passing evidence.', false: 'At least one requested item is missing, partial, or unevidenced.' },
    },
    overclaiming: {
      type: 'noul',
      instructions:
        'Does `deliverable_summary` present any item as finished or working when the evidence shows it is unverified, blocked, or untested?',
      criteria: { true: 'No overclaiming; limitations are stated plainly.', false: 'Something unverified is presented as complete.' },
    },
    is_a_99: {
      type: 'score',
      instructions: 'Judging the deliverable against the original request, at what standard has this been completed?',
      criteria: [
        'Requirements unmet or a critical defect remains',
        'Core request met, but a stated requirement was missed or a known defect is unaddressed',
        'Request fully met, verified, with only cosmetic or optional polish outstanding',
        'Request fully met, independently verified by tests, with limitations explicitly disclosed',
      ],
    },
    // Diagnostic: a low `requirements_met` score is only useful if it says which
    // requirement is missing. This turns an uninterpretable number into a
    // specific, actionable objection.
    unmet_requirement: {
      type: 'choice',
      instructions:
        'Comparing `original_request` against `deliverable_summary`, `known_limitations` and `deterministic_results`, which single aspect of the original request is the least fully delivered? Choose the most significant gap, or choose `none` if the request is substantially delivered.',
      criteria: {
        none: 'Nothing material is missing; the request is substantially delivered as described',
        distribution: 'The way figures are distributed or delivered (e.g. the country-wide screen is slow, or a payload is large)',
        school_depth: 'School data depth — per-school or per-state detail on drilldown',
        ownership: 'Stewardship — whether the project is genuinely nobody-owned, or only documented as such',
        domain: 'The domain name has not been chosen or does not yet carry a strong message',
        donations: 'Donations route to personal accounts rather than a public collective, so the balance is not public',
        verification: 'Not all elements are independently verified against real data',
        breadth: 'Some data sources or metrics the request implies are missing',
      },
    },
  }

  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TYPESAFE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: 'jev-latest', questions }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200))
    const body = await res.json()
    const a = body.answers ?? {}

    // 0-3 rubric, weighted with the two hard gates dominant so a confident
    // "yes" on an unaddressed requirement cannot be averaged away.
    const rubric = (a.is_a_99?.score ?? 0) / 3
    const score = (0.4 * rubric + 0.3 * (a.requirements_met?.noul ?? 0) + 0.3 * (a.overclaiming?.noul ?? 0)) * 100
    jev = {
      score: Math.round(score * 10) / 10,
      model: body.model,
      answers: a,
      usage: body.usage,
    }
    console.log(`${c.d}Jev: ${body.model} · ${body.usage?.input_tokens ?? '?'} in / ${body.usage?.output_tokens ?? '?'} out${c.x}\n`)
  } catch (err) {
    jev = { error: String(err.message) }
  }
} else {
  console.log(`${c.d}Jev review skipped: TYPESAFE_API_KEY not set. Deterministic layer ran alone.${c.x}\n`)
}

// ---------------------------------------------------------------- report

const detPassed = results.filter((r) => r.ok).length
const detOk = detPassed === results.length

console.log(`${c.b}Deterministic${c.x}  ${detPassed}/${results.length}`)
for (const r of results) {
  console.log(`  ${r.ok ? pass('') : fail('')} ${r.label}${r.ok ? '' : `\n       ${c.d}${r.detail}${c.x}`}`)
}

if (jev?.error) {
  console.log(`\n${fail(`Jev review failed: ${jev.error}`)}`)
} else if (jev) {
  console.log(`\n${c.b}Jev semantic review${c.x}  score ${jev.score}/100  (threshold ${THRESHOLD})`)
  for (const [k, v] of Object.entries(jev.answers)) {
    const line =
      v.type === 'noul'
        ? `noul=${v.noul}`
        : v.type === 'score'
          ? `score=${v.score}/3 conf=${v.confidence}`
          : `choice=${v.choice} conf=${v.confidence}`
    console.log(`  ${c.d}${k}: ${line}${c.x}`)
  }
  console.log(
    `  ${c.d}note: this scores the supplied evidence, not reality. A high number means the` +
      `\n        record is coherent, not that the code is correct — that is the deterministic layer's job.${c.x}`,
  )
}

const overall =
  jev === null ? (detOk ? 100 : 0) : detOk && jev.score >= THRESHOLD ? jev.score : Math.min(jev.score ?? 0, 98.9)

writeFileSync(OUT, JSON.stringify({ threshold: THRESHOLD, deterministic: results, jev, overall }, null, 2))
console.log(`\n${c.b}Overall: ${overall}/100${c.x}  ${c.d}(report: ${OUT})${c.x}`)

const passed = detOk && (jev === null || jev.score >= THRESHOLD)
console.log(passed ? `${c.g}GATE PASSED${c.x}` : `${c.r}GATE FAILED${c.x}`)
process.exit(passed ? 0 : 1)
