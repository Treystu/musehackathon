/**
 * Fair Housing information and direct routes to complaint and agency resources.
 * The links are kept on the shared notice so every data-bearing screen offers
 * the same maintained federal and state/local paths instead of a hand-curated
 * state-law list that can silently go stale.
 */
export function FairHousingNotice() {
  return (
    <aside
      className="rounded-lg border border-slate-300 bg-white p-4 text-sm"
      aria-labelledby="fh-heading"
    >
      <h2 id="fh-heading" className="text-sm font-semibold text-slate-900">
        How to read this data
      </h2>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-slate-700">
        <li>
          Every figure here describes a <strong>Census-defined area</strong> — a ZIP code tabulation area or
          census tract. It does not describe any individual, household, property, or its occupants.
        </li>
        <li>
          These are survey estimates with margins of error. Small areas are less reliable than large ones, and
          each figure shows its own uncertainty.
        </li>
        <li>
          We show public statistical data and where it came from. The national list starts in ZIP code order;
          readers may sort it by one figure. That is not an overall ranking or a recommendation. We do not
          endorse neighborhoods or sell, broker, or refer listings. The selected-area view includes a limited
          affordability index with its inputs and weights; Similar ZIP search is optional and lists matches
          alphabetically. This tool is not legal advice.
        </li>
        <li>
          The federal Fair Housing Act prohibits housing discrimination based on race, color, national origin,
          religion, sex, disability, and familial status. State and local protections may also apply.
        </li>
      </ul>
      <p className="mt-3 font-medium text-slate-800">Equal Housing Opportunity</p>
      <p className="mt-3 text-slate-700">
        If you believe you have experienced housing discrimination, you can contact HUD, a HUD Fair Housing
        Assistance Program partner, or the Department of Justice:
      </p>
      <ul className="mt-1 space-y-0.5 text-sm">
        <li>
          <a
            href="https://www.hud.gov/helping-americans/complaint-form"
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-blue-800 underline hover:text-blue-950"
          >
            U.S. Department of Housing and Urban Development
          </a>
        </li>
        <li>
          <a
            href="https://www.hud.gov/stat/fheo/partners-agencies"
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-blue-800 underline hover:text-blue-950"
          >
            HUD Fair Housing Assistance Program state and local agencies
          </a>
        </li>
        <li>
          <a
            href="https://www.justice.gov/crt/housing-and-civil-enforcement-section"
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-blue-800 underline hover:text-blue-950"
          >
            U.S. Department of Justice, Civil Rights Division
          </a>
        </li>
        <li>
          <a
            href="https://www.nafcponline.org/about-us/housing-discrimination-complaints/"
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-blue-800 underline hover:text-blue-950"
          >
            National Fair Housing Alliance
          </a>
        </li>
      </ul>
      <p className="mt-2 text-xs text-slate-600">
        HUD&rsquo;s directory lists participating agencies. It is a starting point for local help, not a complete
        statement of the law in any state or city.
      </p>
    </aside>
  )
}

/** A compact variant for pages that display only a narrow set of metrics. */
export function AreaScopeNotice({ source, vintage, geography }: { source: string; vintage: string; geography: string }) {
  return (
    <p className="text-xs italic text-slate-500">
      {geography} figures from {source}, {vintage} vintage. This describes an area, not any person or
      household, and is not a recommendation.
    </p>
  )
}
