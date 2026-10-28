import type { ProxyError } from '../../core/ai/proxy-errors'
import { shouldOfferByo } from '../../core/ai/byo'

/**
 * BYO is offered only on shutoff/error, never on the shared happy path.
 * The settings surface owns key entry.
 */
export function ByoOffer({
  error,
  onOpenSettings,
}: {
  error?: ProxyError | null
  onOpenSettings?: () => void
}) {
  if (!shouldOfferByo(error)) return null
  return (
    <aside aria-label="Optional personal key">
      <p>
        The shared allowance is used up. If you have your own Meta key, you can
        add it in settings. It stays in this browser and is used only for your
        own calls.
      </p>
      {onOpenSettings ? (
        <button type="button" onClick={onOpenSettings}>
          Open key settings
        </button>
      ) : null}
    </aside>
  )
}
