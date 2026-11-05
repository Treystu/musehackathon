// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/ui/App'
import { SHARED_APP_KEYS_GLOBAL } from '../../src/core/config/shared-app-key'
import { resetPlaceIndexCache } from '../../src/core/zcta-place-index'
import { _resetPacing, resetBudget } from '../../src/core/ratelimit'
import { SCREEN_VARS } from '../../src/core/plugins/acs'
import { AskPanel, START_OVER_LABEL, resetAskSession } from '../../src/ui/ai/AskPanel'
import { AskSessionStore } from '../../src/ui/ai/session-store'
import { createStubProvider } from '../../src/core/ai/provider'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', window.location.pathname)
  resetBudget()
  _resetPacing()
  resetPlaceIndexCache()
  ;(globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL] = {
    CENSUS_APP_KEY: 'fake-shared-key-for-tests',
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  resetPlaceIndexCache()
  delete (globalThis as Record<string, unknown>)[SHARED_APP_KEYS_GLOBAL]
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function waitFor(predicate: () => boolean, budgetMs = 20000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    let ok = false
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      ok = predicate()
    })
    if (ok) return true
    if (Date.now() - start > budgetMs) return false
  }
}

function pageText(): string {
  return container.textContent ?? ''
}

const SWEEP_INTENT = {
  mode: 'sweep_filter',
  geographies: [] as string[],
  metricKeys: ['median_gross_rent'],
  filters: [{ metricKey: 'median_gross_rent', op: 'lt', value: 1500 }],
  clarificationNeeded: false,
}

const TEST_ZCTAS = ['96720', '96749', '96778']
const PLACES_JSON = readFileSync(join(process.cwd(), 'public/map/zcta-places.json'), 'utf8')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installSweepFetch() {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/map/zcta-places.json')) {
      return new Response(PLACES_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('tigerweb.geo.census.gov')) {
      const features = TEST_ZCTAS.map((z) => ({ attributes: { ZCTA5: z } }))
      return jsonResponse(200, { features })
    }
    if (url.includes('api.census.gov')) {
      const params = new URL(url).searchParams
      const vars = (params.get('get') ?? '').split(',').filter(Boolean)
      const header = [...vars, 'zip code tabulation area']
      const rows = TEST_ZCTAS.map((z) =>
        header.map((h) => {
          if (h === 'NAME') return `ZCTA5 ${z}`
          if (h === 'zip code tabulation area') return z
          if (h === SCREEN_VARS[0]) return '1400'
          if (h.endsWith('M')) return '10'
          return '1000'
        }),
      )
      return jsonResponse(200, [header, ...rows])
    }
    if (url.includes('/api/muse/intent')) {
      return jsonResponse(200, { intent: SWEEP_INTENT })
    }
    if (url.includes('/api/muse/jev')) {
      return jsonResponse(503, { error: 'jev_unavailable' })
    }
    if (url.includes('/api/muse/research')) {
      return jsonResponse(200, { prose: '', sources: [] })
    }
    return jsonResponse(404, { error: 'unstubbed' })
  }
  vi.stubGlobal('fetch', vi.fn(handler))
}

async function typeAndSubmit(text: string) {
  const input = container.querySelector('#ask-input') as HTMLInputElement
  const form = container.querySelector('form') as HTMLFormElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('input value setter unavailable')
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('H2 labeled reset + input persistence', () => {
  it('reset clears the session store', () => {
    const store = new AskSessionStore()
    store.setPanel({ text: 'where is rent cheap', intent: { ...SWEEP_INTENT, mode: 'sweep_filter' } as never })
    store.setAnswerState({ request: { id: 1, intent: { ...SWEEP_INTENT, mode: 'sweep_filter' } as never, queryText: 'q' } })
    store.beginStageRun('screening')
    resetAskSession(store)
    const snap = store.getSnapshot()
    expect(snap.panel.text).toBe('')
    expect(snap.panel.intent).toBeNull()
    expect(snap.answer.request).toBeNull()
    expect(snap.answer.answer).toBeNull()
    expect(snap.stage).toBeNull()
  })

  it('Start over control is visible and clears in one action', async () => {
    const store = new AskSessionStore()
    store.setPanel({ text: 'where is rent cheap' })
    const provider = createStubProvider({})
    render(<AskPanel session={store} provider={provider} parseRetryDelaysMs={[]} />)
    await flush()
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === START_OVER_LABEL)
    expect(btn).not.toBeUndefined()
    expect(START_OVER_LABEL).toBe('Start over')
    await act(async () => {
      ;(btn as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(store.getSnapshot().panel.text).toBe('')
  })

  it('Ask input stays mounted after a sweep terminal', async () => {
    installSweepFetch()
    render(<App />)
    expect(await waitFor(() => container.querySelector('#ask-input') !== null)).toBe(true)
    await typeAndSubmit('where is rent under $1,500')
    // Sweep terminal lands the answer card.
    expect(await waitFor(() => pageText().includes('Answer'), 30000)).toBe(true)
    await flush(200)
    // The mode switch to data must not unmount the Ask input.
    const input = container.querySelector('#ask-input')
    expect(input).not.toBeNull()
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === START_OVER_LABEL)).toBe(true)
  }, 60000)
})
