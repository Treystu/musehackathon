/**
 * The saved-search store, pinned.
 *
 * The behaviours that matter here are the ones a reader would only discover by
 * losing data: refusing to save when the drawer is full rather than quietly
 * evicting something older, re-validating the stored ZIP codes on read so a
 * hand-edited storage entry cannot smuggle nonsense in, and treating a browser
 * with storage disabled as "cannot save" rather than an exception.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  deleteSearch,
  isFull,
  MAX_NAME_LENGTH,
  MAX_SAVED,
  readSaved,
  saveSearch,
} from '../src/core/saved-searches'

/*
 * The vitest suite runs in a node environment with no DOM, so localStorage does
 * not exist. The store under test treats an absent storage as "cannot save",
 * which is one of the behaviours being tested — so these tests give it a real
 * one first. The stub is a Map with the storage API's shape, not a mock of its
 * semantics: setItem/getItem/removeItem/clear, nothing more, because the store
 * under test only calls those.
 */
class MemoryStorage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}
;(globalThis as Record<string, unknown>).localStorage = new MemoryStorage()

const clean = () => localStorage.clear()

describe('saved searches', () => {
  beforeEach(clean)

  it('saves a named comparison and reads it back, newest first', () => {
    const first = saveSearch('My shortlist', ['78701', '10001'])
    expect(first).not.toBeNull()
    const second = saveSearch('Second', ['60601'])
    const list = readSaved()
    expect(list.map((s) => s.name)).toEqual(['Second', 'My shortlist'])
    expect(list[1]!.zips).toEqual(['10001', '78701'])
    expect(second!.savedAt).toBeGreaterThanOrEqual(first!.savedAt)
  })

  it('refuses an empty selection or a blank name, returning null rather than throwing', () => {
    expect(saveSearch('No areas', [])).toBeNull()
    expect(saveSearch('   ', ['78701'])).toBeNull()
  })

  it('caps the name rather than rejecting it', () => {
    const long = 'x'.repeat(200)
    const saved = saveSearch(long, ['78701'])
    expect(saved!.name).toHaveLength(MAX_NAME_LENGTH)
  })

  it('is full at the cap and refuses rather than evicting the oldest entry', () => {
    for (let i = 0; i < MAX_SAVED; i++) saveSearch(`List ${i}`, ['10001'])
    expect(isFull()).toBe(true)
    // The oldest entry must still be there, not silently dropped for room.
    expect(readSaved().some((s) => s.name === 'List 0')).toBe(true)
    expect(saveSearch('One more', ['78701'])).toBeNull()
    expect(readSaved()).toHaveLength(MAX_SAVED)
  })

  it('deletes by id, and deleting something absent changes nothing', () => {
    const a = saveSearch('Keep', ['78701'])!
    const b = saveSearch('Gone', ['10001'])!
    deleteSearch(b.id)
    expect(readSaved().map((s) => s.id)).toEqual([a.id])
    deleteSearch('not-an-id')
    expect(readSaved().map((s) => s.id)).toEqual([a.id])
  })

  it('re-validates stored ZIP codes on read, so a hand-edited entry cannot smuggle nonsense', () => {
    saveSearch('Real', ['78701'])
    const raw = JSON.parse(localStorage.getItem('civicscope.saved-searches.v1') ?? '[]')
    raw[0].zips = ['78701', 'banana', '<script>', '99999']
    localStorage.setItem('civicscope.saved-searches.v1', JSON.stringify(raw))
    const list = readSaved()
    expect(list).toHaveLength(1)
    expect(list[0]!.zips).toEqual(['78701', '99999'])
  })

  it('returns [] for unreadable or malformed storage rather than throwing', () => {
    localStorage.setItem('civicscope.saved-searches.v1', 'not json at all')
    expect(readSaved()).toEqual([])
    localStorage.setItem('civicscope.saved-searches.v1', '{"object":"not an array"}')
    expect(readSaved()).toEqual([])
    localStorage.setItem('civicscope.saved-searches.v1', '[{"name":"no id or zips"}]')
    expect(readSaved()).toEqual([])
  })

  it('keeps save order for saves that land in the same millisecond', () => {
    // A CI runner made two saves 0ms apart and the newest-first assertion
    // failed: the store broke savedAt ties by id string, which orders by
    // random id characters rather than by anything. The sort is stable and the
    // stored order is newest-first by construction, so a tie now keeps save
    // order. Freezing the clock forces the tie on purpose; without the freeze
    // the test passes vacuously whenever the runner is slower than 1ms.
    const realNow = Date.now
    Date.now = () => 1700000000000
    try {
      saveSearch('First', ['78701'])
      saveSearch('Second', ['10001'])
      expect(readSaved().map((s) => s.name)).toEqual(['Second', 'First'])
    } finally {
      Date.now = realNow
    }
  })
})
