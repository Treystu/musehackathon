import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRIVACY_SUMMARY } from '../../src/core/ai/privacy'

describe('privacy workbench copy', () => {
  const md = readFileSync(join(process.cwd(), 'docs/privacy-workbench.md'), 'utf8')
  const privacySource = readFileSync(
    join(process.cwd(), 'src/core/ai/privacy.ts'),
    'utf8',
  )

  it('markdown is readable and names the aggregate counter with never language', () => {
    expect(md.length).toBeGreaterThan(0)
    expect(md).toContain('WORKBENCH COPY — NOT FINAL')
    expect(md).toContain('aggregate counter')
    expect(md).toContain('never')
  })

  it('exports a short in-product summary', () => {
    expect(PRIVACY_SUMMARY).toBeTruthy()
    expect(typeof PRIVACY_SUMMARY).toBe('string')
    expect(PRIVACY_SUMMARY).toContain('aggregate counter')
    expect(PRIVACY_SUMMARY).toContain('never')
  })

  it('privacy.ts states no digits that could read as an invented cap', () => {
    expect(privacySource).not.toMatch(/\d/)
    expect(md.toLowerCase()).not.toMatch(/per-client cap (?:is|of) \$?\d/)
  })
})
