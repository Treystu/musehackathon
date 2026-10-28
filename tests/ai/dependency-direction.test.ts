import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/')
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

const SOURCE_FILES = [...sourceFiles('src'), ...sourceFiles('functions')]

describe('dependency direction', () => {
  it('keeps src/core and src/ui free of functions/ imports', () => {
    const offenders = [...sourceFiles('src/core'), ...sourceFiles('src/ui')].filter(
      (path) => /from\s+['"][^'"]*functions\//.test(read(path)),
    )
    expect(offenders).toEqual([])
  })

  it('has exactly one ProxyError definition and no re-export', () => {
    const definitions = SOURCE_FILES.filter((path) =>
      /export type ProxyError\s*=/.test(read(path)),
    )
    expect(definitions.map(normalize)).toEqual(['src/core/ai/proxy-errors.ts'])

    const lists = SOURCE_FILES.filter((path) =>
      /export const PROXY_ERRORS/.test(read(path)),
    )
    expect(lists.map(normalize)).toEqual(['src/core/ai/proxy-errors.ts'])

    const reexports = SOURCE_FILES.filter((path) =>
      /export type \{\s*ProxyError\s*\}/.test(read(path)),
    )
    expect(reexports).toEqual([])
  })
})
