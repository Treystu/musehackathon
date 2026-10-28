import { useState, type FormEvent } from 'react'
import {
  clearMetaKey,
  getMetaKey,
  setMetaKey,
  validateMetaKey,
  type MetaKeyFetcher,
  type MetaKeyValidation,
} from '../../core/ai/meta-key'

export type ByoStatus = 'idle' | 'stored' | MetaKeyValidation

export const BYO_STATUS_COPY: Record<ByoStatus, string> = {
  idle: 'No personal key is stored.',
  stored: 'A personal key is stored in this browser.',
  valid: 'The key was accepted and stored in this browser.',
  malformed: 'That key does not look complete. Nothing was stored.',
  rejected: 'The provider rejected that key. Nothing was stored.',
  network: 'The key could not be checked right now. Nothing was stored.',
}

/**
 * Settings-only BYO surface. The key never leaves the browser except for
 * the visitor's own provider calls; it is never sent to the shared meter.
 */
export function ByoSettings({
  fetcher,
  onChange,
}: {
  fetcher?: MetaKeyFetcher
  onChange?: (present: boolean) => void
}) {
  const [raw, setRaw] = useState('')
  const [status, setStatus] = useState<ByoStatus>(getMetaKey() ? 'stored' : 'idle')
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!raw.trim() || busy) return
    setBusy(true)
    try {
      if (fetcher) {
        const verdict = await validateMetaKey(raw, fetcher)
        setStatus(verdict)
        if (verdict === 'valid') {
          setMetaKey(raw)
          setRaw('')
          onChange?.(true)
        }
        return
      }
      const ok = setMetaKey(raw)
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
    clearMetaKey()
    setRaw('')
    setStatus('idle')
    onChange?.(false)
  }

  return (
    <section aria-label="Personal key settings">
      <h3>Personal key (optional)</h3>
      <p>
        Shared mode needs no key. A personal key stays in this browser and is
        used only for your own calls.
      </p>
      <form onSubmit={save}>
        <label htmlFor="byo-key">Meta key</label>
        <input
          id="byo-key"
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
        {BYO_STATUS_COPY[status]}
      </p>
    </section>
  )
}
