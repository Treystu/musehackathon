import { afterEach, expect, it, vi } from 'vitest'
import { fetchResilient, getJson } from './http'
import { _resetPacing, configureRateLimit, resetBudget } from './ratelimit'

// The response cache's storage is IndexedDB, absent in this
// environment; the K10 cache pin below mocks the cache module at
// its seam with an in-memory store, because the property under
// test is getJson's consult-before-spend order, not the storage
// engine (the engine's own behavior is the browser's).
const memoryCache = new Map<string, { body: unknown; fetchedAt: number }>()
vi.mock('./cache', () => ({
  readCache: async (url: string) => memoryCache.get(url) ?? null,
  writeCache: async (url: string, body: unknown) => {
    memoryCache.set(url, { body, fetchedAt: Date.now() })
  },
  isFresh: () => true,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  _resetPacing()
  resetBudget()
  configureRateLimit({ minIntervalMs: 400, maxConcurrency: 2, dailyBudget: 450 })
})

it('keeps same-URL callers independent when one cancellation scope is aborted', async () => {
  configureRateLimit({ minIntervalMs: 0, maxConcurrency: 2, dailyBudget: 450 })
  const first = new AbortController()
  const second = new AbortController()
  let firstStarted!: () => void
  let secondStarted!: () => void
  const firstRequestStarted = new Promise<void>((resolve) => { firstStarted = resolve })
  const secondRequestStarted = new Promise<void>((resolve) => { secondStarted = resolve })
  const mockFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal
    if (signal === first.signal) {
      firstStarted()
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    }

    secondStarted()
    return Promise.resolve(new Response('{"value":42}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  })
  vi.stubGlobal('fetch', mockFetch)

  const canceledRequest = getJson('https://example.test/shared', { signal: first.signal, cache: false })
  await firstRequestStarted
  const survivingRequest = getJson('https://example.test/shared', { signal: second.signal, cache: false })
  await secondRequestStarted

  first.abort()

  await expect(canceledRequest).rejects.toMatchObject({ name: 'AbortError' })
  await expect(survivingRequest).resolves.toEqual({ value: 42 })
  expect(mockFetch).toHaveBeenCalledTimes(2)
})

it('does not retry a request after its signal is aborted', async () => {
  const controller = new AbortController()
  let started!: () => void
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  const mockFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal
    started()
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  vi.stubGlobal('fetch', mockFetch)

  const request = fetchResilient('https://example.test/abort', { signal: controller.signal })
  await requestStarted
  controller.abort()

  await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  expect(mockFetch).toHaveBeenCalledTimes(1)
})

it('a cache-served repeat costs no fetch and no counted budget (Lane completion K10)', async () => {
  configureRateLimit({ minIntervalMs: 0, maxConcurrency: 2, dailyBudget: 100_000 })
  const { budgetState } = await import('./ratelimit')
  const mockFetch = vi.fn(() =>
    Promise.resolve(
      new Response('{"value":7}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  )
  vi.stubGlobal('fetch', mockFetch)
  const signal = new AbortController().signal
  const first = await getJson('https://example.test/k10-cache', { signal })
  expect(first).toEqual({ value: 7 })
  expect(mockFetch).toHaveBeenCalledTimes(1)
  expect(budgetState().used).toBe(1)
  // The repeat is served from the response cache: the fetch count
  // and the counted budget both stand still. This is the property
  // the judging-window hardening relies on — per-session draw is
  // reduced by the cache, never by walling the reader.
  const second = await getJson('https://example.test/k10-cache', { signal })
  expect(second).toEqual({ value: 7 })
  expect(mockFetch).toHaveBeenCalledTimes(1)
  expect(budgetState().used).toBe(1)
})
