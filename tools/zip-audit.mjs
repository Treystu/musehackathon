/**
 * Broad ZIP audit against the real Census ZCTA list.
 *
 * An earlier version of this script synthesised sample ZIP codes by padding a
 * 2-digit value to five digits, which produced codes like 00005 and 06966 that
 * are not assigned at all. They were then reported as "rejected as non-US" and
 * looked like a product regression. Sampling from the authoritative ZCTA list
 * removes that entire class of false alarm.
 *
 * Runs sequentially with pacing: TIGERweb is a public government service and
 * this tool is a good citizen of it.
 *
 * Usage: node tools/zip-audit.mjs [sampleSize]
 */

const LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query'

const SAMPLE = Number(process.argv[2] ?? 150)
const DELAY_MS = 400

/** Page through the authoritative ZCTA list. */
async function allZctas() {
  const out = []
  for (let offset = 0; ; offset += 30000) {
    const url = `${LAYER}?where=1%3D1&outFields=ZCTA5&returnGeometry=false&resultRecordCount=30000&resultOffset=${offset}&f=json`
    const j = JSON.parse(await (await fetch(url)).text())
    const features = j.features ?? []
    for (const f of features) {
      const z = f.attributes?.ZCTA5
      if (typeof z === 'string' && /^\d{5}$/.test(z)) out.push(z)
    }
    console.log(`  offset ${offset}: ${features.length} (total ${out.length})`)
    if (features.length < 30000) break
    await new Promise((r) => setTimeout(r, DELAY_MS))
  }
  return [...new Set(out)]
}

/** Evenly spaced across the whole space, so the sample spans every prefix. */
function sample(list, n) {
  const step = Math.max(1, Math.floor(list.length / n))
  const out = []
  for (let i = 0; i < list.length && out.length < n; i += step) out.push(list[i])
  return out
}

async function lookup(zcta) {
  const clause = encodeURIComponent(`ZCTA5='${zcta}'`).replace(/'/g, '%27')
  const url = `${LAYER}?where=${clause}&outFields=ZCTA5,NAME,CENTLAT,CENTLON&returnGeometry=false&f=json`
  const j = JSON.parse(await (await fetch(url)).text())
  if (j.error) return { ok: false, err: j.error.message }
  const a = j.features?.[0]?.attributes
  if (!a) return { ok: false, err: 'no feature' }
  if (!a.CENTLAT || !a.CENTLON) return { ok: false, err: 'no coordinates' }
  return { ok: true, lat: a.CENTLAT, lon: a.CENTLON }
}

console.log('Fetching the authoritative ZCTA list…')
const all = await allZctas()
console.log(`Census publishes ${all.length} ZIP Code Tabulation Areas\n`)

const picks = sample(all, SAMPLE)
console.log(`Auditing ${picks.length} sampled ZIP codes, sequentially at ${DELAY_MS}ms intervals\n`)

const failures = []
let ok = 0
for (const z of picks) {
  const r = await lookup(z)
  if (r.ok) ok++
  else failures.push(`${z}(${r.err})`)
  await new Promise((r) => setTimeout(r, DELAY_MS))
}

console.log(`\nresolved : ${ok}/${picks.length}`)
console.log(`failures : ${failures.length}`)
if (failures.length) {
  console.log(`\n${failures.slice(0, 40).join('\n')}`)
  if (failures.length > 40) console.log(`…and ${failures.length - 40} more`)
}
console.log(failures.length === 0 ? '\nAUDIT CLEAN' : '\nAUDIT FOUND FAILURES')
process.exit(failures.length === 0 ? 0 : 1)
