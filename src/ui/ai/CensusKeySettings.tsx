import { useState, type FormEvent } from 'react'
import {
  CENSUS_ATTRIBUTION,
  CENSUS_SIGNUP_URL,
  clearCensusKey,
  getCensusKey,
  setCensusKey,
  validateCensusKey,
  type CensusKeyFetcher,
  type CensusKeyValidation,
} from '../../core/ai/census-key'

export type CensusStatus = 'idle' | 'stored' | CensusKeyValidation

export const CENSUS_STATUS_COPY: Record<CensusStatus, string> = {
  idle: 'No Census key is stored.',
  stored: 'A Census key is stored in this browser.',
  valid: 'The key was accepted and stored in this browser.',
  malformed:
    'That text does not contain a complete Census key (40 hexadecimal characters). Nothing was stored.',
  rejected: 'The Census API rejected that key. Nothing was stored.',
  network: 'The key could not be checked right now. Nothing was stored.',
}

/**
 * Census key entry. The key is emailed by the Census Bureau, stays in
 * this browser, and is validated by the app before it is stored; the
 * store dispatches the re-validation event the confirmation surfaces
 * listen to.
 */
export function CensusKeySettings({
  fetcher,
  onChange,
}: {
  fetcher?: CensusKeyFetcher
  onChange?: (present: boolean) => void
}) {
  const [raw, setRaw] = useState('')
  const [status, setStatus] = useState<CensusStatus>(getCensusKey() ? 'stored' : 'idle')
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!raw.trim() || busy) return
    setBusy(true)
    try {
      if (fetcher) {
        const verdict = await validateCensusKey(raw, fetcher)
        setStatus(verdict)
        if (verdict === 'valid') {
          setCensusKey(raw)
          setRaw('')
          onChange?.(true)
        }
        return
      }
      const ok = setCensusKey(raw)
      setStatus(ok ? 'stored' : 'malformed')
      if (ok) {
        setRaw('')
        onChange?.(true)
      }
    } finally {
      setBusy(false)
    }
  }

  function clear() {
    clearCensusKey()
    setRaw('')
    setStatus('idle')
    onChange?.(false)
  }

  return (
    <section aria-label="Census key settings">
      <h3>Census API key</h3>
      <p>
        A free key from the Census Bureau lets the app call the Census API
        directly. It stays in this browser. No key yet?{' '}
        <a href={CENSUS_SIGNUP_URL} target="_blank" rel="noreferrer">
          Request a Census API key
        </a>{' '}
        — it arrives by email; paste the whole message text if you like,
        the app picks the key out of it.
      </p>
      <form onSubmit={save}>
        <label htmlFor="census-key">Census key</label>
        <input
          id="census-key"
          type="password"
          autoComplete="off"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Save key
        </button>
        <button type="button" onClick={clear}>
          Clear key
        </button>
      </form>
      <p role="status" aria-live="polite">
        {CENSUS_STATUS_COPY[status]}
      </p>
      <p role="note">{CENSUS_ATTRIBUTION}</p>
    </section>
  )
}
