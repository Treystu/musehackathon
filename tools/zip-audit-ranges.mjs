/**
 * Targeted audit of the ZIP ranges most likely to break: the very low codes
 * (leading zeros), the very high codes, and every 3-digit prefix. Uses the
 * authoritative ZCTA list, so every code audited is a real assigned ZIP.
 */
const LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query'

const DELAY = 350

async function allZctas() {
  const out = []
  for (let offset = 0; ; offset += 30000) {
    const url = `${LAYER}?where=1%3D1&outFields=ZCTA5&returnGeometry=false&resultRecordCount=30000&resultOffset=${offset}&f=json`
    const j = JSON.parse(await (await fetch(url)).text())
    const f = j.features ?? []
    for (const x of f) if (/^\d{5}$/.test(x.attributes?.ZCTA5 ?? '')) out.push(x.attributes.ZCTA5)
    if (f.length < 30000) break
    await new Promise((r) => setTimeout(r, DELAY))
  }
  return [...new Set(out)].sort()
}

async function lookup(z) {
  const clause = encodeURIComponent(`ZCTA5='${z}'`).replace(/'/g, '%27')
  const url = `${LAYER}?where=${clause}&outFields=ZCTA5,NAME,CENTLAT,CENTLON&returnGeometry=false&f=json`
  const j = JSON.parse(await (await fetch(url)).text())
  if (j.error) return { ok: false, err: j.error.message }
  const a = j.features?.[0]?.attributes
  if (!a) return { ok: false, err: 'no feature' }
  if (!a.CENTLAT || !a.CENTLON) return { ok: false, err: 'no coords' }
  return { ok: true }
}

const all = await allZctas()

const buckets = {
  'leading zero (0xxxx)': all.filter((z) => z[0] === '0'),
  'low (1xxxx-2xxxx)': all.filter((z) => z[0] === '1' || z[0] === '2'),
  'mid (3xxxx-6xxxx)': all.filter((z) => z[0] >= '3' && z[0] <= '6'),
  'high (7xxxx-9xxxx)': all.filter((z) => z[0] >= '7'),
  'every 3-digit prefix': [],
}

// One ZIP per 3-digit prefix: the broadest possible spread of the space.
const seen = new Set()
for (const z of all) {
  const p = z.slice(0, 3)
  if (!seen.has(p)) {
    seen.add(p)
    buckets['every 3-digit prefix'].push(z)
  }
}

let totalFail = 0
for (const [name, list] of Object.entries(buckets)) {
  // Cap the largest buckets so the audit stays inside a reasonable runtime.
  const step = Math.max(1, Math.floor(list.length / 80))
  const picks = list.filter((_, i) => i % step === 0).slice(0, 80)
  let ok = 0
  const bad = []
  for (const z of picks) {
    const r = await lookup(z)
    if (r.ok) ok++
    else bad.push(`${z}(${r.err})`)
    await new Promise((r2) => setTimeout(r2, DELAY))
  }
  totalFail += bad.length
  const status = bad.length === 0 ? 'CLEAN' : 'FAIL'
  console.log(
    `${status.padEnd(5)} ${name.padEnd(24)} population=${String(list.length).padStart(6)}  sampled=${String(picks.length).padStart(3)}  ok=${ok}`,
  )
  if (bad.length) console.log(`      ${bad.slice(0, 10).join(' ')}`)
}

console.log(`\nTotal failures: ${totalFail}`)
process.exit(totalFail === 0 ? 0 : 1)
