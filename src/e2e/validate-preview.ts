const INVALID_TARGET = '[E2E_TARGET_INVALID]'
const TARGET_TIMEOUT_MS = 10_000
const CIVICSCOPE_BUNDLE_MARKER = 'civicscope.censusKey.v1'

async function fetchWithTimeout(url: URL): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(TARGET_TIMEOUT_MS) })
}

export async function validateProductionPreview(
  configuredBase = process.env.E2E_BASE_URL ?? 'http://localhost:4173',
): Promise<void> {
  let base: URL
  try {
    base = new URL(configuredBase)
  } catch {
    throw new Error(`${INVALID_TARGET} E2E_BASE_URL must be an absolute HTTP(S) URL.`)
  }

  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`${INVALID_TARGET} E2E_BASE_URL must use HTTP or HTTPS.`)
  }

  let pageResponse: Response
  try {
    pageResponse = await fetchWithTimeout(new URL('/', base))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${INVALID_TARGET} Could not reach the configured target origin (${base.origin}): ${reason}. ` +
        'Point E2E_BASE_URL at a running production preview.',
    )
  }

  const pageType = pageResponse.headers.get('content-type') ?? ''
  if (!pageResponse.ok || !pageType.toLowerCase().includes('text/html')) {
    throw new Error(
      `${INVALID_TARGET} The configured target origin (${base.origin}) did not return an HTML app page ` +
        `(HTTP ${pageResponse.status}, content-type: ${pageType || 'missing'}).`,
    )
  }

  const html = await pageResponse.text()
  if (!/<title\b[^>]*>\s*CivicScope\b/i.test(html)) {
    throw new Error(
      `${INVALID_TARGET} The target HTML does not identify the CivicScope app. ` +
        'Point E2E_BASE_URL at a running CivicScope production preview.',
    )
  }

  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(
    (match) => match[1]!,
  )
  const bundle = scripts.find((src) => /\/assets\/[^/?#]+-[\w-]{8,}\.js(?:[?#]|$)/.test(src))
  if (!bundle) {
    throw new Error(
      `${INVALID_TARGET} The target returned HTML without a hashed /assets/*.js production bundle. ` +
        'It may be a Vite dev server; build the app and run `npm run preview` first.',
    )
  }

  let bundleResponse: Response
  try {
    bundleResponse = await fetchWithTimeout(new URL(bundle, pageResponse.url))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${INVALID_TARGET} Could not fetch the production JavaScript bundle: ${reason}.`)
  }

  const bundleType = bundleResponse.headers.get('content-type') ?? ''
  if (!bundleResponse.ok || !/^(?:text|application)\/(?:java|ecma)script\b/i.test(bundleType)) {
    throw new Error(
      `${INVALID_TARGET} The production bundle did not return JavaScript ` +
        `(HTTP ${bundleResponse.status}, content-type: ${bundleType || 'missing'}).`,
    )
  }

  const bundleText = await bundleResponse.text()
  if (!bundleText.includes(CIVICSCOPE_BUNDLE_MARKER)) {
    throw new Error(
      `${INVALID_TARGET} The hashed JavaScript bundle does not identify the CivicScope app. ` +
        'Point E2E_BASE_URL at a running CivicScope production preview.',
    )
  }
}

export default async function setupE2EPreviewValidation(): Promise<void> {
  await validateProductionPreview()
}
