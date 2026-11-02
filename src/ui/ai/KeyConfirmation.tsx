import { useEffect, useRef, useState } from 'react'
import {
  CENSUS_KEY_EVENT,
  getCensusKey,
  validateCensusKey,
  type CensusKeyFetcher,
} from '../../core/ai/census-key'
import {
  META_KEY_EVENT,
  getMetaKey,
  validateMetaKey,
  type MetaKeyFetcher,
} from '../../core/ai/meta-key'
import { getCensusKeySource } from '../../core/censusKey'

/**
 * Event-driven key confirmation.
 *
 * Setup success is shown only when the app's own re-validation loop
 * confirms it: this hook listens for the key modules' change events
 * (CENSUS_KEY_EVENT / META_KEY_EVENT — dispatched by the app itself when
 * it stores or clears a key), then re-reads the stored key and, when the
 * host supplies a probe, re-validates it. Nothing here accepts a claim:
 * there is no prop, callback, or agent report that can mark a key
 * confirmed, and writing storage directly without the app's event does
 * not move the state either.
 *
 * Without a probe the state stops at 'stored': the key is present
 * through the app's own path, but nothing has checked it, and the copy
 * says so — 'confirmed' is reserved for a probe verdict of valid.
 * (Live 2026-11-01: the App wires no probe, and a plainly fake key
 * displayed 'confirmed by the app in this browser'. The status now
 * names what actually happened; the key is checked when it is used.)
 *
 * Probe wiring (2026-11-02): App now passes a real Census probe — the
 * body-checked validator in src/core/censusKey.ts, which parses the
 * Census reply because that API answers HTTP 200 with an HTML error
 * page for a bad key — so the Census line can reach 'confirmed' in
 * production. No equivalent lightweight probe exists in the codebase
 * for a personal (Meta) key: the only Meta call shapes are full model
 * completions, and spending a visitor's own tokens on a completion
 * just to check their key, on every mount, would be a worse fault
 * than the gap. The personal-key line therefore still stops at
 * 'stored' by design, and its copy says exactly that.
 */
export type KeyCheckState = 'absent' | 'checking' | 'confirmed' | 'rejected' | 'stored'

export interface KeyConfirmations {
  census: KeyCheckState
  meta: KeyCheckState
}

export type KeyCheckFetchers = {
  censusFetcher?: CensusKeyFetcher
  metaFetcher?: MetaKeyFetcher
}

export const KEY_CHECK_COPY: Record<KeyCheckState, string> = {
  absent: 'not set up yet.',
  checking: 'stored — the app is re-checking it.',
  confirmed: 'confirmed by the app in this browser.',
  rejected: "stored, but the app's re-check did not accept it.",
  stored: 'stored in this browser; it is checked when it is used.',
}

export function useKeyConfirmations(fetchers: KeyCheckFetchers = {}): KeyConfirmations {
  const [checks, setChecks] = useState<KeyConfirmations>({ census: 'absent', meta: 'absent' })
  const fetchersRef = useRef(fetchers)
  fetchersRef.current = fetchers

  useEffect(() => {
    let live = true
    const seq = { census: 0, meta: 0 }

    async function recheck(which: 'census' | 'meta') {
      const mine = ++seq[which]
      const key = which === 'census' ? getCensusKey() : getMetaKey()
      if (!key) {
        if (live) setChecks((c) => ({ ...c, [which]: 'absent' }))
        return
      }
      const fetcher =
        which === 'census' ? fetchersRef.current.censusFetcher : fetchersRef.current.metaFetcher
      if (!fetcher) {
        // No probe configured: the stored key arrived through the app's
        // own store path (its change event is what brought us here),
        // but nothing has checked it — report it as stored, never as
        // confirmed.
        if (live) setChecks((c) => ({ ...c, [which]: 'stored' }))
        return
      }
      if (live) setChecks((c) => ({ ...c, [which]: 'checking' }))
      const verdict =
        which === 'census'
          ? await validateCensusKey(key, fetcher)
          : await validateMetaKey(key, fetcher)
      if (!live || seq[which] !== mine) return
      setChecks((c) => ({ ...c, [which]: verdict === 'valid' ? 'confirmed' : 'rejected' }))
    }

    void recheck('census')
    void recheck('meta')
    const onCensus = () => {
      void recheck('census')
    }
    const onMeta = () => {
      void recheck('meta')
    }
    window.addEventListener(CENSUS_KEY_EVENT, onCensus)
    window.addEventListener(META_KEY_EVENT, onMeta)
    return () => {
      live = false
      window.removeEventListener(CENSUS_KEY_EVENT, onCensus)
      window.removeEventListener(META_KEY_EVENT, onMeta)
    }
  }, [])

  return checks
}

/** The confirmation list: per-key state from the re-validation loop. */
export function KeySetupStatus(fetchers: KeyCheckFetchers) {
  const checks = useKeyConfirmations(fetchers)
  // The confirmation above tracks the visitor's own key only — by
  // design, the shared deployment key never fires the key event and
  // must not be mistaken for a completed setup. But rendering a bare
  // "not set up yet" while the app is visibly loading the full dataset
  // on the shared key reads as a contradiction (seen live 2026-11-01),
  // so the absent state names the shared key as context when one is
  // carrying the app. It still does not claim setup success.
  const [sharedActive, setSharedActive] = useState<boolean>(
    () => getCensusKeySource() === 'shared',
  )
  useEffect(() => {
    const onKey = () => setSharedActive(getCensusKeySource() === 'shared')
    window.addEventListener(CENSUS_KEY_EVENT, onKey)
    return () => window.removeEventListener(CENSUS_KEY_EVENT, onKey)
  }, [])
  return (
    <ul aria-label="Key setup status" className="mt-3 space-y-1 text-sm text-slate-700">
      <li>
        Census API key:{' '}
        {checks.census === 'absent' && sharedActive
          ? "not set up in this browser — the app is running on the project's shared application key, so the full dataset loads without one. Adding your own key is optional."
          : KEY_CHECK_COPY[checks.census]}
      </li>
      <li>
        Personal key (optional): {KEY_CHECK_COPY[checks.meta]}
      </li>
    </ul>
  )
}
