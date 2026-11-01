import { describe, expect, it } from 'vitest'

const loadPolicy = async () =>
  import(new URL('../../tools/load-census-key.mjs', import.meta.url).href)

describe('Census key loader policy', () => {
  it('returns the exact value from one well-formed key assignment', async () => {
    const { parseCensusKeyFromScmorc } = await loadPolicy()
    const expected = 'a'.repeat(40)
    const parsed = parseCensusKeyFromScmorc(`CENSUS_KEY=${expected}\n`)

    expect(parsed).toBe(expected)
  })

  it('leaves the key unset when the file has no Census key assignment', async () => {
    const { parseCensusKeyFromScmorc } = await loadPolicy()

    expect(parseCensusKeyFromScmorc('OTHER_SETTING=value\n')).toBeUndefined()
  })

  it('rejects duplicate assignments with an error that contains no key value', async () => {
    const { parseCensusKeyFromScmorc } = await loadPolicy()
    let message = ''

    try {
      parseCensusKeyFromScmorc(
        `CENSUS_KEY=${'a'.repeat(40)}\nCENSUS_KEY=${'b'.repeat(40)}\n`,
      )
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }

    expect(message).toBe('CENSUS_KEY must appear exactly once in .scmorc.')
  })

  it('rejects a Windows ACL whose file identity does not match the opened file', async () => {
    const { isPrivateScmorcAcl } = await loadPolicy()
    const acl = {
      ownerSid: 'S-1-5-21-current',
      currentSid: 'S-1-5-21-current',
      identityMatches: false,
      protected: true,
      rules: [{ sid: 'S-1-5-21-current', type: 'Allow', inherited: false }],
    }

    expect(isPrivateScmorcAcl(acl)).toBe(false)
  })

  it('rejects a Windows ACL that grants access to another account', async () => {
    const { isPrivateScmorcAcl } = await loadPolicy()
    const acl = {
      ownerSid: 'S-1-5-21-current',
      currentSid: 'S-1-5-21-current',
      identityMatches: true,
      protected: true,
      rules: [
        { sid: 'S-1-5-21-current', type: 'Allow', inherited: false },
        { sid: 'S-1-1-0', type: 'Allow', inherited: false },
      ],
    }

    expect(isPrivateScmorcAcl(acl)).toBe(false)
  })
})
