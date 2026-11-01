import { describe, expect, it } from 'vitest'
import {
  buildDiagnosticsExport,
  collectDiagnostics,
  createDiagnostics,
  DIAGNOSTICS_SCHEMA,
  emptySnapshot,
  parseServerObservation,
  safeBranch,
  safeCommit,
  safeOrigin,
  sanitizeSnapshot,
  type DiagnosticsSnapshot,
  type RouteOutcome,
  type ServerObservation,
} from '../../src/core/ai/diagnostics'

const SECRET = 'sk-live-SENTINEL-9f2c-NEVER-EXPORT'
const PROMPT = 'SENTINEL what is the median rent in a place I care about'
const PROVIDER_MESSAGE = 'SENTINEL third-party error body with details'

function memoryStore(initial: string | null = null) {
  let value = initial
  return {
    read: () => value,
    write: (next: string) => {
      value = next
    },
    current: () => value,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const GOOD_SERVER_PAYLOAD = {
  schema: DIAGNOSTICS_SCHEMA,
  sharedKeyPresent: true,
  modelIsDefault: true,
  perClientCap: 'unset',
  meterPersistence: 'isolate',
  budgetCapMicroUsd: 52_500_000,
  spentMicroUsd: 1_200,
  requests: 3,
  tokensIn: 300,
  tokensOut: 90,
  budgetExhausted: false,
  breaker: 'closed',
  errors: { invented_numeral: 2, unexpected: 1 },
  deployment: { pages: true, branch: 'submission', commit: 'd4a7dc6' },
}

describe('diagnostics counters', () => {
  it('increments known classes and ignores unknown ones', () => {
    const store = memoryStore()
    const recorder = createDiagnostics(store)
    recorder.recordWithhold('invented_numeral')
    recorder.recordWithhold('invented_numeral')
    recorder.recordIntentFailure('bad_key')
    recorder.recordErrorState('unexpected')
    recorder.recordWithhold(SECRET)
    recorder.recordIntentFailure(PROMPT)
    recorder.recordErrorState(PROVIDER_MESSAGE)

    const snapshot = recorder.snapshot()
    expect(snapshot.withholds.invented_numeral).toBe(2)
    expect(snapshot.intentFailures.bad_key).toBe(1)
    expect(snapshot.errorStates.unexpected).toBe(1)
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
    expect(JSON.stringify(snapshot)).not.toContain(PROMPT)
    expect(JSON.stringify(store.current())).not.toContain(PROVIDER_MESSAGE)
  })

  it('returns a copy so callers cannot mutate recorded state', () => {
    const recorder = createDiagnostics(memoryStore())
    const first = recorder.snapshot()
    first.withholds.precision = 99
    expect(recorder.snapshot().withholds.precision).toBe(0)
  })

  it('drops hostile keys and prose from stored data', () => {
    const stored = JSON.stringify({
      withholds: { invented_numeral: 4, [SECRET]: 9, [PROMPT]: 9 },
      intentFailures: { bad_key: 2, [PROVIDER_MESSAGE]: 9 },
      errorStates: { unexpected: 1 },
      secret: SECRET,
      message: PROVIDER_MESSAGE,
    })
    const snapshot = sanitizeSnapshot(JSON.parse(stored))
    expect(snapshot.withholds.invented_numeral).toBe(4)
    expect(snapshot.intentFailures.bad_key).toBe(2)
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
    expect(JSON.stringify(snapshot)).not.toContain(PROMPT)
    expect(JSON.stringify(snapshot)).not.toContain(PROVIDER_MESSAGE)
  })

  it('survives malformed storage without throwing or inventing counts', () => {
    const recorder = createDiagnostics(memoryStore('{not json'))
    expect(recorder.snapshot()).toEqual(emptySnapshot())
    recorder.recordWithhold('precision')
    expect(recorder.snapshot().withholds.precision).toBe(1)
  })
})

describe('server observation parsing', () => {
  it('drops extra fields and unknown error classes', () => {
    const observation = parseServerObservation(
      {
        ...GOOD_SERVER_PAYLOAD,
        errors: { invented_numeral: 2, [SECRET]: 99 },
        secret: SECRET,
        prompt: PROMPT,
        message: PROVIDER_MESSAGE,
      },
      200,
    )
    expect(observation.outcome).toBe('reported')
    expect(observation.errors.invented_numeral).toBe(2)
    expect(JSON.stringify(observation)).not.toContain(SECRET)
    expect(JSON.stringify(observation)).not.toContain(PROMPT)
    expect(JSON.stringify(observation)).not.toContain(PROVIDER_MESSAGE)
  })

  it('reports a payload without the schema as unavailable rather than guessing', () => {
    const observation = parseServerObservation({ ...GOOD_SERVER_PAYLOAD, schema: 'other' }, 200)
    expect(observation.outcome).toBe('unavailable')
    expect(observation.sharedKeyPresent).toBeNull()
    expect(observation.deployment.commit).toBeNull()
  })
})

describe('export artifact', () => {
  it('contains real observed values and no sentinel from any input', () => {
    const store = memoryStore(
      JSON.stringify({
        withholds: { invented_numeral: 7, [SECRET]: 1 },
        intentFailures: { bad_key: 2 },
        errorStates: { unexpected: 1 },
        prompt: PROMPT,
      }),
    )
    const recorder = createDiagnostics(store)
    const server = parseServerObservation(
      {
        ...GOOD_SERVER_PAYLOAD,
        errors: { invented_numeral: 2, [SECRET]: 99 },
        secret: SECRET,
        prompt: PROMPT,
        message: PROVIDER_MESSAGE,
      },
      200,
    )
    const artifact = buildDiagnosticsExport({
      origin: 'https://example.test',
      generatedAt: new Date('2026-10-30T12:00:00.000Z'),
      server,
      routes: {
        intent: { status: 400, outcome: 'refused_shape' },
        explain: { status: 503, outcome: 'no_shared_key' },
      },
      local: recorder.snapshot(),
    })

    expect(artifact.generatedAt).toBe('2026-10-30T12:00:00.000Z')
    expect(artifact.origin).toBe('https://example.test')
    expect(artifact.server.requests).toBe(3)
    expect(artifact.server.deployment.commit).toBe('d4a7dc6')
    expect(artifact.local.withholds.invented_numeral).toBe(7)
    expect(artifact.routes.intent.outcome).toBe('refused_shape')
    expect(artifact.routes.explain.outcome).toBe('no_shared_key')

    const text = JSON.stringify(artifact)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(PROMPT)
    expect(text).not.toContain(PROVIDER_MESSAGE)
  })

  it('rebuilds every field, so injected fields and enum values cannot pass through', () => {
    const poisoned = {
      origin: 'https://example.test',
      generatedAt: new Date('2026-10-30T12:00:00.000Z'),
      server: {
        ...parseServerObservation(GOOD_SERVER_PAYLOAD, 200),
        secret: SECRET,
        deployment: {
          pages: true,
          branch: 'submission',
          commit: 'd4a7dc6',
          message: PROVIDER_MESSAGE,
        },
      } as ServerObservation,
      routes: {
        intent: { status: 200, outcome: 'attacker-chosen' as RouteOutcome },
        explain: { status: null, outcome: 'unreachable' as RouteOutcome },
      },
      local: {
        withholds: { invented_numeral: 3, [SECRET]: 99 },
        intentFailures: {},
        errorStates: {},
        prompt: PROMPT,
      } as unknown as DiagnosticsSnapshot,
    }

    const artifact = buildDiagnosticsExport(poisoned)
    const text = JSON.stringify(artifact)
    expect(artifact.routes.intent.outcome).toBe('unexpected_status')
    expect(artifact.local.withholds.invented_numeral).toBe(3)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(PROMPT)
    expect(text).not.toContain(PROVIDER_MESSAGE)
  })

  it('keeps every string value inside the closed schema', () => {
    const artifact = buildDiagnosticsExport({
      origin: 'http://127.0.0.1:8799',
      generatedAt: new Date('2026-10-30T12:00:00.000Z'),
      server: parseServerObservation(GOOD_SERVER_PAYLOAD, 200),
      routes: {
        intent: { status: 400, outcome: 'refused_shape' },
        explain: { status: 503, outcome: 'no_shared_key' },
      },
      local: emptySnapshot(),
    })

    const allowed = new Set<string>([
      DIAGNOSTICS_SCHEMA,
      'reported',
      'unavailable',
      'configured',
      'unset',
      'unknown',
      'isolate',
      'durable',
      'closed',
      'open',
      'half-open',
      'refused_shape',
      'no_shared_key',
      'route_missing',
      'unexpected_status',
      'unreachable',
      'server-diagnostics-unavailable',
      'shared-key-state-unknown',
      'meter-state-unknown',
      'deployment-identity-unknown',
      'route-probe-unreachable',
      'intent_gate',
      'invented_numeral',
      'precision',
      'banned_construction',
      'not_allowlisted',
      'shape_invalid',
      'rate_limited',
      'credits_exhausted',
      'provider_down',
      'bad_key',
      'budget_exhausted',
      'breaker_open',
      'unexpected',
      'submission',
      'd4a7dc6',
      'http://127.0.0.1:8799',
    ])
    const patterns = [
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i,
      /^[0-9a-f]{7,40}$/,
      /^[A-Za-z0-9._/-]{1,100}$/,
    ]

    const visit = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        const ok = allowed.has(value) || patterns.some((re) => re.test(value))
        expect(ok, `unexpected string at ${path}: ${value}`).toBe(true)
        return
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`))
        return
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          visit(child, path ? `${path}.${key}` : key)
        }
      }
    }
    visit(artifact, '$')
  })
})

describe('collection against a live surface', () => {
  it('records the real status of each route and asks the deployment for its facts', async () => {
    const calls: string[] = []
    const doFetch: typeof fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/muse/diagnostics')) {
        return jsonResponse({ ...GOOD_SERVER_PAYLOAD, thirtyParty: PROVIDER_MESSAGE })
      }
      if (url.endsWith('/api/muse/intent')) return jsonResponse({ error: 'shape_invalid' }, 400)
      if (url.endsWith('/api/muse/explain')) return jsonResponse({ error: 'provider_down' }, 503)
      return new Response('not found', { status: 404 })
    }

    const artifact = await collectDiagnostics({
      fetchImpl: doFetch,
      origin: 'https://example.test',
      recorder: createDiagnostics(memoryStore()),
      now: () => new Date('2026-10-30T12:00:00.000Z'),
    })

    expect(calls).toContain('https://example.test/api/muse/diagnostics')
    expect(artifact.server.outcome).toBe('reported')
    expect(artifact.server.sharedKeyPresent).toBe(true)
    expect(artifact.routes.intent).toEqual({ status: 400, outcome: 'refused_shape' })
    expect(artifact.routes.explain).toEqual({ status: 503, outcome: 'no_shared_key' })
    expect(JSON.stringify(artifact)).not.toContain(PROVIDER_MESSAGE)
  })

  it('reports unavailable rather than guessing when every fetch fails', async () => {
    const doFetch: typeof fetch = async () => {
      throw new Error('network down')
    }
    const artifact = await collectDiagnostics({
      fetchImpl: doFetch,
      origin: 'https://example.test',
      recorder: createDiagnostics(memoryStore()),
      now: () => new Date('2026-10-30T12:00:00.000Z'),
    })
    expect(artifact.server.outcome).toBe('unavailable')
    expect(artifact.routes.intent.outcome).toBe('unreachable')
    expect(artifact.unknowns).toContain('server-diagnostics-unavailable')
    expect(artifact.unknowns).toContain('route-probe-unreachable')
    expect(artifact.unknowns).toContain('shared-key-state-unknown')
  })
})

describe('sanitizers', () => {
  it('keeps origin to scheme and host only', () => {
    expect(safeOrigin('https://example.test/app?q=SENTINEL')).toBe('https://example.test')
    expect(safeOrigin('http://127.0.0.1:8799')).toBe('http://127.0.0.1:8799')
    expect(safeOrigin('https://user:pass@example.test')).toBe('unknown')
    expect(safeOrigin('javascript:alert(1)')).toBe('unknown')
    expect(safeOrigin('not a url')).toBe('unknown')
  })

  it('accepts only branch and commit shapes a platform can produce', () => {
    expect(safeBranch('submission')).toBe('submission')
    expect(safeBranch('lane/submission')).toBe('lane/submission')
    expect(safeBranch('lane/submission with prose')).toBeNull()
    expect(safeBranch('lane/../secret')).toBeNull()
    expect(safeCommit('d4a7dc6')).toBe('d4a7dc6')
    expect(safeCommit('main')).toBeNull()
    expect(safeCommit('d4a7dc6 and a message')).toBeNull()
  })
})
