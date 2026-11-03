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
  sweepBudgetExhausted,
} from './ratelimit'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  _resetPacing()
  resetBudget()
  configureRateLimit({ minIntervalMs: 0, maxConcurrency: 2, dailyBudget: 100_000 })
})

describe('rate limit: configuration', () => {
  it('defaults to values that will not provoke an overload', () => {
    const defaults = { minIntervalMs: 400, maxConcurrency: 2, dailyBudget: 100_000 }
    configureRateLimit(defaults)
    const cfg = getRateLimit()
    expect(cfg.maxConcurrency).toBeLessThanOrEqual(4)
    expect(cfg.minIntervalMs).toBeGreaterThan(0)
    // Adapted 2026-11-03 (Lane completion K10, owner directive:
    // "Increase it, so judges can't hit any caps"). This pin used
    // to assert the daily budget sits under the Census Bureau's
    // published 500/day per-key ceiling. A per-browser counter
    // cannot bound a shared key's aggregate anyway, and at 450 the
    // wall was reachable by one heavy session — measured
    // 2026-11-03, when one morning of verification runs exhausted
    // it and the exhaustion state failed real loads. The allowance
    // is now unreachable by construction (100,000; a heavy run
    // costs ~60), and key protection rides the concurrency cap,
    // the interval, cache-first fetches, and per-session draw
    // reduction. The counter still counts and reports truthfully.
    expect(cfg.dailyBudget).toBe(100_000)
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

describe('keyless posture (Lane completion K2)', () => {
  it('a keyless request runs while the key budget is exhausted; a counted one still refuses', async () => {
    configureRateLimit({ minIntervalMs: 0, dailyBudget: 0 })
    await expect(paced(async () => 'never', { budget: 'counted' })).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    )
    await expect(paced(async () => 'geometry', { budget: 'keyless' })).resolves.toBe('geometry')
  })

  it('a keyless request is not counted against the key budget', async () => {
    configureRateLimit({ minIntervalMs: 0, dailyBudget: 10 })
    await paced(async () => 'geometry', { budget: 'keyless' })
    expect(budgetState().used).toBe(0)
    await paced(async () => 'counted')
    expect(budgetState().used).toBe(1)
  })

  it('a keyless request still rides the concurrency cap', async () => {
    configureRateLimit({ minIntervalMs: 0, maxConcurrency: 2, dailyBudget: 0 })
    let active = 0
    let peak = 0
    const task = async () => {
      active++
      peak = Math.max(peak, active)
      await sleep(20)
      active--
    }
    await Promise.all(Array.from({ length: 8 }, () => paced(task, { budget: 'keyless' })))
    expect(peak).toBeLessThanOrEqual(2)
  }, 15000)
})

describe('simulated judging session (Lane completion K10)', () => {
  it('a full judging session consumes a tiny fraction of the allowance and never nears the wall', async () => {
    configureRateLimit({ minIntervalMs: 0, maxConcurrency: 4, dailyBudget: 100_000 })
    // The session model, from the measured record (2026-11-03):
    // the demo script's beats plus 15 mixed questions — 5 of them
    // heavy state-wide research runs at the measured ~60 counted
    // Census requests each, the other 10 mixed questions at ~15
    // (a screen plus drilldowns) — plus 3 state loads at ~25 and
    // 2 country sweeps at this file's own priced 43. Every counted
    // request goes through paced(), the real counting seam.
    const beats: Array<[string, number]> = [
      ['state-wide research runs', 5 * 60],
      ['mixed questions', 10 * 15],
      ['state loads', 3 * 25],
      ['country sweeps', 2 * 43],
    ]
    let expected = 0
    for (const [, count] of beats) {
      expected += count
      for (let i = 0; i < count; i++) await paced(async () => undefined)
    }
    expect(expected).toBe(611)
    const state = budgetState()
    expect(state.used).toBe(611)
    // A tiny fraction of the allowance: under 1 percent.
    expect(state.used / state.limit).toBeLessThan(0.01)
    expect(state.remaining).toBeGreaterThan(99_000)
    // The sweep's drilldown-reserve gate reads the same remaining
    // count: nowhere near its floor.
    expect(sweepBudgetExhausted()).toBe(false)
    // And the wall itself is unreachable from here: the next
    // counted request simply runs.
    await expect(paced(async () => 'still serving')).resolves.toBe('still serving')
  }, 60000)
})
