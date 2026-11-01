import { createServer, type Server } from 'node:http'
import { expect, it } from 'vitest'
import { validateProductionPreview } from './validate-preview'

const bundlePath = '/assets/index-deadbeef.js'
const civicScopeBundle = 'const storageKey = "civicscope.censusKey.v1";'

interface TargetPage {
  html: string
  bundle?: string
}

async function withTarget(page: TargetPage, run: (baseUrl: string) => Promise<void>) {
  let server: Server
  server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page.html)
      return
    }

    if (request.url === bundlePath && page.bundle !== undefined) {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      response.end(page.bundle)
      return
    }

    response.writeHead(404)
    response.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test target did not bind a TCP port.')

  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function page(title: string, scripts: string[]) {
  const scriptTags = scripts.map((script) => `<script type="module" src="${script}"></script>`).join('')
  return `<!doctype html><html><head><title>${title}</title></head><body>${scriptTags}<div id="root"></div></body></html>`
}

it('accepts the CivicScope production build markers', async () => {
  await withTarget(
    { html: page('CivicScope — free housing data', [bundlePath]), bundle: civicScopeBundle },
    (baseUrl) => validateProductionPreview(baseUrl),
  )
})

it('rejects the Vite development server before the browser tests start', async () => {
  await withTarget(
    { html: page('CivicScope — development', ['/@vite/client', '/src/main.tsx']) },
    async (baseUrl) => {
      await expect(validateProductionPreview(baseUrl)).rejects.toThrow(
        /\[E2E_TARGET_INVALID\].*without a hashed.*production bundle/,
      )
    },
  )
})

it('rejects an unrelated app even when it serves a hashed JavaScript asset', async () => {
  await withTarget(
    { html: page('Another application', [bundlePath]), bundle: 'window.anotherApp = true;' },
    async (baseUrl) => {
      await expect(validateProductionPreview(baseUrl)).rejects.toThrow(
        /\[E2E_TARGET_INVALID\].*does not identify the CivicScope app/,
      )
    },
  )
})

it('rejects a CivicScope-titled page with an unrelated hashed bundle', async () => {
  await withTarget(
    { html: page('CivicScope', [bundlePath]), bundle: 'window.anotherApp = true;' },
    async (baseUrl) => {
      await expect(validateProductionPreview(baseUrl)).rejects.toThrow(
        /\[E2E_TARGET_INVALID\].*bundle does not identify the CivicScope app/,
      )
    },
  )
})
