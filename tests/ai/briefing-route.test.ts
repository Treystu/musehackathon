import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { createStubProvider, type MuseProvider } from '../../src/core/ai/provider'
import { handleBriefing } from '../../functions/api/muse/briefing'

const VALUES = [{ key: 'median_gross_rent', value: 1200, marginOfError: 50 }]

function deps(handler: Partial<MuseProvider> = {}) {
  return {
    meter: new Meter(defaultMeterConfig()),
    provider: createStubProvider(handler),
    allowedModels: ['spark-test'],
  }
}

function req(body: unknown) {
  return { method: 'POST', path: '/api/muse/briefing', body, clientId: 'c1' }
}

describe('briefing route', () => {
  it('rejects missing or malformed shapes before reserving', async () => {
    const d = deps()
    const cases: unknown[] = [
      {},
      { values: VALUES },
      { figureSetId: '', values: VALUES },
      { figureSetId: 'p1', values: 'not-an-array' },
      { figureSetId: 'p1', values: [{ key: 'median_gross_rent' }] },
      { figureSetId: 'p1', values: [{ key: 'median_gross_rent', value: '1200' }] },
      { figureSetId: 'p1', values: [{ key: 'median_gross_rent', value: 1200, marginOfError: 'wide' }] },
      {
        figureSetId: 'p1',
        values: Array.from({ length: 65 }, () => ({ key: 'median_gross_rent', value: 1 })),
      },
    ]
    for (const body of cases) {
      const r = await handleBriefing(req(body), d)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.body.error).toBe('shape_invalid')
    }
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('rejects unknown figure keys and extra value fields before reserving', async () => {
    const d = deps()
    const unknown = await handleBriefing(
      req({ figureSetId: 'p1', values: [{ key: 'fabricated_metric', value: 999 }] }),
      d,
    )
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toBe('shape_invalid')

    const extra = await handleBriefing(
      req({ figureSetId: 'p1', values: [{ key: 'median_gross_rent', value: 1200, source: 'x' }] }),
      d,
    )
    expect(extra.status).toBe(400)
    expect(extra.body.error).toBe('shape_invalid')
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('returns validator-passed prose from the provider', async () => {
    const d = deps()
    const r = await handleBriefing(req({ figureSetId: 'p1', values: VALUES }), d)
    expect(r.status).toBe(200)
    expect(r.body.prose).toContain('median_gross_rent')
    expect(d.meter.snapshot().requests).toBe(1)
  })

  it('withholds prose carrying an invented numeral, returning the failure class only', async () => {
    const d = deps({
      async briefing() {
        return { prose: 'The median gross rent is 9,999 in this thriving area.' }
      },
    })
    const r = await handleBriefing(req({ figureSetId: 'p1', values: VALUES }), d)
    expect(r.status).toBe(200)
    expect(r.body.withheld).toBe(true)
    expect(r.body.failure).toBe('invented_numeral')
    expect(JSON.stringify(r.body)).not.toContain('9,999')
  })
})
