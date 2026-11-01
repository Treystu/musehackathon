/**
 * Static SEO generator.
 *
 * The app is a single-page application with no server, which is what keeps the
 * privacy and legal posture intact — but search engines cannot execute
 * JavaScript reliably, and a user with JavaScript disabled gets nothing. So the
 * discoverable surface is generated ahead of time from public data, at build
 * time, and served as static files.
 *
 * Sizing, measured rather than guessed: TIGERweb reports 33,791 ZCTAs. Cloudflare
 * Pages enforces a hard limit of 20,000 files per deployment, so a page per ZIP
 * is not merely inelegant, it does not deploy. That limit is what shapes this
 * design:
 *
 *   - the full crawlable index goes in `sitemap.xml`, covering every ZCTA, at
 *     the cost of one file;
 *   - static pages are generated only for the areas people actually search for
 *     in practice — a curated set of metropolitan areas and their ZIPs — which
 *     stays well inside the deployment limit;
 *   - everything else remains reachable through the live app, which is the
 *     authoritative view anyway.
 *
 * The figures are deliberately NOT baked in. They change annually, they require
 * a Census key, and embedding a stale number in a search snippet is exactly the
 * kind of confidently-wrong output this project exists to avoid. The static page
 * is an entry point into the live, auditable view.
 *
 * The list is fetched at build time from a keyless source, so the generator
 * runs in CI with no credentials.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const TIGER_ZCTA =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query'

const SITE = process.env.SITE_ORIGIN ?? 'https://civicscope.pages.dev'
/**
 * Output location matters more than it looks.
 *
 * Cloudflare Pages serves whatever is in the deployment root, and the SPA
 * fallback in `_redirects` (`/*  /index.html  200`) answers anything that is not
 * a real file at the root. Files in a `seo/` subdirectory are therefore
 * unreachable: `/sitemap.xml` falls through to the shell and returns index.html,
 * which was verified happening live.
 *
 * So the SEO output is written into the deployment root, next to index.html,
 * and Pages serves it before the fallback applies.
 */
const OUT = 'dist'

const PAGE_SIZE = 30000

async function fetchAllZctas() {
  const all = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // resultOffset must be part of the looped query. An earlier version built
    // the URL once with offset=0 and then appended a second offset parameter on
    // every iteration, so it re-fetched the first page forever and never
    // terminated. Each call takes ~30s for 30k rows, so two calls cover the
    // whole country.
    const url =
      `${TIGER_ZCTA}?where=1%3D1&outFields=ZCTA5&returnGeometry=false` +
      `&resultRecordCount=${PAGE_SIZE}&resultOffset=${offset}&f=json`

    // Retried per page. TIGERweb resets connections on large responses — the
    // same documented failure mode `tools/gen-map-data.mjs` retries for, and one
    // this generator lacked until a push-to-main run failed on it on 2026-10-08:
    // a single dropped connection killed the whole build, which cascaded into
    // six red gate checks (typecheck+build, unit, live contracts, WCAG audit,
    // sitemap, robots) that all depend on the build having produced dist/.
    // The identical PR run had passed hours earlier, so the code was fine and
    // the fetch was the whole failure.
    let res
    let lastErr
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await fetch(url)
        if (!r.ok) throw new Error(`TIGERweb HTTP ${r.status}`)
        res = await r.json()
        break
      } catch (err) {
        lastErr = err
        const wait = 2000 * attempt
        console.log(`[seo] offset ${offset}: attempt ${attempt} failed (${err.message}); retrying in ${wait}ms`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    if (!res) throw new Error(`TIGERweb page at offset ${offset} failed after 4 attempts: ${lastErr?.message}`)

    const features = res.features ?? []
    console.log(`[seo] offset ${offset}: ${features.length} rows`)
    for (const f of features) {
      const z = f.attributes?.ZCTA5
      if (typeof z === 'string' && /^\d{5}$/.test(z)) all.push(z)
    }
    if (features.length < PAGE_SIZE) break
  }
  return [...new Set(all)].sort()
}

/** Escapes text for safe interpolation into XML and HTML. */
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function zctaPage(zcta) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZIP code ${esc(zcta)} housing and neighbourhood data | CivicScope</title>
<meta name="description" content="Free, auditable housing and neighbourhood data for ZIP code ${esc(zcta)}: median rent, rent burden, median home value, and median household income from the US Census Bureau, with margins of error and sources shown.">
<link rel="canonical" href="${SITE}/z/${esc(zcta)}/">
<link rel="alternate" hreflang="x-default" href="${SITE}/z/${esc(zcta)}/">
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Place',
  name: `ZIP code ${zcta}`,
  description: `Neighbourhood and housing data for US ZIP code ${zcta}, from federal sources, with figures shown with their margins of error.`,
  url: `${SITE}/z/${zcta}/`,
  additionalProperty: [
    { '@type': 'PropertyValue', name: 'Data source', value: 'U.S. Census Bureau, American Community Survey 5-Year Estimates' },
  ],
})}
</script>
</head>
<body>
<main>
<h1>Housing and neighbourhood data for ZIP code ${esc(zcta)}</h1>
<p>
  CivicScope shows federal housing and neighbourhood data for every ZIP code in
  the United States, with the source, table, and margin of error beside each
  figure. It is free, carries no advertising, and records no searches.
</p>
<p>
  This page does not pre-render the figures themselves. Data is fetched live
  from the Census Bureau in your browser so that what you read is current and
  independently checkable rather than a copy frozen at build time.
</p>
<p><a href="/">Open CivicScope and look up ${esc(zcta)}</a></p>
<p><a href="/methodology/">How the data is collected and scored</a></p>
<p>
  The Fair Housing Act prohibits steering and discrimination in housing. Census
  figures describe a statistical area, not any individual, household, or
  property. If you believe you have experienced housing discrimination you can
  <a href="https://www.hud.gov/helping-americans/complaint-form" rel="nofollow noopener">file a complaint with HUD</a>.
</p>
</main>
</body>
</html>
`
}

function robots() {
  return `User-agent: *
Allow: /
# The app itself is a single page; the per-ZIP entry points are the crawlable
# surface. Nothing is blocked, because there is nothing private to hide: the
# service holds no user data and has no search index behind it.
Sitemap: ${SITE}/sitemap.xml
`
}

function sitemap(zctas) {
  const urls = zctas
    .map((z) => `  <url><loc>${SITE}/z/${z}/</loc></url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><changefreq>weekly</changefreq></url>
  <url><loc>${SITE}/methodology/</loc><changefreq>monthly</changefreq></url>
${urls}
</urlset>
`
}

const zctas = await fetchAllZctas()
console.log(`[seo] fetched ${zctas.length} ZCTAs`)

/**
 * Pages generated statically. Cloudflare allows 20,000 files per deployment,
 * and the app itself needs a handful, so the budget here is deliberately small.
 * A curated list of the largest metropolitan areas covers the overwhelming
 * majority of real search volume; the full 33,791 remain in the sitemap and
 * reachable through the app.
 */
const FEATURED = [
  '78701', '10001', '60601', '90210', '94110', '10011', '75201', '77002',
  '02108', '19103', '30303', '33101', '80202', '98101', '94102', '20001',
  '37203', '48226', '85004', '89101', '92101', '55401', '43215', '28202',
  '76102', '97205', '27601', '63101', '45202', '44113', '53202', '46204',
  '87102', '70112', '96813', '99501', '00901', '96813', '33602', '80903',
]

await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, 'robots.txt'), robots())
await writeFile(join(OUT, 'sitemap.xml'), sitemap(zctas))

await mkdir(join(OUT, 'z'), { recursive: true })
for (const z of FEATURED) {
  const dir = join(OUT, 'z', z)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.html'), zctaPage(z))
}
console.log(`[seo] wrote ${FEATURED.length} featured pages`)

// sitemap must stay under the Sitemap protocol's 50,000 URL limit.
const entries = zctas.length + 2
if (entries > 50000) {
  throw new Error(`sitemap has ${entries} URLs, over the 50,000 protocol limit; a sitemap index is required`)
}

// A self-check so a regression is caught here rather than by a crawler.
const sample = FEATURED[0]
if (!existsSync(join(OUT, 'z', sample, 'index.html'))) {
  throw new Error(`expected a page for ${sample} but none was written`)
}
console.log(`[seo] sitemap covers ${zctas.length} ZIP codes (${entries} URLs total)`)
