/**
 * HTTP layer: request deduplication, quota accounting, and graceful failure.
 *
 * Every request from here originates in the user's browser. That is a product
 * and legal decision, not an accident: a server that sees who searched where
 * can allocate results differently per person, which is precisely the conduct
 * that fair housing enforcement targets. This layer has no backend to call.
 */
import { isFresh, readCache, writeCache } from './cache'
import { paced } from './ratelimit'


/** Requests share a fetch only when they share a cancellation scope. */
const inFlight = new WeakMap<AbortSignal, Map<string, Promise<unknown>>>()

export interface QuotaState {
  used: number
  lastResetAt: number
}

const quota: QuotaState = { used: 0, lastResetAt: Date.now() }

const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000
const listeners = new Set<(s: QuotaState) => void>()

export function onQuotaChange(fn: (s: QuotaState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getQuota(): QuotaState {
  maybeResetQuota()
  return { ...quota }
}

function maybeResetQuota(): void {
  if (Date.now() - quota.lastResetAt > QUOTA_WINDOW_MS) {
    quota.used = 0
    quota.lastResetAt = Date.now()
    listeners.forEach((l) => l(quota))
  }
}

function countRequest(): void {
  maybeResetQuota()
  quota.used += 1
  listeners.forEach((l) => l(quota))
}

export class SourceUnavailableError extends Error {
  constructor(
    message: string,
    readonly sourceId: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SourceUnavailableError'
  }
}

export interface GetJsonOptions {
  signal: AbortSignal
  /** Counts against the visible quota meter when true. */
  metered?: boolean
  headers?: Record<string, string>
  /**
   * How long a cached response stays fresh. Defaults generously, because the
   * underlying data is annual survey data that cannot change within a day.
   */
  ttlMs?: number
  /** Set false to force a network read, for an explicit refresh. */
  cache?: boolean
}

/**
 * Statuses worth retrying.
 *
 * These are answers from an overloaded upstream, not refusals of this request:
 * 429 is the Census API's rate limit, 529 is TypeSafe's overload signal, and
 * 5xx is a server that is briefly unavailable. A 400 means the request itself
 * is wrong and retrying it would just repeat the mistake, so it is never
 * retried.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Backoff schedule.
 *
 * Exponential with full jitter, which is the standard choice for avoiding a
 * synchronised retry storm: without jitter, every client that hit the same
 * overloaded moment comes back at the same moment. The 429 case backs off much
 * harder, because being throttled means the budget is spent and a fast retry
 * simply spends more of it.
 */
function backoffMs(attempt: number, status: number): number {
  const base = status === 429 ? 3000 : 750
  const ceiling = status === 429 ? 30_000 : 12_000
  const exponential = Math.min(ceiling, base * 2 ** (attempt - 1))
  return Math.round(exponential * (0.5 + Math.random()))
}

/**
 * Fetches with bounded retries, honouring Retry-After when the service
 * supplies it and backing off exponentially with jitter otherwise.
 *
 * This is deliberately at the HTTP layer rather than wrapped around individual
 * tests, so every call site gets the same behaviour and a new data source
 * cannot opt out of it by accident.
 */
export async function fetchResilient(
  url: string,
  init: RequestInit = {},
  attempts = 4,
): Promise<Response> {
  let lastErr: unknown
  for (let i = 1; i <= attempts; i++) {
    if (init.signal?.aborted) {
      throw init.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    }
    try {
      const res = await fetch(url, init)
      if (!RETRYABLE_STATUS.has(res.status) || i === attempts) return res

      const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 30_000) : backoffMs(i, res.status))
    } catch (err) {
      lastErr = err
      if (init.signal?.aborted || i === attempts) throw err
      await sleep(1200 * i)
    }
  }
  throw lastErr
}

export async function getJson<T>(url: string, opts: GetJsonOptions): Promise<T> {
  let requests = inFlight.get(opts.signal)
  const existing = requests?.get(url)
  if (existing) return existing as Promise<T>
  if (!requests) {
    requests = new Map()
    inFlight.set(opts.signal, requests)
  }

  const p = (async (): Promise<T> => {
    // The cache is consulted before anything is spent: a hit costs no request,
    // no pacing slot, and none of the daily budget. That is what makes a repeat
    // visit free and keeps a shared key usable.
    if (opts.cache !== false) {
      const cached = await readCache<T>(url)
      if (cached && isFresh(cached, opts.ttlMs)) {
        return cached.body
      }
    }

    if (opts.metered) countRequest()

    // Pacing caps concurrency and spaces requests, so a 34-chunk sweep does not
    // arrive as 34 simultaneous heavy queries.
    const res = await paced(() =>
      fetchResilient(url, {
        signal: opts.signal,
        headers: { Accept: 'application/json', ...opts.headers },
      }),
    )

    if (!res.ok) {
      throw new SourceUnavailableError(`Request failed (${res.status})`, url, res.status)
    }
    const body = (await res.json()) as T
    if (opts.cache !== false) await writeCache(url, body)
    return body
  })()

  requests.set(url, p)
  try {
    return await p
  } finally {
    requests.delete(url)
    if (requests.size === 0) inFlight.delete(opts.signal)
  }
}
