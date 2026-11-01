/**
 * DAG executor.
 *
 * Resolves a set of requested plugin ids into a run order, dedupes shared
 * upstream work, and runs independent branches concurrently. This is what
 * makes the school-data sweep tractable: the education plugins declare that
 * they need tract geography, and the engine figures out the ordering.
 *
 * A plugin whose upstream fails is skipped, not fatal. A dead source dims its
 * own panel; the rest of the app keeps working.
 */

import type { MetricValue, PluginRequest, Provenance, QueryContext, ZoomLevel } from './types'
import { isFresh, readCache, writeCache } from './cache'
import { getJson, SourceUnavailableError } from './http'

/** Cache freshness per source, driven by how often the upstream data changes. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export interface PluginResult {
  pluginId: string
  title: string
  status: 'ok' | 'empty' | 'unavailable' | 'needs-key' | 'skipped'
  metrics: MetricValue[]
  provenance: Provenance[]
  error?: string
}

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginRequest>()

  register(p: PluginRequest): this {
    if (this.plugins.has(p.id)) {
      throw new Error(`Duplicate plugin id: ${p.id}`)
    }
    this.plugins.set(p.id, p)
    return this
  }

  registerAll(ps: readonly PluginRequest[]): this {
    ps.forEach((p) => this.register(p))
    return this
  }

  get(id: string): PluginRequest | undefined {
    return this.plugins.get(id)
  }

  all(): PluginRequest[] {
    return [...this.plugins.values()]
  }

  /** Plugins that can contribute at or above a given zoom level. */
  activeAt(zoom: ZoomLevel): PluginRequest[] {
    return this.all().filter((p) => p.minZoom <= zoom)
  }

  /** Full transitive dependency closure for the requested ids. */
  closure(ids: readonly string[]): string[] {
    const seen = new Set<string>()
    const walk = (id: string) => {
      if (seen.has(id)) return
      const p = this.plugins.get(id)
      if (!p) return
      seen.add(id)
      p.requires?.forEach(walk)
    }
    ids.forEach(walk)
    return [...seen]
  }
}

/**
 * Dependency-first ordering for the requested ids.
 *
 * Exported for direct testing: graph bugs are far easier to pin down against
 * this function than through the full executor.
 */
export function topological(ids: readonly string[], registry: PluginRegistry): string[] {
  const visited = new Set<string>()
  const out: string[] = []
  const visit = (id: string, stack: Set<string>) => {
    if (visited.has(id)) return
    if (stack.has(id)) {
      // A cycle in plugin declarations is a programming error, not data.
      throw new Error(`Circular plugin dependency involving "${id}"`)
    }
    const p = registry.get(id)
    if (!p) return
    stack.add(id)
    p.requires?.forEach((r) => visit(r, stack))
    stack.delete(id)
    visited.add(id)
    out.push(id)
  }
  ids.forEach((id) => visit(id, new Set()))
  return out
}

/**
 * Applies centrally-enforced legal rules. Plugins cannot opt out of these.
 *
 * `protectedClassProxy` is stamped here rather than left to each plugin, for the
 * same reason the suppression threshold is: `src/core/types.ts` calls this "the
 * single most important rule in the codebase", and a rule a plugin can forget
 * inside its own file is a rule that gets forgotten. For most of this
 * repository's life the flag existed only in the interface — no plugin set it and
 * nothing read it — so the guarantee rested on nobody having added a demographic
 * sort column yet. Found while closing that gap, recorded as issue #11.
 */
function applyLegalRules(
  metrics: MetricValue[],
  suppressBelow?: number,
  protectedClassProxy?: boolean,
): MetricValue[] {
  return metrics.map((m) => {
    const stamped = protectedClassProxy ? { ...m, protectedClassProxy: true } : m
    if (stamped.value === null) {
      return { ...stamped, quality: { ...stamped.quality, suppressed: true } }
    }
    if (
      suppressBelow !== undefined &&
      /count|households|population|students/i.test(stamped.unit) &&
      Math.abs(stamped.value) < suppressBelow
    ) {
      // Minimum-n suppression: the value is withheld, and the UI is required
      // to show that it was withheld rather than showing a small, unreliable
      // number that invites over-reading.
      return { ...stamped, value: null, quality: { ...stamped.quality, suppressed: true } }
    }
    return stamped
  })
}

export interface ExecuteOptions {
  registry: PluginRegistry
  ids: readonly string[]
  ctx: QueryContext
  onPluginSettled?: (r: PluginResult) => void
}

/**
 * Executes the dependency closure of `ids`, level by level, so independent
 * plugins at the same depth run concurrently.
 */
export async function executePlugins(opts: ExecuteOptions): Promise<PluginResult[]> {
  const { registry, ids, ctx } = opts
  const closure = registry.closure(ids)
  const order = topological(closure, registry)

  const levels: string[][] = []
  let placed = 0
  let guard = 0
  while (placed < order.length && guard++ < order.length + 5) {
    const level = order.filter((id) => {
      const p = registry.get(id)
      if (!p) return false
      return (p.requires ?? []).every((r) => order.indexOf(r) >= 0 && !levelHas(levels, r))
    })
    if (level.length === 0) break
    levels.push(level)
    placed += level.length
  }

  const byId = new Map<string, PluginResult>()
  for (const id of order) {
    const p = registry.get(id)
    if (!p) continue
    byId.set(id, {
      pluginId: p.id,
      title: p.title,
      status: 'skipped',
      metrics: [],
      provenance: [],
    })
  }

  for (const level of levels) {
    const settled = await Promise.all(level.map((id) => runOne(registry.get(id)!, ctx)))
    for (const r of settled) {
      byId.set(r.pluginId, r)
      opts.onPluginSettled?.(r)
    }
  }

  // Every requested plugin is returned, including ones that did not run. The UI
  // needs to distinguish "no data here" from "not loaded at this depth yet" and
  // "add a key to see this", so silently dropping entries would destroy the
  // signal that tells the user what action, if any, would change the result.
  return order.map((id) => byId.get(id)!).filter((r): r is PluginResult => Boolean(r))
}

function levelHas(levels: string[][], id: string): boolean {
  return levels.some((l) => l.includes(id))
}

async function runOne(p: PluginRequest, ctx: QueryContext): Promise<PluginResult> {
  const base: PluginResult = {
    pluginId: p.id,
    title: p.title,
    status: 'empty',
    metrics: [],
    provenance: [],
  }

  if (p.minZoom > ctx.zoom) {
    return { ...base, status: 'skipped' }
  }
  if (p.requiresCensusKey && !ctx.censusKey) {
    return { ...base, status: 'needs-key' }
  }

  try {
    const metrics = applyLegalRules(await p.fetch(ctx), p.legal.suppressBelow, p.legal.protectedClassProxy)
    const kept = metrics.filter((m) => m.value !== null || m.quality.suppressed === true)
    return {
      ...base,
      status: kept.length ? 'ok' : 'empty',
      metrics: kept,
      provenance: metrics.slice(0, 1).map((m) => ({
        pluginId: p.id,
        fetchedAt: Date.now(),
        source: m.source,
        fromCache: false,
      })),
    }
  } catch (err) {
    if (err instanceof SourceUnavailableError) {
      return { ...base, status: 'unavailable', error: err.message }
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ...base, status: 'skipped' }
    }
    return { ...base, status: 'unavailable', error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

/**
 * Cache-aware JSON fetch used by plugins. Exposed so plugins never bypass the
 * cache or the dedup layer.
 */
export async function fetchCached<T>(
  url: string,
  signal: AbortSignal,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ body: T; fromCache: boolean }> {
  const cached = await readCache<T>(url)
  if (cached && (await isFresh(cached, ttlMs))) {
    return { body: cached.body, fromCache: true }
  }
  const body = await getJson<T>(url, { signal, metered: true })
  await writeCache(url, body)
  return { body, fromCache: false }
}
