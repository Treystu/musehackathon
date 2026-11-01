/**
 * What this is, and why it asks for a key.
 *
 * The application holds no data. Every figure is fetched from its publisher by the
 * visitor's own browser at the moment they ask for it, which is what makes the
 * privacy claim in `docs/governance.md` true rather than aspirational. The cost of
 * that choice is that the country-wide screen needs a free Census key before it
 * will load, and a first-time visitor meets a request before they meet any data.
 *
 * So this says so plainly, once, and then gets out of the way.
 *
 * Three implementation decisions worth stating:
 *
 * **Nothing modal appears uninvited.** The first version opened a `<dialog
 * showModal()>` on arrival. Testing found it blocked the search box — the one
 * control that works without a Census key — on every first visit, and made 22
 * browser tests fail because they could not type into it. A modal that covers the
 * primary action on the first screen is a dark pattern regardless of how easy it
 * is to dismiss, because the reader has not yet learned that dismissing is an
 * option. So first visit now gets a non-modal notice inline, and the dialog opens
 * only when asked for.
 *
 * **A native `<dialog>` with `showModal()`, not a custom modal.** Once it is asked
 * for, the browser supplies the focus trap, the initial focus placement, Escape
 * handling, and the inertness of the page behind it. All four are exactly the
 * things a hand-rolled modal gets subtly wrong, and each is a keyboard trap when
 * it does.
 *
 * **It never reappears uninvited.** Dismissal is recorded, and a permanent button
 * reopens it. A tour that keeps interrupting someone who has already read it is
 * worse than no tour, because it teaches people to dismiss dialogs without
 * reading them — which then costs us the reader who needed it.
 *
 * **The copy states the limit rather than hiding it.** This says the key is free,
 * says where it is stored, says the project never sees it, and says plainly that
 * single-area lookup works without one. A tour that oversold what is available
 * behind the key would make the actual experience worse than arriving with no
 * expectations at all.
 */
import { useEffect, useId, useRef, useState } from 'react'

/**
 * Bumped when the wording changes in a way that matters.
 *
 * The key is namespaced and versioned to match `civicscope.censusKey.v1`, so a
 * stored "already read this" cannot collide with anything else and an old flag
 * cannot suppress a tour whose content has materially changed.
 */
const STORAGE_KEY = 'civicscope.toured.v1'

interface Step {
  heading: string
  body: React.ReactNode
}

/** Read once at module scope: it cannot change within a session. */
function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    // Private mode, or storage disabled. Showing the tour again is harmless; the
    // alternative is a thrown error on first paint.
    return false
  }
}

function rememberTour() {
  try {
    localStorage.setItem(STORAGE_KEY, 'true')
  } catch {
    /* nothing to do: the tour simply shows again next visit */
  }
}

export function GuidedTour({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const headingId = useId()
  const bodyId = useId()
  const [step, setStep] = useState(0)

  const steps: Step[] = [
    {
      heading: 'Every ZIP code in the country, from federal data',
      body: (
        <>
          <p>
            Nothing here is stored on a server, and this site holds no copy of the data. Your browser fetches
            every figure directly from its publisher, so any number on screen can be checked against the
            original source by anyone.
          </p>
          <p>
            Look up a single ZIP code above and it works immediately, with no account. To load all 33,791 at
            once, the Census Bureau asks for a free API key so they can track usage.
          </p>
        </>
      ),
    },
    {
      heading: 'The key stays in your browser',
      body: (
        <>
          <p>
            The key is stored only in this browser and is sent only to the Census Bureau. Nobody running this
            site can see it, and there is no server here that could: the whole product is static files on a
            content delivery network.
          </p>
          <p>
            That is also why there is no search history. Nobody — including whoever hosts the deployment —
            can see which ZIP codes or cities anyone looked up, because nothing is recorded.
          </p>
        </>
      ),
    },
    {
      heading: 'Nothing is ranked, and every figure carries its margin',
      body: (
        <>
          <p>
            There is no &ldquo;best neighbourhood&rdquo; list and no default ordering. Every sort is one you
            chose, and no result can be bought, advertised or referred.
          </p>
          <p>
            Survey estimates are printed with their margin of error, and where the Census Bureau publishes no
            value the figure says so rather than showing a zero or a dash.
          </p>
        </>
      ),
    },
  ]

  const last = step >= steps.length - 1
  const current = steps[step]!

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      // showModal gives the focus trap and Escape handling. `cancel` is fired by
      // Escape, so dismissing through the keyboard lands in the same place as
      // clicking Skip rather than being a separate path.
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  function finish() {
    rememberTour()
    onDismiss()
  }

  function onCancel(e: React.SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault()
    finish()
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={onCancel}
      aria-labelledby={headingId}
      aria-describedby={bodyId}
      className="w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="panel-padded">
        {/*
          The step count is in the accessible name, not only in a visual corner,
          so a screen reader user knows how much is left. Announced politely rather
          than assertively: this is not an error and does not interrupt.
        */}
        <p className="text-xs font-medium text-slate-500">
          Step {step + 1} of {steps.length}
        </p>
        <h2 id={headingId} className="mt-1 text-lg font-semibold text-slate-900">
          {current.heading}
        </h2>
        <div id={bodyId} className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700">
          {current.body}
        </div>

        {/*
          A live region carrying the step heading, so advancing is announced. The
          heading is inside it, so focus is not moved and the reader is not
          repositioned mid-sentence — which is the usual cost of this pattern.
        */}
        <p role="status" aria-live="polite" className="sr-only">
          {current.heading}. Step {step + 1} of {steps.length}.
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={finish}
            className="min-h-[44px] rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            Skip
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (last ? finish() : setStep((s) => s + 1))}
              className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
            >
              {last ? 'Start' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  )
}

/**
 * The first-visit notice: inline, non-modal, and never in the way.
 *
 * It sits above the search box rather than over it, traps no focus and takes no
 * keystrokes, so a reader who wants a ZIP code can simply type. Its only jobs are
 * to say what the tool is and to offer the longer explanation.
 */
export function TourNotice({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  const headingId = useId()
  return (
    <aside
      aria-labelledby={headingId}
      className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"
    >
      <h2 id={headingId} className="text-sm font-semibold text-slate-900">
        New here
      </h2>
      <p className="mt-1">
        Looking up a single ZIP code works straight away, with no account. Loading all 33,791 at once needs a
        free Census API key, which stays in this browser.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="min-h-[44px] rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
        >
          How this works
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          Dismiss
        </button>
      </div>
    </aside>
  )
}

/**
 * Decides whether to show the first-visit notice.
 *
 * Separate from the components so the rule is one pure function rather than an
 * effect, and so it can be asserted without a browser. A notice keyed on "always"
 * would be intolerable; one keyed on a flag that is never written would be worse
 * than no notice at all.
 */
export function shouldShowTour(): boolean {
  return !hasSeenTour()
}
