import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  generateBriefingPack,
  type BriefingFigure,
  type FigureResolver,
} from '../../src/core/ai/briefing'
import { createStubProvider, deterministicBriefingProse } from '../../src/core/ai/provider'
import type { SourceRef } from '../../src/core/types'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BriefingPackView, BriefingView, MethodologyQa, requestBriefingPack } from '../../src/ui/ai/BriefingView'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const ACS: SourceRef = {
  publisher: 'U.S. Census Bureau',
  dataset: 'ACS 5-year',
  tableId: 'B25064',
  vintage: '2023',
  url: 'https://api.census.gov/data/2023/acs/acs5',
}

const FIGURES: BriefingFigure[] = [
  { key: 'median_gross_rent', geography: '96778', value: 1250, marginOfError: 90, source: ACS },
]

const HONEST: FigureResolver = async (figure) => ({
  value: figure.value,
  marginOfError: figure.marginOfError,
})

const REQ = {
  figureSetId: 'briefing-view',
  title: 'Selected places',
  viewKind: 'drilldown selection',
  places: ['Pahoa, HI'],
  figures: FIGURES,
  generatedAt: new Date('2026-10-31T00:00:00Z'),
}

describe('requestBriefingPack', () => {
  it('returns the generated pack on the happy path', async () => {
    const outcome = await requestBriefingPack(createStubProvider(), REQ, HONEST)
    expect(outcome.pack?.verifiedCount).toBe(1)
    expect(outcome.verificationFailures).toBeUndefined()
  })

  it('surfaces re-verification failures as their own outcome, not an error message', async () => {
    const tampered: FigureResolver = async () => ({ value: 1, marginOfError: 90 })
    const outcome = await requestBriefingPack(createStubProvider(), REQ, tampered)
    expect(outcome.pack).toBeUndefined()
    expect(outcome.verificationFailures?.[0]?.reason).toBe('value_mismatch')
    expect(outcome.message).toBeUndefined()
  })

  it('maps a provider failure to the unavailable message with an error state', async () => {
    const provider = createStubProvider({
      async briefing() {
        throw Object.assign(new Error('provider_down'), { code: 'provider_down' })
      },
    })
    const outcome = await requestBriefingPack(provider, REQ, HONEST, { retryDelayMs: 0 })
    expect(outcome.message).toContain('unavailable right now')
    expect(outcome.errorState).toBe('provider_down')
  })

  it('retries once on a retryable failure and returns the pack', async () => {
    let calls = 0
    const provider = createStubProvider({
      async briefing(req) {
        calls += 1
        if (calls === 1) {
          throw Object.assign(new Error('breaker_open'), { code: 'breaker_open' })
        }
        return { prose: deterministicBriefingProse(req) }
      },
    })
    const outcome = await requestBriefingPack(provider, REQ, HONEST, { retryDelayMs: 0 })
    expect(calls).toBe(2)
    expect(outcome.pack?.verifiedCount).toBe(1)
    expect(outcome.message).toBeUndefined()
  })

  it('gives up after the single retry when the failure persists', async () => {
    let calls = 0
    const provider = createStubProvider({
      async briefing() {
        calls += 1
        throw Object.assign(new Error('provider_down'), { code: 'provider_down' })
      },
    })
    const outcome = await requestBriefingPack(provider, REQ, HONEST, { retryDelayMs: 0 })
    expect(calls).toBe(2)
    expect(outcome.message).toContain('unavailable right now')
    expect(outcome.errorState).toBe('provider_down')
  })

  it('never retries a non-retryable failure', async () => {
    let calls = 0
    const provider = createStubProvider({
      async briefing() {
        calls += 1
        throw Object.assign(new Error('bad_key'), { code: 'bad_key' })
      },
    })
    const outcome = await requestBriefingPack(provider, REQ, HONEST, { retryDelayMs: 0 })
    expect(calls).toBe(1)
    expect(outcome.errorState).toBe('bad_key')
  })

  it('never retries a verification failure', async () => {
    let providerCalls = 0
    let resolverCalls = 0
    const provider = createStubProvider({
      async briefing(req) {
        providerCalls += 1
        return { prose: deterministicBriefingProse(req) }
      },
    })
    // Verification runs before the provider call, so a refused figure
    // means zero provider calls; a retry would re-run the resolver.
    const tampered: FigureResolver = async () => {
      resolverCalls += 1
      return { value: 1, marginOfError: 90 }
    }
    const outcome = await requestBriefingPack(provider, REQ, tampered, { retryDelayMs: 0 })
    expect(providerCalls).toBe(0)
    expect(resolverCalls).toBe(1)
    expect(outcome.verificationFailures?.[0]?.reason).toBe('value_mismatch')
  })
})

describe('BriefingPackView', () => {
  it('renders cover, figures with provenance, appendix, and the pack note', async () => {
    const pack = await generateBriefingPack(REQ, {
      provider: createStubProvider(),
      resolveFigure: HONEST,
    })
    const html = renderToStaticMarkup(<BriefingPackView pack={pack} />)
    expect(html).toContain('Briefing pack — Selected places')
    expect(html).toContain('1,250 ± 90')
    expect(html).toContain('B25064')
    expect(html).toContain('Methodology and citations')
    expect(html).toContain('describe places, not people')
  })

  it('renders a withheld narrative without the refused wording', async () => {
    const provider = createStubProvider({
      async briefing() {
        return { prose: 'The median gross rent is 9,999.' }
      },
    })
    const pack = await generateBriefingPack(REQ, { provider, resolveFigure: HONEST })
    const html = renderToStaticMarkup(<BriefingPackView pack={pack} />)
    expect(html).toContain('Explanation withheld')
    expect(html).not.toContain('9,999')
  })
})

describe('MethodologyQa', () => {
  it('renders the Q&A entry with its scope stated', () => {
    const html = renderToStaticMarkup(<MethodologyQa />)
    expect(html).toContain('Ask about the data')
    expect(html).toContain('Methodology question')
    expect(html).toContain('Questions about the figures themselves belong to search')
  })
})

// Item-16 audit cure C6 (2026-11-02): BriefingPanel was a second,
// unmounted implementation of the briefing act — no production
// surface imported it; App mounts BriefingView only. It is deleted,
// and the briefing contract is pinned here on the survivor. The pack
// prose / withheld / verification-failure paths the panel tests used
// to cover are pinned on the survivor's own pieces above:
// requestBriefingPack (generation + verification refusal) and
// BriefingPackView (pack prose, withheld narrative, disclosure).
// This block replaces the deleted component's render-contract tests;
// the change is recorded here per the audit's pin discipline.
describe('BriefingView (C6 survivor)', () => {
  const baseProps = {
    provider: createStubProvider(),
    title: REQ.title,
    viewKind: REQ.viewKind,
    places: REQ.places,
    resolveFigure: HONEST,
  }

  it('with no figures open, asks for a place first and offers no generate action', () => {
    const html = renderToStaticMarkup(<BriefingView {...baseProps} figures={[]} />)
    expect(html).toContain('Briefing pack')
    expect(html).toContain('Open a place first')
    expect(html).not.toContain('Generate briefing pack')
  })

  it('with figures open, shows the single generate action for the pack', () => {
    const html = renderToStaticMarkup(<BriefingView {...baseProps} figures={FIGURES} />)
    expect(html).toContain('Generate briefing pack')
    expect(html).not.toContain('Brief this view')
  })
})

describe('C6 pin: exactly one component implements the briefing act', () => {
  it('BriefingPanel is deleted and no source file references it', () => {
    expect(existsSync(join(repoRoot, 'src/ui/ai/BriefingPanel.tsx'))).toBe(false)
    const app = readFileSync(join(repoRoot, 'src/ui/App.tsx'), 'utf8')
    expect(app).not.toContain('BriefingPanel')
    expect(app).toContain('BriefingView')
  })
})
