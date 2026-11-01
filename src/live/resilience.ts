/**
 * Network resilience for the live contract suite.
 *
 * These tests assert on the shape of responses from five third-party services:
 * Census, TIGERweb, NCES, CDC and NYC Open Data. All of them return 5xx under
 * load, and a release gate that fails on the network rather than on the work
 * trains people to ignore it.
 *
 * The distinction that matters: this retries transport errors and overload
 * statuses. A failed assertion is never retried, so a data-integrity breach
 * still fails immediately and cannot be retried into a pass.
 */

import { lookupSchoolDistrict } from '../core/plugins/schools'

const NETWORK_NOISE = [
  'fetch failed',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'socket hang up',
  'network',
  'timed out',
  'timeout',
  '429',
  '500',
  '502',
  '503',
  '504',
  '529',
  'load',
  // A source that answered "unavailable" is the same class of noise. Added when
  // the NCES district lookup stopped conflating an unreachable upstream with a
  // miss: a single 500-blip was failing the live contract on a service that was
  // serving normally seconds later, and the retry wrapper could not fire because
  // the lookup returned a value instead of throwing.
  'unavailable',
]

function isNetworkNoise(err: unknown): boolean {
  const text = `${(err as Error)?.message ?? ''} ${(err as Error)?.stack ?? ''}`.toLowerCase()
  return NETWORK_NOISE.some((n) => text.includes(n))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function withNetworkRetry<T>(name: string, body: () => Promise<T>, attempts = 3): () => Promise<T> {
  return async () => {
    let last: unknown
    for (let i = 1; i <= attempts; i++) {
      try {
        return await body()
      } catch (err) {
        last = err
        if (!isNetworkNoise(err)) throw err
        if (i === attempts) {
          throw new Error(
            `${name}: the upstream data source did not answer after ${attempts} attempts. ` +
              `This is a connectivity problem, not a data-integrity failure. Last error: ${(err as Error)?.message}`,
          )
        }
        await sleep(1500 * i)
      }
    }
    throw last
  }
}

/**
 * A district lookup that fails as an exception while the upstream is blipping,
 * so `withNetworkRetry` can actually retry it.
 *
 * The lookup itself returns `{ kind: 'unavailable' }` rather than throwing — the
 * right behaviour for the application, where a thrown error would abort the whole
 * drilldown. But a returning function gives a retry wrapper nothing to catch, so
 * the two or three live contract tests that observed single NCES blips as hard
 * failures (`expected 'not-found' to be 'district'`, indistinguishable from real
 * drift) had no protection despite one of them being wrapped. This turns the
 * 'unavailable' result back into a retriable exception at the test boundary only.
 *
 * A genuine miss still returns normally and is never retried.
 */
export function districtLookup(name: string, lat: number, lon: number, signal: AbortSignal): () => Promise<import('../core/plugins/schools').SchoolLookup> {
  return withNetworkRetry(name, async () => {
    const found = await lookupSchoolDistrict(lat, lon, signal)
    if (found.kind === 'unavailable') {
      throw new Error(`NCES unavailable: ${found.reason}`)
    }
    return found
  })
}
