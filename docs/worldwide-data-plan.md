# Worldwide data: plan only, no code

The product is currently United States only, and every layer reflects that:
Census ACS, TIGERweb ZIP geometry, NCES school districts. This is a plan for
what it would take to extend it, written before any of it is built, so the
shape is agreed before the work starts.

## What the app would need to stop assuming

- ZIP codes as the only geography. Canada and the UK use postal codes, most of
  the world uses nothing equivalent, and TIGERweb geometry has no non-US
  counterpart. Areas without a code would need a different address model.
- The 800-row chunk plan, which exists because the US Census API rejects long
  geography lists. Other publishers have different limits and different
  failure modes.
- A single "sweep" concept. National coverage is a Census affordance; other
  countries publish at different geographies and cadence.

## Sources worth evaluating, by licence reality

Keyless and CORS-enabled, so they work in a browser-only app:
- UK Office for National Statistics
- Statistics Canada
- Central Statistics Office of Ireland
- Statistics Netherlands (CBS)
- Most Nordic national statistical agencies
- Eurostat, subject to its rate and licence terms

Requires a registered key per user, which changes the product:
- France (INSEE), Spain (INE), Italy (ISTAT), Germany (Destatis)
- OECD and UNdata, with licence constraints that may not permit a
  redistributable static build

Not viable: most commercial property and rental platforms, whose terms do not
permit this use.

## The two-tier architecture

This is the shape that makes worldwide coverage viable, and it mirrors what the
US map already does.

**Tier 1 — the overview is baked, and needs no key.**

Every country, and every first-level region within it, summarised to a few
dozens of numbers each, baked into static files at build time and served from
the same CDN as the app. The world map, and each country's region map, render
entirely from those files.

The data volume that makes this possible is tiny. A country-level overview for
two hundred countries is a few hundred kilobytes. It is also the data a reader
actually wants first: how expensive is housing here, what is the income, how
many people — not a per-postcode breakdown of somewhere they have not chosen
yet.

Because it is baked, the overview works with **no API key, no registration and
no per-user quota**, which removes the single biggest barrier to a worldwide
tool. It also means the overview cannot be broken by an upstream outage at the
moment someone is looking at it.

**Tier 2 — drilldown is live, and may need a key.**

When a reader picks a country, then a region, then a city, the app queries the
source directly, exactly as it does for a US ZIP code today. This is where
detail lives, and where an API key may be required.

If a source requires a key, the key is the reader's own, stored in their
browser and never sent to us — the arrangement CivicScope already uses for the
US Census API, and the reason the product needs no backend.

## What that changes about source selection

It moves the decision. A country whose national statistics are open is enough
to get it onto the overview map even if its sub-national data is closed or
keyed. That widens the set of countries that can be included first, and it means
a partial data story for a country is better than no country at all.

It also changes the order of work: build the baked-artefact pipeline and the
country/region navigation first, then add countries as their national data is
confirmed. Adding a country becomes a data file, not an architectural change.

## What still needs verifying before any of this is built

- Which countries publish national figures under an open licence, at what
  granularity and on what release schedule. This has not been surveyed and the
  plan above should not be read as claiming a particular set.
- Whether sub-national data for the first candidate is keyless or keyed.
- Whether the fair-housing analysis transfers. It is jurisdiction-specific and
  a tool careful in one country can be unlawful in another; it is a separate
  piece of work, not a line item.

## Sequencing, if it is approved

1. A second country end to end, chosen because its data is keyless and its
   geography is well defined. Canada or Ireland are the strongest candidates:
   both publish openly, and both have stable postal geography.
2. Generalise the address model and the chunking so a country is a
   configuration rather than a fork.
3. Only then a third and fourth, by which point each is a data adapter rather
   than an architectural change.

## What this does not change

The fair-housing constraints do not become optional because the map covers more
countries. Steering law and protected-class handling are decided per
jurisdiction, and a tool that is careful in one country can be unlawful in
another. That work is not the same task as adding a data source and should not
be bundled with it.

## Decision needed

Whether to fund this at all, and if so which single country to build first.
Until that is decided no code should be written, because the address model is
the part that is expensive to get wrong.
