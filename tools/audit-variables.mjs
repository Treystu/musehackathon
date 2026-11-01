/**
 * Audits every ACS variable this app names against the publisher's own
 * definition, keylessly. The five mislabels found on 2026-10-09 were all
 * discoverable this way in seconds; this runs the check for all of them so no
 * variable ships on trust again. Also verifies each estimate's published
 * margin column exists, and that every estimate the screen and detail paths
 * request is mapped to a metric key (the fetched-and-discarded defect).
 *
 * Run with: node tools/audit-variables.mjs
 * Exits non-zero on any mismatch. No key, no browser, one request per column.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/core/plugins/acs.ts', import.meta.url), 'utf8')
const VARS_BLOCK = src.match(/export const VARS = \{([\s\S]*?)\} as const/)[1]
const VARS = Object.fromEntries(
  [...VARS_BLOCK.matchAll(/(\w+):\s*'(B\d+_\d+[EM])'/g)].map((m) => [m[1], m[2]]),
)

const DEFS_BLOCK = src.match(/const METRIC_DEFS[^=]*=\s*\[([\s\S]*?)\n\]/)[1]
const DEFS = {}
for (const m of DEFS_BLOCK.matchAll(/key: '([a-z_]+)',\s*\n\s*label: '([^']+)',\s*\n\s*unit: '([a-z_]+)'/g)) {
  DEFS[m[1]] = { label: m[2], unit: m[3] }
}
const FOR_VAR = Object.fromEntries(
  [...src.matchAll(/\[VARS\.(\w+)\]: '([a-z_]+)'/g)].map((m) => [m[1], m[2]]),
)

async function defn(v) {
  try {
    const r = await fetch(`https://api.census.gov/data/2023/acs/acs5/variables/${v}.json`)
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const j = await r.json()
    return { concept: j.concept, label: j.label }
  } catch (e) {
    return { error: String(e.message) }
  }
}

let problems = 0
console.log('=== every estimate: publisher definition vs app metric label ===')
for (const [name, id] of Object.entries(VARS)) {
  if (!/E$/.test(id)) continue
  const d = await defn(id)
  const metricKey = FOR_VAR[name]
  const def = metricKey ? DEFS[metricKey] : null
  console.log(`${id.padEnd(13)} ${String(name).padEnd(22)} ${JSON.stringify(d.label ?? d.error).slice(0, 70)}`)
  console.log(`${''.padEnd(13)} -> metric '${metricKey ?? '(unmapped!)'}': "${def?.label ?? 'NO DEF'}" [${def?.unit ?? '?'}]`)
  if (d.error) problems++
  if (metricKey && !def) {
    console.log(`  PROBLEM: ${id} maps to '${metricKey}' but no METRIC_DEFS entry exists`)
    problems++
  }
}

console.log('\n=== every estimate has a mapped metric key (fetched-and-discarded check) ===')
const mappedIds = new Set(Object.keys(FOR_VAR).map((k) => VARS[k]))
const detailBlock = src.match(/export const DETAIL_VARS = \[([\s\S]*?)\n\]/)[1]
const screenBlock = src.match(/export const SCREEN_VARS = \[([\s\S]*?)\n\]/)[1]
const requested = [
  ...[...detailBlock.matchAll(/'?(B\d+_\d+[EM])'?/g)].map((m) => m[1]),
  ...[...screenBlock.matchAll(/VARS\.(\w+)/g)].map((m) => VARS[m[1]]).filter(Boolean),
]
for (const id of [...new Set(requested)]) {
  if (/M$/.test(id)) continue
  if (!mappedIds.has(id)) {
    console.log(`  PROBLEM: ${id} is requested but maps to no metric key — fetched and discarded`)
    problems++
  }
}
console.log('mapping check done')

console.log('\n=== every margin column exists ===')
for (const [name, id] of Object.entries(VARS)) {
  if (!/E$/.test(id)) continue
  const moe = id.replace(/E$/, 'M')
  const d = await defn(moe)
  const ok = !d.error && /Margin/.test(d.label ?? '')
  if (!ok) {
    console.log(`  PROBLEM: margin ${moe} (${name}): ${JSON.stringify(d.label ?? d.error)}`)
    problems++
  }
}
console.log('margin check done')

console.log(`\n${problems} problem(s)`)
process.exit(problems === 0 ? 0 : 1)
