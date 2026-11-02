import { registry } from '../core/plugin-catalog'
import { SCORE_RULES, SCORE_VERSION } from '../core/scoring'
import { CENSUS_ATTRIBUTION } from '../core/censusKey'
import { METRIC_DEFS_BY_KEY, METRIC_KEYS, tableOfMetric, VINTAGE } from '../core/plugins/acs'
import { isSortableMetricKey } from '../core/sortable-surface'
import { DiagnosticsPanel } from './ai/DiagnosticsPanel'
import { MethodologyQa } from './ai/BriefingView'

/**
 * The methodology page is generated from the plugin registry and the scoring
 * rules rather than written by hand. That is deliberate: in a project whose
 * entire value proposition is that its numbers are auditable, documentation
 * that can silently drift out of date with the code is worse than no
 * documentation at all.
 */
export function Methodology() {
  const plugins = registry.all()
  const byCategory = new Map<string, typeof plugins>()
  for (const p of plugins) {
    const list = byCategory.get(p.category) ?? []
    list.push(p)
    byCategory.set(p.category, list)
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="about-heading">
        <h2 id="about-heading" className="section-title">
          How CivicScope works
        </h2>
        <div className="mt-2 space-y-3 text-sm leading-relaxed text-slate-700">
          <p>
            CivicScope fetches data directly from its publishers in your browser. For the data itself there is
            no server between you and the source, no database of our own, and no record of what you searched
            for; the assistant runs through a metered proxy on this site that keeps only aggregate totals.
            That is a technical decision with a purpose: an operator that cannot see who searched where cannot
            deliver different results to different people.
          </p>
          <p>
            We show three things for every figure: the value, its margin of error where the publisher supplies
            one, and the exact dataset, table, and query it came from. If a number here is wrong, you can fetch
            the original and check.
          </p>
          <p>
            The affordability index is a limited summary of selected housing-cost figures, not an objective
            verdict on a place. Its inputs, weights, and exclusions are published, and the underlying figures
            remain available beside it.
          </p>
        </div>
      </section>

      <section aria-labelledby="privacy-heading">
        <h2 id="privacy-heading" className="section-title">
          What we collect
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>
            Your browser stores a Census API key only if you add one. It is saved in local storage and sent only
            to Census.gov.
          </li>
          <li>
            This site is deployed with the project&rsquo;s own shared Census application key, so the full dataset
            works with no setup. That key identifies the application, not you, and a key you add yourself
            replaces it.
          </li>
          <li>
            Saved comparisons and display preferences stay in this browser. CivicScope does not receive them or
            keep a search history.
          </li>
          <li>
            Public source responses are cached in this browser. Remove saved comparisons in the app, or clear
            the site&rsquo;s browser storage to remove the key, preferences, and cache.
          </li>
          <li>No accounts, analytics, advertising, third-party scripts, or cookies.</li>
          <li>
            The assistant&rsquo;s calls are counted by one aggregate counter on this site, for budget
            accounting only — totals only (requests, tokens, modelled spend, error classes), never searches,
            keys, question text, or content. The counter reports; it does not stop, gate, delay, or limit
            requests.
          </li>
        </ul>
      </section>

      {/*
        F7 diagnostics live on the page a reader visits to understand what the
        product does. The panel records counts only, and the export is rebuilt
        from validated scalars so it cannot carry a question or a key.
      */}
      <DiagnosticsPanel />

      {/*
        The assistant section states the mechanism, not an assurance: the
        measures come from the same registry this page is generated from,
        filters are allowlisted, and wording is validated against the
        retrieved figures. A reader deciding whether to trust Ask or Explain
        needs those three facts, stated where the figures are defined.
      */}
      <section aria-labelledby="ai-heading">
        <h2 id="ai-heading" className="section-title">
          The assistant (Ask and Explain)
        </h2>
        <div className="mt-2 space-y-3 text-sm leading-relaxed text-slate-700">
          <p>
            The AI layer is generated from the same metric registry as the data layer, so the measures the
            assistant can use cannot drift from the measures the site displays. The assistant may only use the{' '}
            {METRIC_KEYS.length} registered metrics; ranking, recommendation, and demographic characterisation
            requests are never complied with — the assistant clarifies instead, keeping the parts of the
            question the data can answer (allowlisted filters, validated output, withheld wording).
          </p>
          <p>
            Every explanatory sentence the assistant writes about the figures is checked against the
            retrieved figures before display; a sentence containing a number that was not retrieved is
            withheld.
          </p>
          <p>
            Some questions reach past what Census data contains — schools, amenities, safety, the
            political character of a place. Those parts are answered separately, from web search run
            through the same metered proxy, in a labeled section with its sources listed. Web findings
            are never presented as figures, are shown only when they carry citations, and the assistant
            itself still never ranks or recommends places — it reports what the sources say and leaves
            the weighing to the reader.
          </p>
          <p>
            The assistant is held to that contract by tooling, not by intention. An evaluation harness
            (Sovereign-Harness) replays a fixed corpus of questions — every shape the assistant can be
            asked, including the shapes it must refuse — against the live model, and a release is accepted
            only when the recorded scores clear their bars. Changes to this layer are additionally scored
            before they ship by Jev, a typed judgement model, under the gate policy in the source
            repository. Questions are routed through the Muse models API by a proxy whose meter counts
            every call at flat per-call rates for budget accounting only; the figures themselves never
            come from the model.
          </p>
        </div>
      </section>

      {/*
        The methodology Q&A box lives here and only here (owner phone
        review, 2026-11-02): it was previously mounted inside
        BriefingView, which put a second question box on the Explore
        surface competing with Ask. Questions about the data — where a
        figure comes from, why it is missing — belong on the page that
        exists to answer them.
      */}
      <MethodologyQa />

      {/*
        The meter section (owner directive, 2026-11-02): the meter's
        posture changed from a binding budget to accounting only, and
        this page is the single prose home for that claim — task
        surfaces carry no standing explanation. The wording must never
        re-acquire a shutoff claim: a planned figure is a reporting
        line, not a limit, and there is no per-client cap in this
        deployment.
      */}
      <section aria-labelledby="meter-heading">
        <h2 id="meter-heading" className="section-title">
          The meter counts; it does not gate
        </h2>
        <div className="mt-2 space-y-3 text-sm leading-relaxed text-slate-700">
          <p>
            Every assistant call through this site&rsquo;s proxy is counted and reported for budget
            accounting: requests, tokens, and modelled spend at flat per-call rates, kept as aggregate
            totals only. In this deployment the meter is accounting only — it does not stop, gate, delay,
            or limit any request, and there is no per-client cap.
          </p>
          <p>
            The budget figures in the project&rsquo;s planning documents describe what the project planned
            to spend, not a shutoff. When a counted total passes a planned figure, the count is reported
            and requests continue; a call can still fail for an ordinary reason — the provider being
            unreachable, for example — but the meter is never the reason.
          </p>
        </div>
      </section>

      <section aria-labelledby="stewardship-heading">
        <h2 id="stewardship-heading" className="section-title">
          Who owns this
        </h2>
        <p className="section-note mt-2">
          Nobody, in the sense that matters operationally: there is no company behind this, nobody is paid to
          work on it, and there is no way for anyone to buy a better result. It carries no advertising, no
          referral fees and no paid placement.
        </p>
        <p className="section-note mt-2">
          Three things are true and worth stating plainly rather than glossing. The repository sits in a GitHub
          organisation, which is an organisation that can delete it, so it is not unowned in the strict sense.
          Donations are possible, but they go to a person&rsquo;s accounts rather than to a collective, so the
          money is personal property and the balance is not public. And nothing here is funded, so nothing here
          is guaranteed &mdash; a source can change and the maintainer can stop.
        </p>
        <p className="section-note mt-2">
          What survives all of that is the part that matters for your trust in a number: every figure here is
          fetched from its publisher directly by your browser, and can be re-fetched independently to check it.
          The full position, including what would have to change for the claim to be stronger, is in{' '}
          <code>docs/governance.md</code> in the source repository.
        </p>
      </section>

      {/*
        The figure dictionary. Generated from METRIC_DEFS_BY_KEY at render, not
        written by hand, so a metric cannot appear in the app without appearing
        here and cannot be described here except by its own registry entry. The
        sortable column is derived from the same allowlist the sort controls are
        typed against, which is the mechanism that keeps a demographic figure
        from ever becoming an ordering control — the one thing this table must
        be able to state truthfully.
      */}
      <section aria-labelledby="figures-heading">
        <h2 id="figures-heading" className="section-title">
          Every figure, and what it means
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Every figure this tool shows, from the American Community Survey {VINTAGE} 5-year estimates. Generated from
          the same registry the application renders from, so this list cannot drift from what is on screen. You can
          sort the screening table by five of these figures; the rest are shown for reading only, because ordering
          places by the age or education of the people in them would be this tool ranking neighbourhoods by who
          lives there.
        </p>
        <table className="mt-3 w-full text-left text-sm">
          <caption className="px-3 py-2 text-left text-xs text-slate-600">
            {METRIC_KEYS.length} figures, each with the Census table it comes from. Any number can be re-fetched from
            that table and checked.
          </caption>
          <thead className="border-b border-slate-200">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold text-slate-700">Figure</th>
              <th scope="col" className="px-3 py-2 font-semibold text-slate-700">What it measures</th>
              <th scope="col" className="px-3 py-2 font-semibold text-slate-700">Table</th>
              <th scope="col" className="px-3 py-2 font-semibold text-slate-700">Sortable</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_KEYS.map((key) => {
              const def = METRIC_DEFS_BY_KEY.get(key)
              if (!def) return null
              const sortable = isSortableMetricKey(key)
              return (
                <tr key={key} className="border-b border-slate-100 align-top">
                  <th scope="row" className="px-3 py-2 font-medium text-slate-900">
                    {def.label}
                  </th>
                  <td className="px-3 py-2 text-slate-700">{def.note}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{tableOfMetric(key) ?? 'ACS'}</td>
                  <td className="px-3 py-2 text-slate-700">
                    {sortable ? 'Yes, you choose the order' : 'No, reading only'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="data-heading">
        <h2 id="data-heading" className="section-title">
          Data sources
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Every source currently registered, grouped by the kind of question it answers. Adding a source adds it
          here automatically.
        </p>
        <div className="mt-3 space-y-4">
          {[...byCategory.entries()].map(([category, list]) => (
            <div key={category}>
              <h3 className="text-sm font-semibold capitalize text-slate-800">{category}</h3>
              <ul className="mt-1 space-y-2">
                {list.map((p) => (
                  <li key={p.id} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
                    <p className="font-medium text-slate-900">{p.title}</p>
                    <p className="mt-0.5 text-xs text-slate-600">
                      Geography: {p.geography} · Appears from depth {p.minZoom} and deeper
                      {p.requiresCensusKey ? ' · requires a Census key' : ' · no key required'}
                    </p>
                    {p.legal.notice && <p className="mt-1 text-xs italic text-slate-600">{p.legal.notice}</p>}
                    {p.legal.suppressBelow !== undefined && (
                      <p className="mt-1 text-xs text-slate-600">
                        Figures below {p.legal.suppressBelow} in a count unit are withheld to protect
                        small-population privacy.
                      </p>
                    )}
                    {p.legal.protectedClassProxy && (
                      <p className="mt-1 text-xs font-medium text-slate-700">
                        Can proxy a protected characteristic at area level. Shown in the detail view only and
                        excluded from sorting, filtering, similarity, and composite scores.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="scoring-heading">
        <h2 id="scoring-heading" className="section-title">
          How the indices are calculated
        </h2>
        <p className="mt-1 text-sm text-slate-700">
          Version {SCORE_VERSION}. Each component is scaled to 0&ndash;100 against a stated range and combined
          by weight. Components that are unavailable are dropped and the remaining weights are renormalised, so
          the index always states which inputs it actually used.
        </p>
        <div className="mt-3 space-y-4">
          {(
            [
              ['Affordability', SCORE_RULES.affordability],
              // There was an education composite here. It is gone, and the
              // reason is on the page rather than in a commit message nobody
              // reads: its spending component never existed — the NCES layer
              // publishes no finance field, and the metric carried a teacher
              // count under a dollars label, which scored every district in the
              // country exactly 40. It returns when a real finance source is
              // wired in.
            ] as const
          ).map(([label, rules]) => (
            <div key={label} className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="w-full text-left text-sm">
                <caption className="px-3 pt-2 text-left text-xs text-slate-600">{label} index components</caption>
                <thead>
                  <tr className="border-b border-slate-200">
                    <th scope="col" className="px-3 py-2 font-semibold text-slate-800">Component</th>
                    <th scope="col" className="px-3 py-2 font-semibold text-slate-800">Weight</th>
                    <th scope="col" className="px-3 py-2 font-semibold text-slate-800">Range</th>
                    <th scope="col" className="px-3 py-2 font-semibold text-slate-800">Higher is</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.key} className="border-b border-slate-100 align-top">
                      <th scope="row" className="px-3 py-2 font-normal text-slate-800">
                        {r.label}
                        <span className="mt-0.5 block text-xs text-slate-500">{r.note}</span>
                      </th>
                      <td className="px-3 py-2 tabular-nums text-slate-700">{Math.round(r.weight * 100)}%</td>
                      <td className="px-3 py-2 tabular-nums text-slate-700">
                        {r.floor.toLocaleString('en-US')} to {r.ceiling.toLocaleString('en-US')}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{r.betterWhen === 'higher' ? 'better' : 'worse'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <p className="mt-3 text-sm text-slate-700">
          These ranges describe the plausible span of values across US areas. They are not national averages,
          because computing against a national distribution would require holding national data in your
          browser, which is the thing this design avoids. Compare indices within one search, not across
          unrelated ones.
        </p>
      </section>

      <section aria-labelledby="fair-heading">
        <h2 id="fair-heading" className="section-title">
          Fair housing commitments
        </h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-700">
          <li>
            This tool does not include race or ethnicity measures. Those measures are not used in filters,
            figure sorts, similarity, or composite scores; protected-class proxies are excluded from those
            controls by the metric allowlists.
          </li>
          <li>
            The national screen starts in ZIP code order. You can choose to order it by one published figure,
            but that figure-specific order is not an overall ranking or a judgment about which place is best.
          </li>
          <li>
            The selected-area view includes a limited affordability index with its published inputs and weights.
            Similar-ZIP search is off by default and lists matches alphabetically rather than by similarity score.
          </li>
          <li>
            We take no advertising, no referral fees, and no payment for placement. There is nothing to sell and
            no service to withhold, so there is no allocation for us to make.
          </li>
          <li>
            We use the coarsest geography the data supports, withhold small counts, and publish margins of
            error.
          </li>
          <li>
            We publish the sources, measure definitions, and affordability-index weights so readers can
            examine the choices and their limits.
          </li>
        </ul>
      </section>

      <section aria-labelledby="attr-heading">
        <h2 id="attr-heading" className="section-title">
          Attribution
        </h2>
        <div className="mt-2 space-y-1 text-sm text-slate-700">
          <p>{CENSUS_ATTRIBUTION}</p>
          <p>
            Contains information from the U.S. Department of Education&rsquo;s NCES Common Core of Data and
            from the CDC PLACES programme.
          </p>
          <p>
            New York school details come from the New York City Department of Education&rsquo;s 2020 High School
            Directory, via{' '}
            <a
              href="https://data.cityofnewyork.us/d/23z9-6uk9"
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-800 underline"
            >
              NYC Open Data
            </a>
            . The portal metadata attributes the dataset to DOE and does not list a license identifier; this
            attribution is not a claim about the dataset&rsquo;s license.
          </p>
          <p>
            Nationwide public-school graduation outcomes use 2019 EDFacts Adjusted Cohort Graduation Rates,
            served by the{' '}
            <a
              href="https://educationdata.urban.org/documentation/schools.html"
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-800 underline"
            >
              Urban Institute Education Data Portal
            </a>{' '}
            under its ODC Attribution License (ODC-By 1.0), joined by NCES school ID to{' '}
            <a
              href="https://nces.ed.gov/programs/edge/Geographic/SchoolLocations"
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-800 underline"
            >
              NCES EDGE public-school locations
            </a>{' '}
            from 2019–20. The value shown is the Portal midpoint; many records have a reported rate range.
            Coverage is up to eight nearest public schools within 3 km with reportable 2019 four-year cohort
            graduation data, not all schools, grades, years, or outcomes. This measure is not a school-quality
            rating.
          </p>
          <p>
            Geocoding by{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-800 underline"
            >
              OpenStreetMap
            </a>{' '}
            contributors, available under the Open Database License.
          </p>
        </div>
      </section>
    </div>
  )
}
