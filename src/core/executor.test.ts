import { describe, expect, it } from 'vitest'
import { PluginRegistry, executePlugins, topological } from './executor'
import type { MetricValue, PluginRequest } from './types'

function metric(partial: Partial<MetricValue> = {}): MetricValue {
  return {
    key: 'k',
    label: 'L',
    value: 100,
    unit: 'count',
    category: 'cost',
    source: { publisher: 'p', dataset: 'd', tableId: 't', vintage: 'v', url: 'u' },
    quality: {},
    ...partial,
  }
}

function plugin(partial: Partial<PluginRequest> & { id: string }): PluginRequest {
  return {
    title: partial.id,
    category: 'cost',
    geography: 'tract',
    minZoom: 0,
    legal: {},
    fetch: async () => [],
    ...partial,
  } as PluginRequest
}

describe('PluginRegistry', () => {
  it('rejects duplicate ids', () => {
    const r = new PluginRegistry().register(plugin({ id: 'a' }))
    expect(() => r.register(plugin({ id: 'a' }))).toThrow(/Duplicate/)
  })

  it('resolves the transitive dependency closure', () => {
    const r = new PluginRegistry().registerAll([
      plugin({ id: 'a', requires: ['b'] }),
      plugin({ id: 'b', requires: ['c'] }),
      plugin({ id: 'c' }),
      plugin({ id: 'unrelated' }),
    ])
    expect(r.closure(['a']).sort()).toEqual(['a', 'b', 'c'])
    expect(r.closure(['a'])).not.toContain('unrelated')
  })

  it('tolerates a missing dependency rather than throwing', () => {
    const r = new PluginRegistry().registerAll([plugin({ id: 'a', requires: ['ghost'] })])
    expect(r.closure(['a'])).toContain('a')
  })

  it('filters by minimum zoom level', () => {
    const r = new PluginRegistry().registerAll([
      plugin({ id: 'early', minZoom: 0 }),
      plugin({ id: 'late', minZoom: 3 }),
    ])
    expect(r.activeAt(1).map((p) => p.id)).toEqual(['early'])
    expect(r.activeAt(4).map((p) => p.id).sort()).toEqual(['early', 'late'])
  })
})

describe('topological ordering', () => {
  it('orders dependencies before dependents', () => {
    const r = new PluginRegistry().registerAll([
      plugin({ id: 'c', requires: ['b'] }),
      plugin({ id: 'b', requires: ['a'] }),
      plugin({ id: 'a' }),
    ])
    const order = topological(['c'], r)
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
  })

  it('detects a circular dependency instead of hanging', () => {
    const r = new PluginRegistry().registerAll([
      plugin({ id: 'x', requires: ['y'] }),
      plugin({ id: 'y', requires: ['x'] }),
    ])
    expect(() => topological(['x'], r)).toThrow(/Circular/)
  })
})

describe('executor', () => {
  const ctx = { zoom: 0 as const, signal: new AbortController().signal }

  it('skips plugins above the current zoom level', async () => {
    const r = new PluginRegistry().registerAll([plugin({ id: 'deep', minZoom: 4 })])
    const out = await executePlugins({ registry: r, ids: ['deep'], ctx })
    expect(out[0]?.status).toBe('skipped')
  })

  it('reports needs-key rather than failing when the key is absent', async () => {
    const r = new PluginRegistry().registerAll([
      plugin({ id: 'keyed', requiresCensusKey: true, fetch: async () => [metric()] }),
    ])
    const out = await executePlugins({ registry: r, ids: ['keyed'], ctx })
    expect(out[0]?.status).toBe('needs-key')
  })

  it('reports unavailable when a source throws, without failing the run', async () => {
    const good = plugin({ id: 'good', fetch: async () => [metric({ key: 'a' })] })
    const bad = plugin({
      id: 'bad',
      fetch: async () => {
        throw new Error('upstream down')
      },
    })
    const r = new PluginRegistry().registerAll([bad, good])
    const out = await executePlugins({ registry: r, ids: ['bad', 'good'], ctx })
    const badOut = out.find((x) => x.pluginId === 'bad')
    const goodOut = out.find((x) => x.pluginId === 'good')
    expect(badOut?.status).toBe('unavailable')
    expect(goodOut?.status).toBe('ok')
    expect(goodOut?.metrics).toHaveLength(1)
  })

  it('marks a null value as suppressed rather than coercing it to zero', async () => {
    const r = new PluginRegistry().registerAll([
      plugin({ id: 'p', fetch: async () => [metric({ value: null })] }),
    ])
    const out = await executePlugins({ registry: r, ids: ['p'], ctx })
    const m = out[0]?.metrics[0]
    expect(m?.value).toBeNull()
    expect(m?.quality.suppressed).toBe(true)
  })

  it('applies minimum-n suppression centrally', async () => {
    const r = new PluginRegistry().registerAll([
      plugin({
        id: 'p',
        legal: { suppressBelow: 100 },
        fetch: async () => [metric({ key: 'households', value: 40, unit: 'count' })],
      }),
    ])
    const out = await executePlugins({ registry: r, ids: ['p'], ctx })
    const m = out[0]?.metrics[0]
    expect(m?.value).toBeNull()
    expect(m?.quality.suppressed).toBe(true)
  })
})
