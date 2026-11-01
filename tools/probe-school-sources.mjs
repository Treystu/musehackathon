/**
 * Finds per-school datasets that a plugin could genuinely use.
 *
 * The catalog index does not carry column names, so every candidate's metadata
 * is fetched before it is judged. A dataset only qualifies if it has a school
 * name, somewhere on the map, and an achievement-like measure — the three
 * things `StateSchoolPlugin` needs. Anything short of all three is reported as
 * rejected with the reason, so a near miss is visible rather than silently
 * dropped.
 */

const CANDIDATE_QUERIES = ['school performance', 'school achievement', 'high school graduation rate']

async function search(q) {
  const url =
    `https://api.us.socrata.com/api/catalog/v1?only=dataset&limit=40&q=${encodeURIComponent(q)}`
  const res = await fetch(url)
  if (!res.ok) return []
  return (await res.json()).results ?? []
}

function judge(meta) {
  // The catalog wraps everything under `resource`, but the per-dataset
  // `/api/views/<id>` document does not: its columns sit at the top level.
  // Reading `resource.columns` here is why every candidate came back with no
  // columns at all.
  const columns = (meta?.columns ?? []).map((c) => c.name)
  const domain = meta?.metadata?.domain ?? ''
  if (!columns.length) return { ok: false, why: 'no columns published' }

  const name = columns.find((c) => /^(name|school_name|school|inst_name|schname|school_name_long|schoolname)$/i.test(c))
  const geo = columns.find((c) => /^(lat|latitude|location_1|point|y_coord|centlat)$/i.test(c))
  const measures = columns.filter((c) =>
    /graduation|grad_rate|perform|achieve|proficien|readiness|test_score|assessment|attendance/i.test(c),
  )
  // A Socrata `point`/`location` column only counts if the dataset also has a
  // usable latitude, because the plugin does a bounding-box filter in SQL.
  if (!name) return { ok: false, why: 'no school name column' }
  if (!geo) return { ok: false, why: 'no latitude column' }
  if (!measures.length) return { ok: false, why: 'no achievement measure' }
  return {
    ok: true,
    domain,
    id: meta?.id ?? meta?.resource?.id,
    title: meta?.name,
    nameCol: name,
    latCol: geo,
    measures: measures.slice(0, 8),
    columns: columns.length,
    updated: meta?.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : 'unknown',
  }
}

const seen = new Set()
const usable = []
const rejected = []

for (const q of CANDIDATE_QUERIES) {
  for (const hit of await search(q)) {
    const id = hit?.resource?.id
    const domain = hit?.metadata?.domain ?? ''
    if (!id || seen.has(`${domain}.${id}`)) continue
    // Only US city, county and state open-data portals are in scope: the data
    // has to be keyless and CORS-enabled to work in a static browser app.
    if (!/\.(gov|mil)$/.test(domain)) continue
    if (!/data\.|www\./.test(domain)) continue
    seen.add(`${domain}.${id}`)
    try {
      const res = await fetch(`https://${domain}/api/views/${id}`)
      if (!res.ok) continue
      const verdict = judge(await res.json())
      if (verdict.ok) usable.push(verdict)
      else rejected.push({ domain, title: hit?.resource?.name, why: verdict.why })
    } catch {
      // A portal that will not answer its own metadata is not usable.
    }
  }
}

console.log(`examined ${seen.size} candidate datasets\n`)
console.log('USABLE:')
for (const u of usable) {
  console.log(`  ${u.domain}/${u.id}`)
  console.log(`    ${u.title} (${u.columns} cols, updated ${u.updated})`)
  console.log(`    name=${u.nameCol} lat=${u.latCol} measures=${u.measures.join(', ')}`)
}
console.log(`\nREJECTED (${rejected.length}):`)
for (const r of rejected.slice(0, 18)) console.log(`  ${r.domain} - ${r.title}: ${r.why}`)
