import { describe, expect, it } from 'vitest'
import { Meter, defaultMeterConfig } from '../../src/core/ai/meter'
import { createStubProvider, type MuseProvider } from '../../src/core/ai/provider'
import { handleResearch } from '../../functions/api/muse/research'

/**
 * Research route (2026-11-01): grounded web findings through the
 * metered proxy. A 200 always carries prose WITH sources — the
 * provider's citation gate means unsourced prose never leaves here
 * as findings.
 */
function deps(handler: Partial<MuseProvider> = {}) {
  return {
    meter: new Meter(defaultMeterConfig()),
    provider: createStubProvider(handler),
    allowedModels: ['spark-test'],
    waitOut: { breakerWaitMs: 0, pollMs: 1, retryDelaysMs: [1, 1] as number[] },
  }
}

function req(body: unknown) {
  return { method: 'POST', path: '/api/muse/research', body, clientId: 'c1' }
}

describe('research route', () => {
  it('returns prose with its sources', async () => {
    const d = deps({
      async research() {
        return {
          prose: 'Lincoln High is rated well by the state.',
          sources: [{ title: 'State school report', url: 'https://example.org/schools' }],
        }
      },
    })
    const r = await handleResearch(
      req({ queryText: 'best schools near Hilo with affordable housing', places: ['Hilo'] }),
      d,
    )
    expect(r.status).toBe(200)
    expect(r.body.prose).toContain('Lincoln High')
    expect(r.body.sources).toEqual([
      { title: 'State school report', url: 'https://example.org/schools' },
    ])
  })

  it('rejects malformed shapes before any provider call', async () => {
    const d = deps()
    for (const body of [{}, { queryText: '' }, { queryText: 'x'.repeat(501) }, { queryText: 'ok', places: [42] }]) {
      const r = await handleResearch(req(body), d)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('shape_invalid')
    }
    expect(d.meter.snapshot().requests).toBe(0)
  })

  it('withholds sourced prose that carries a banned construction', async () => {
    const d = deps({
      async research() {
        return {
          prose: 'This is the best neighbourhood in Hilo, and it is a good area for families.',
          sources: [{ title: 'A blog', url: 'https://example.org/blog' }],
        }
      },
    })
    const r = await handleResearch(req({ queryText: 'where should I live in Hilo' }), d)
    expect(r.status).toBe(200)
    expect(r.body.withheld).toBe(true)
    expect(r.body.failure).toBe('banned_construction')
    expect(r.body.prose).toBeUndefined()
    expect(d.meter.snapshot().errors.banned_construction).toBe(1)
  })

  it('an unsourced reply is a provider failure, never findings', async () => {
    const d = deps({
      async research() {
        return { prose: 'Trust me.', sources: [] }
      },
    })
    const r = await handleResearch(req({ queryText: 'schools in Hilo' }), d)
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('provider_down')
  })
})
