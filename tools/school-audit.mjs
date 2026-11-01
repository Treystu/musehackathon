/**
 * Audits the school-district lookup across the full ZIP range.
 *
 * This is the layer with two known data hazards, both found by querying live
 * data: NCES uses -2 as a missing-value sentinel, and a point can fall inside a
 * supervisory union rather than a school district. Both produce plausible-looking
 * wrong answers rather than errors, so they are checked across many areas.
 */
const EDGE =
  'https://nces.ed.gov/opengis/rest/services/School_District_Boundaries/EDGE_ADMINDATA_SCHOOLDISTRICTS_SY2324/MapServer/1/query'
const ZCTA_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/query'

const DELAY = 500

async function allZctasWithCoords() {
  const out = []
  for (let offset = 0; ; offset += 30000) {
    const url = `${ZCTA_LAYER}?where=1%3D1&outFields=ZCTA5,CENTLAT,CENTLON&returnGeometry=false&resultRecordCount=30000&resultOffset=${offset}&f=json`
    const j = JSON.parse(await (await fetch(url)).text())
    const f = j.features ?? []
    for (const x of f) {
      const a = x.attributes
      if (/^\d{5}$/.test(a?.ZCTA5 ?? '') && a.CENTLAT && a.CENTLON) {
        out.push({ zcta: a.ZCTA5, lat: Number(a.CENTLAT), lon: Number(a.CENTLON) })
      }
    }
    if (f.length < 30000) break
    await new Promise((r) => setTimeout(r, DELAY))
  }
  return out
}

const MISSING = -2
const ADMINISTRATIVE = 3

const all = await allZctasWithCoords()

// Evenly spaced sample across the whole country. Computed from the list length
// rather than a modulo on a running counter, which silently checked only one
// area the first time this was written.
const TARGET = Number(process.env.SCHOOL_SAMPLE ?? 100)
const step = Math.max(1, Math.floor(all.length / TARGET))
const sample = all.filter((_, i) => i % step === 0).slice(0, TARGET)
console.log(`\nsampling ${sample.length} of ${all.length} areas (every ${step}th)`)

let checked = 0
let districts = 0
let administrative = 0
let noDistrict = 0
const problems = []

for (const { zcta, lat, lon } of sample) {
  const url =
    `${EDGE}?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&outFields=LEA_NAME,LEA_TYPE,SURVYEAR,MEMBER,TOTTCH,STUTERATIO&returnGeometry=false&f=json`
  let j
  try {
    j = JSON.parse(await (await fetch(url)).text())
  } catch (err) {
    problems.push(`${zcta}: request failed ${err.message}`)
    checked++
    await new Promise((r) => setTimeout(r, DELAY))
    continue
  }
  const a = j.features?.[0]?.attributes
  if (!a) {
    noDistrict++
  } else if (a.LEA_TYPE === ADMINISTRATIVE) {
    administrative++
  } else {
    districts++
    // The sentinel must never be presented as a figure.
    for (const f of ['MEMBER', 'TOTTCH', 'STUTERATIO']) {
      const v = a[f]
      if (v === MISSING || v < 0) {
        problems.push(`${zcta} ${a.LEA_NAME}: ${f}=${v} presented as a usable figure`)
      }
    }
  }
  checked++
  await new Promise((r) => setTimeout(r, DELAY))
}

console.log(`\nchecked        : ${checked}`)
console.log(`districts      : ${districts}`)
console.log(`supervisory    : ${administrative} (correctly treated as not-a-district)`)
console.log(`no district    : ${noDistrict}`)
console.log(`problems       : ${problems.length}`)
if (problems.length) console.log(problems.slice(0, 20).join('\n'))
console.log(problems.length === 0 ? '\nSCHOOL AUDIT CLEAN' : '\nSCHOOL AUDIT FOUND PROBLEMS')
process.exit(problems.length === 0 ? 0 : 1)
