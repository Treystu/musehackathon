import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createDiagnostics } from '../../src/core/ai/diagnostics'
import { DiagnosticsPanel } from '../../src/ui/ai/DiagnosticsPanel'

function memoryStore(initial: string | null = null) {
  let value = initial
  return {
    read: () => value,
    write: (next: string) => {
      value = next
    },
  }
}

describe('diagnostics panel', () => {
  it('renders the local-only explanation and an export action', () => {
    const recorder = createDiagnostics(memoryStore())
    const html = renderToStaticMarkup(<DiagnosticsPanel recorder={recorder} />)
    expect(html).toContain('Diagnostics')
    expect(html).toContain('stay in this browser')
    expect(html).toContain('never your questions')
    expect(html).toContain('Download diagnostics')
    expect(html).toContain('None recorded in this browser.')
  })

  it('shows recorded counts by class without rendering any query text', () => {
    const recorder = createDiagnostics(memoryStore())
    recorder.recordWithhold('invented_numeral')
    recorder.recordIntentFailure('bad_key')
    recorder.recordErrorState('unexpected')

    const html = renderToStaticMarkup(<DiagnosticsPanel recorder={recorder} />)
    expect(html).toContain('Invented Numeral')
    expect(html).toContain('Bad Key')
    expect(html).toContain('Unexpected')
    expect(html).not.toContain('SENTINEL')
  })
})
