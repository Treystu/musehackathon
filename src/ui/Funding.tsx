/**
 * Funding disclosure and donations.
 *
 * The brief asked for a free tool that accepts donations, and for a long time
 * there was no way to do so at all — the completion gate flagged it, correctly.
 *
 * This started out routed through Open Collective, on the reasoning that funds
 * sitting with a collective is what makes "not yours" mean something: the
 * balance is public, and if the project is abandoned the money stays with the
 * collective instead of becoming someone's property. That is a real property
 * and it was given up here, deliberately, for a specific reason — see below.
 *
 * It now uses the same direct routes as the author's other free tools
 * (Omada-Logger-Viz), which needs no account setup, no incorporation and no
 * fundraising decision before a link can work. The cost is honest and stated on
 * screen rather than glossed: contributions arrive at an individual, not a
 * collective, so the funds are personal property and the balance is not public.
 *
 * What did not change, and is the part that matters legally: donations buy
 * nothing. There is no ranking, no filter and no result anywhere in this app
 * that money can move, which is asserted by the completion gate rather than
 * promised here.
 */

export interface DonationRoute {
  label: string
  href: string
}

/**
 * The three routes, in the order the author's other projects present them.
 *
 * Kept as data rather than three hand-written links so a test can assert that
 * every one of them is present and well-formed, and so a link cannot be
 * half-removed by editing prose.
 */
export const DONATION_ROUTES: DonationRoute[] = [
  { label: 'PayPal', href: 'https://www.paypal.me/LBallek' },
  { label: 'Venmo - @lucas-ballek', href: 'https://venmo.com/u/lucas-ballek' },
  { label: 'Cash App - $luball', href: 'https://cash.app/$luball' },
]

export function FundingSection() {
  return (
    <section aria-labelledby="funding-heading" className="mt-6 panel panel-padded">
      <h2 id="funding-heading" className="text-sm font-semibold text-slate-900">
        This tool is free, and stays free
      </h2>
      <p className="mt-1 text-sm text-slate-700">
        CivicScope carries no advertising, sells no listings, and takes no payment for placement in any result.
        It runs on free hosting and free government data, so there is nothing for a sponsor to buy.
      </p>
      <p className="section-note mt-2">
        If it saved you time or answered a question you could not otherwise afford to answer, you can chip in
        towards hosting. These are voluntary gifts to the person who maintains it.
      </p>

      <ul className="mt-3 flex flex-wrap gap-2">
        {DONATION_ROUTES.map((route) => (
          <li key={route.href}>
            <a
              href={route.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
            >
              {route.label}
            </a>
          </li>
        ))}
      </ul>

      {/*
        The disclaimer is not boilerplate. It is the difference between "support
        this project" and an implied sale, and the Fair Housing posture of the
        whole app rests on there being no transaction attached to a result. So it
        says plainly that a gift buys nothing.
      */}
      <p className="mt-3 text-xs text-slate-600">
        Contributions are voluntary gifts to an individual, not payment for a service, and are not
        tax-deductible. They buy nothing: no priority support, no guarantees, and no promise about future
        features. No contribution can change any figure, ranking or result on this site.
      </p>

      <p className="mt-2 text-xs text-slate-600">
        These links go to personal accounts, not to a public collective, so the balance is not published and the
        funds are the maintainer&rsquo;s. That is a weaker guarantee than a collective would give, and it is
        stated here rather than implied away &mdash; see <code>docs/governance.md</code> for the full position.
      </p>
    </section>
  )
}