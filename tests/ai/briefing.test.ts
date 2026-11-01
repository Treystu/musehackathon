import { describe, expect, it } from 'vitest'
import {
  BriefingVerificationError,
  generateBriefingPack,
  verifyBriefingFigures,
  verifyFigureSet,
  type BriefingFigure,
  type FigureResolver,
} from '../../src/core/ai/briefing'
import {
  createMetaDirectProvider,
  createLiveProvider,
} from '../../src/core/ai/meta-client'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import {
  createStubProvider,
  type MuseProvider,
} from '../../src/core/ai/provider'
import { handleBriefing } from '../../functions/api/muse/briefing'
import type { SourceRef } from '../../src/core/types'

const ACS: SourceRef = {
  publisher: 'U.S. Census Bureau',
  dataset: 'ACS 5-year',
  tableId: 'B25064',
  vintage: '2023',
  url: 'https://api.census.gov/data/2023/acs/acs5',
  citation: 'ACS 5-year, table B25064',
}

const FIGURES: BriefingFigure[] = [
  { key: 'median_gross_rent', geography: '96778', value: 1250, marginOfError: 90, source: ACS },
  { key: 'households', geography: '96778', value: 3400, marginOfError: 120, source: ACS },
  { key: 'median_home_value', geography: '96720', value: null, source: ACS },
]

/** Resolver backed by a truth table keyed like the pack's figures. */
function resolverFor(truth: Record<string, { value: number | null; marginOfError?: number } | null>): FigureResolver {
  return async (figure) => {
    const found = truth[`${figure.key}|${figure.geography}`]
    return found === undefined ? null : found
  }
}

const HONEST = resolverFor({
  'median_gross_rent|96778': { value: 1250, marginOfError: 90 },
  'households|96778': { value: 3400, marginOfError: 120 },
  'median_home_value|96720': { value: null },
})

const PACK_REQ = {
  figureSetId: 'briefing-test',
  title: 'Hilo area briefing',
  viewKind: 'comparison',
  places: ['96778', '96720'],
  figures: FIGURES,
  packUrl: 'https://civicscope.pages.dev/?compare=96778,96720',
  generatedAt: new Date('2026-10-31T00:00:00Z'),
}

describe('briefing figure re-verification', () => {
  it('re-verifies 100% of figures against an honest source', async () => {
    const mismatches = await verifyBriefingFigures(FIGURES, HONEST)
    expect(mismatches).toEqual([])
  })

  it('fails loudly on a tampered value, naming the figure', async () => {
    const tampered = resolverFor({
      'median_gross_rent|96778': { value: 999, marginOfError: 90 },
      'households|96778': { value: 3400, marginOfError: 120 },
      'median_home_value|96720': { value: null },
    })
    const mismatches = await verifyBriefingFigures(FIGURES, tampered)
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]).toMatchObject({
      key: 'median_gross_rent',
      geography: '96778',
      reason: 'value_mismatch',
      included: 1250,
      resolved: 999,
    })
  })

  it('fails on a tampered margin of error', async () => {
    const tampered = resolverFor({
      'median_gross_rent|96778': { value: 1250, marginOfError: 5 },
      'households|96778': { value: 3400, marginOfError: 120 },
      'median_home_value|96720': { value: null },
    })
    const mismatches = await verifyBriefingFigures(FIGURES, tampered)
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.reason).toBe('moe_mismatch')
  })

  it('fails when a source no longer resolves, and when an absence is filled in', async () => {
    const gone = resolverFor({
      'median_gross_rent|96778': { value: 1250, marginOfError: 90 },
      'households|96778': { value: 3400, marginOfError: 120 },
      // median_home_value absent from the table: resolver returns null.
    })
    const mismatches = await verifyBriefingFigures(FIGURES, gone)
    expect(mismatches[0]?.reason).toBe('source_unresolvable')

    const filled = resolverFor({
      'median_gross_rent|96778': { value: 1250, marginOfError: 90 },
      'households|96778': { value: 3400, marginOfError: 120 },
      'median_home_value|96720': { value: 450000 },
    })
    const filledMismatches = await verifyBriefingFigures(FIGURES, filled)
    expect(filledMismatches[0]?.reason).toBe('value_mismatch')
  })
})

describe('briefing pack generation', () => {
  it('generates a full pack: cover, narrative, figure tables, registry appendix, note, URL', async () => {
    const pack = await generateBriefingPack(PACK_REQ, {
      provider: createStubProvider(),
      resolveFigure: HONEST,
    })
    expect(pack.verifiedCount).toBe(FIGURES.length)
    expect(pack.narrativeWithheld).toBe(false)
    expect(pack.narrative).toContain('median_gross_rent')
    expect(pack.coverLine).toContain('Hilo area briefing')
    expect(pack.coverLine).toContain('2026-10-31')
    expect(pack.coverLine).toContain('2023')
    const rentRow = pack.rows.find((r) => r.key === 'median_gross_rent')
    expect(rentRow?.headline).toBe('1,250 ± 90')
    expect(rentRow?.provenance).toContain('B25064')
    const absentRow = pack.rows.find((r) => r.key === 'median_home_value')
    expect(absentRow?.headline).toBe('Not published / suppressed')
    expect(pack.appendix.join('\n')).toContain('Median gross rent (median_gross_rent)')
    expect(pack.appendix.join('\n')).toContain('Citation: U.S. Census Bureau')
    expect(pack.fairHousingNote).toContain('describe places, not people')
    expect(pack.text).toContain('Methodology and citations:')
    expect(pack.text).toContain('This pack\u2019s view: https://civicscope.pages.dev/?compare=96778,96720')
  })

  it('refuses generation on a tampered figure and never calls the provider', async () => {
    let providerCalls = 0
    const provider = createStubProvider({
      async briefing() {
        providerCalls += 1
        return { prose: 'anything' }
      },
    })
    const tampered = resolverFor({
      'median_gross_rent|96778': { value: 1250, marginOfError: 90 },
      'households|96778': { value: 12, marginOfError: 120 },
      'median_home_value|96720': { value: null },
    })
    const error = await generateBriefingPack(PACK_REQ, {
      provider,
      resolveFigure: tampered,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BriefingVerificationError)
    const verificationError = error as BriefingVerificationError
    expect(verificationError.mismatches[0]?.key).toBe('households')
    expect(verificationError.message).toContain('households')
    expect(providerCalls).toBe(0)
  })

  it('names every bad figure in one failure, not just the first', async () => {
    const tampered = resolverFor({
      'median_gross_rent|96778': { value: 1, marginOfError: 90 },
      'households|96778': { value: 2, marginOfError: 120 },
      'median_home_value|96720': { value: null },
    })
    const error = await generateBriefingPack(PACK_REQ, {
      provider: createStubProvider(),
      resolveFigure: tampered,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BriefingVerificationError)
    expect((error as BriefingVerificationError).mismatches).toHaveLength(2)
  })

  it('withholds a narrative carrying an invented numeral, and still ships the figures', async () => {
    const provider = createStubProvider({
      async briefing() {
        return { prose: 'The median gross rent is 9,999 and households number 3400.' }
      },
    })
    const pack = await generateBriefingPack(PACK_REQ, {
      provider,
      resolveFigure: HONEST,
    })
    expect(pack.narrative).toBeUndefined()
    expect(pack.narrativeWithheld).toBe(true)
    expect(pack.withholdClass).toBe('invented_numeral')
    expect(pack.rows).toHaveLength(FIGURES.length)
    expect(pack.text).toContain('Narrative withheld')
    expect(pack.text).not.toContain('9,999')
  })

  it('carries a proxy withhold through with its class', async () => {
    const provider = createStubProvider({
      async briefing() {
        return { prose: '', withheld: true, withholdClass: 'precision' as const }
      },
    })
    const pack = await generateBriefingPack(PACK_REQ, {
      provider,
      resolveFigure: HONEST,
    })
    expect(pack.narrativeWithheld).toBe(true)
    expect(pack.withholdClass).toBe('precision')
  })

  it('refuses an empty pack and an oversize pack before any verification', async () => {
    await expect(
      generateBriefingPack({ ...PACK_REQ, figures: [] }, {
        provider: createStubProvider(),
        resolveFigure: HONEST,
      }),
    ).rejects.toThrow('at least one figure')
    const many = Array.from({ length: 65 }, (_, i) => ({
      ...FIGURES[0]!,
      geography: `967${String(i).padStart(2, '0')}`,
    }))
    await expect(
      generateBriefingPack({ ...PACK_REQ, figures: many }, {
        provider: createStubProvider(),
        resolveFigure: HONEST,
      }),
    ).rejects.toThrow('exceeds the 64-figure ceiling')
  })

  it('sends suppressed figures to the provider as no reportable value', async () => {
    let seen: { value: number | null }[] = []
    const provider = createStubProvider({
      async briefing(req) {
        seen = req.values
        return { prose: 'This pack covers the verified figures listed below.' }
      },
    })
    const figures: BriefingFigure[] = [
      { key: 'households', geography: '96778', value: 12, suppressed: true, source: ACS },
    ]
    const resolver = resolverFor({ 'households|96778': { value: 12 } })
    await generateBriefingPack({ ...PACK_REQ, figures }, { provider, resolveFigure: resolver })
    expect(seen[0]?.value).toBeNull()
  })
})

function metaReply(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('provider briefing() implementations', () => {
  it('meta-direct briefing posts the verified figures and returns the prose', async () => {
    let body: Record<string, unknown> | undefined
    const provider = createMetaDirectProvider({
      baseUrl: 'https://api.meta.ai/v1',
      model: 'muse-spark-1.3',
      getApiKey: () => 'test-key',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
        return metaReply('Median gross rent is estimated at 1250, plus or minus 90.')
      },
    })
    const result = await provider.briefing(
      { figureSetId: 'pack-1', values: [{ key: 'median_gross_rent', value: 1250, marginOfError: 90 }] },
      new AbortController().signal,
    )
    expect(result.prose).toContain('1250')
    const messages = body?.messages as { role: string; content: string }[]
    expect(messages[1]?.content).toContain('median_gross_rent: 1250 plus or minus 90')
    expect(messages[0]?.content).toContain('re-verified against their sources')
  })

  it('live provider briefing goes through the proxy route and maps a withhold', async () => {
    const provider = createLiveProvider({
      fetchImpl: async () =>
        new Response(JSON.stringify({ withheld: true, failure: 'invented_numeral' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })
    const result = await provider.briefing(
      { figureSetId: 'pack-1', values: [{ key: 'households', value: 3400 }] },
      new AbortController().signal,
    )
    expect(result.withheld).toBe(true)
    expect(result.withholdClass).toBe('invented_numeral')
    expect(result.prose).toBe('')
  })

  it('live provider briefing returns proxy prose on the happy path', async () => {
    let path = ''
    const provider = createLiveProvider({
      fetchImpl: async (url) => {
        path = String(url)
        return new Response(JSON.stringify({ prose: 'Households number 3400 here.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const result = await provider.briefing(
      { figureSetId: 'pack-1', values: [{ key: 'households', value: 3400 }] },
      new AbortController().signal,
    )
    expect(path).toContain('/api/muse/briefing')
    expect(result.prose).toContain('3400')
  })
})

// Union hand-merge (Panel B1): the Entire tree's route-level
// re-verification tests, carried over for the verifyFigureSet gate the
// union route applies before reserving. The Entire file's shape and
// generation describes are not duplicated here — the CivicScope
// briefing-route.test.ts covers those against this tree's route.
function unionDeps(handler: Partial<MuseProvider> = {}) {
  return {
    meter: new Meter(defaultMeterConfig()),
    provider: createStubProvider(handler),
    allowedModels: ['spark-test'],
  }
}

function unionReq(body: unknown) {
  return { method: 'POST', path: '/api/muse/briefing', body, clientId: 'c1' }
}

const UNION_VALUES = [
  { key: 'median_gross_rent', value: 1200, marginOfError: 50, vintage: '2023' },
  { key: 'median_rent_burden_pct', value: 31.5 },
]

describe('briefing pack composition: source re-verification (union)', () => {
  it('fails loudly on a tampered percent figure and never calls the provider', async () => {
    let called = false
    const d = unionDeps({
      async briefing() {
        called = true
        return { prose: 'unreachable' }
      },
    })
    const r = await handleBriefing(
      unionReq({
        figureSetId: 'f1',
        values: [{ key: 'median_rent_burden_pct', value: 140 }],
      }),
      d,
    )
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('shape_invalid')
    expect(String(r.body.detail)).toContain('median_rent_burden_pct')
    expect(called).toBe(false)
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('fails loudly on conflicting values for the same figure key', async () => {
    const d = unionDeps()
    const r = await handleBriefing(
      unionReq({
        figureSetId: 'f1',
        values: [
          { key: 'median_gross_rent', value: 1200 },
          { key: 'median_gross_rent', value: 1250 },
        ],
      }),
      d,
    )
    expect(r.status).toBe(422)
    expect(String(r.body.detail)).toContain('median_gross_rent')
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('fails loudly on a suppressed small-count figure', async () => {
    const d = unionDeps()
    const r = await handleBriefing(
      unionReq({ figureSetId: 'f1', values: [{ key: 'households', value: 12 }] }),
      d,
    )
    expect(r.status).toBe(422)
    expect(String(r.body.detail)).toContain('households')
  })

  it('fails loudly on a figure with no value and on a negative median', async () => {
    const d = unionDeps()
    const noValue = await handleBriefing(
      unionReq({ figureSetId: 'f1', values: [{ key: 'median_home_value', value: null }] }),
      d,
    )
    expect(noValue.status).toBe(422)
    const negative = await handleBriefing(
      unionReq({ figureSetId: 'f1', values: [{ key: 'median_home_value', value: -5 }] }),
      d,
    )
    expect(negative.status).toBe(422)
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('verifyFigureSet passes a clean set in order and accepts known derived figures', () => {
    const clean = verifyFigureSet(UNION_VALUES)
    expect(clean.ok).toBe(true)
    if (clean.ok) {
      expect(clean.figures.map((f) => f.key)).toEqual([
        'median_gross_rent',
        'median_rent_burden_pct',
      ])
    }
    const derived = verifyFigureSet([{ key: 'derived:renter_pct', value: 42 }])
    expect(derived.ok).toBe(true)
    const derivedTampered = verifyFigureSet([{ key: 'derived:renter_pct', value: 142 }])
    expect(derivedTampered.ok).toBe(false)
  })

  it('verifyFigureSet rejects bad vintages and negative margins of error', () => {
    expect(
      verifyFigureSet([{ key: 'median_gross_rent', value: 1200, vintage: '23' }]).ok,
    ).toBe(false)
    expect(
      verifyFigureSet([{ key: 'median_gross_rent', value: 1200, vintage: '1880' }]).ok,
    ).toBe(false)
    expect(
      verifyFigureSet([{ key: 'median_gross_rent', value: 1200, marginOfError: -1 }]).ok,
    ).toBe(false)
  })
})
