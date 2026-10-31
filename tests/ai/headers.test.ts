import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Item 12 gate: the CSP Permissions-Policy flip ships in the same
 * change as the mic implementation — microphone moves from closed
 * `()` to `(self)`, and camera stays closed.
 */
describe('public/_headers mic policy', () => {
  const headers = readFileSync(join(process.cwd(), 'public', '_headers'), 'utf8')
  const policyLine = headers
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('Permissions-Policy:'))

  it('carries a Permissions-Policy header', () => {
    expect(policyLine).toBeDefined()
  })

  it('allows the microphone for self only', () => {
    expect(policyLine).toContain('microphone=(self)')
    expect(policyLine).not.toContain('microphone=()')
    expect(policyLine).not.toContain('microphone=*')
  })

  it('keeps the camera closed', () => {
    expect(policyLine).toContain('camera=()')
  })
})
