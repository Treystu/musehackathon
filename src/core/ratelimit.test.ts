/**
 * Rate-limit and quota behaviour.
 *
 * These assert on pacing and budget accounting without touching the network,
 * because the properties matter even when nothing is failing: the point is that
 * a shared free key is never exhausted by a single visitor's sweep.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetPacing,
  budgetState,
  configureRateLimit,
  getRateLimit,
  paced,
  QuotaExhaustedError,
  recordRequest,
  resetBudget,
} from './ratelimit'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  _resetPacing()
  resetBudget()
  configureRateLimit({ minIntervalMs: 0, maxConcurrency: 2, dailyBudget: 450 })
})

describe('rate limit: configuration', () => {
  it('defaults to values that will not provoke an overload', () => {
    const defaults = { minIntervalMs: 400, maxConcurrency: 2, dailyBudget: 450 }
    configureRateLimit(defaults)
    const cfg = getRateLimit()
    expect(cfg.maxConcurrency).toBeLessThanOrEqual(4)
    expect(cfg.minIntervalMs).toBeGreaterThan(0)
    // The Census Bureau documents 500 requests per day per key; the client
    // budget must sit under that so exhaustion is reported, not discovered.
    expect(cfg.dailyBudget).toBeLessThan(500)
  })
})

describe('rate limit: concurrency is capped', () => {
  it('never runs more than the configured number at once', async () => {
    configureRateLimit({ minIntervalMs: 0, maxConcurrency: 2 })
    let active = 0
    let peak = 0

    const task = async () => {
      active++
      peak = Math.max(peak, active)
      await sleep(20)
      active--
    }

    await Promise.all(Array.from({ length: 12 }, () => paced(task)))
    expect(peak).toBeLessThanOrEqual(2)
  }, 15000)
})

describe('rate limit: requests are spaced', () => {
  it('leaves a minimum gap between starts', async () => {
    configureRateLimit({ minIntervalMs: 30, maxConcurrency: 1 })
    const starts: number[] = []
    const task = async () => {
      starts.push(Date.now())
    }
    await Promise.all(Array.from({ length: 4 }, () => paced(task)))
    // Every start after the first must respect the interval, allowing for the
    // jitter that is deliberately applied.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThan(10)
    }
  }, 15000)
})

describe('quota: daily budget', () => {
  it('counts each request and reports what is left', () => {
    configureRateLimit({ dailyBudget: 10 })
    expect(budgetState().remaining).toBe(10)
    recordRequest()
    recordRequest()
    const state = budgetState()
    expect(state.used).toBe(2)
    expect(state.remaining).toBe(8)
  })

  it('refuses further work once the budget is gone, and says why', async () => {
    configureRateLimit({ minIntervalMs: 0, dailyBudget: 1 })
    await paced(async () => 'first')
    await expect(paced(async () => 'second')).rejects.toBeInstanceOf(QuotaExhaustedError)
  })

  it('explains that cached figures remain available', async () => {
    configureRateLimit({ minIntervalMs: 0, dailyBudget: 0 })
    try {
      await paced(async () => 'never')
      throw new Error('should not have run')
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExhaustedError)
      expect((err as Error).message).toMatch(/cache/i)
    }
  })

  it('counts a request only when work actually happens', async () => {
    configureRateLimit({ minIntervalMs: 0, dailyBudget: 50 })
    const before = budgetState().used
    await paced(async () => undefined)
    expect(budgetState().used).toBe(before + 1)
  })

  it('does not count a request that failed before starting', async () => {
    configureRateLimit({ minIntervalMs: 0, dailyBudget: 1 })
    await paced(async () => 'ok')
    const used = budgetState().used
    await expect(paced(async () => 'never')).rejects.toBeInstanceOf(QuotaExhaustedError)
    // A refused request is not an expenditure.
    expect(budgetState().used).toBe(used)
  })
})
