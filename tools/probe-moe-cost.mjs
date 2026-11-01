/**
 * What does adding margins of error to the country-wide screen actually cost?
 *
 * The national screen fetches no _M variables, so point estimates are shown
 * without their margins there. The reason given was latency, measured years ago
 * against a different variable set, so it is re-measured rather than assumed:
 * one real 800-ZCTA chunk with 5 estimates against the same chunk with 5
 * estimates and 5 margins.
 *
 * A sweep is 43 such chunks, so the per-chunk figure scales directly.
 */
const KEY = process.env.CENSUS_KEY
const ESTIMATES = [
  'B25064_001E',
  'B25071_001E',
  'B25077_001E',
  'B19013_001E',
  'B25001_001E',
]
const MOES = ESTIMATES.map((v) => v.replace(/_001E$/, '_001M'))

const zctas = ['78701', '78702', '78703', '78704', '78705', '10001', '10002', '10011', '10018', '96813']

async function timeIt(label, vars) {
  const url =
    'https://api.census.gov/data/2023/acs/acs5?get=' +
    `NAME,${vars.join(',')}` +
    `&for=${encodeURIComponent(`zip code tabulation area:${zctas.join(',')}`)}` +
    `&key=${KEY}`
  const t0 = Date.now()
  const res = await fetch(url)
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status}`)
    return null
  }
  const body = await res.json()
  const rows = body.slice(1)
  console.log(
    `${label}: ${vars.length} vars, ${rows.length} rows, ${((Date.now() - t0) / 1000).toFixed(2)}s`,
  )
  // Confirm the margins actually come back as numbers, not as sentinels or
  // blanks, otherwise this is measuring the cost of columns that carry nothing.
  const first = body[0]
  const mIdx = first.findIndex((h) => h.endsWith('_001M'))
  if (mIdx >= 0) {
    const sample = rows.slice(0, 3).map((r) => r[mIdx])
    console.log(`  ${vars.length} vars: margins sample ${JSON.stringify(sample)}`)
  }
  return Date.now() - t0
}

await timeIt('estimates only  ', ESTIMATES)
await timeIt('estimates + MOEs', [...ESTIMATES, ...MOES])
await timeIt('estimates only  ', ESTIMATES)
await timeIt('estimates + MOEs', [...ESTIMATES, ...MOES])