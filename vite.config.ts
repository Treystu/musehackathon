import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The one deployment-supplied value the client is allowed to see. Vite
  // exposes only VITE_-prefixed variables by default; CENSUS_APP_KEY is the
  // shared Census application key a deployment may provide so the full
  // dataset works before a visitor adds a personal key (the federation
  // decided 2026-10-31; see getSharedCensusKey in src/core/censusKey.ts).
  // The key is an application identifier the Census Bureau issues for usage
  // tracking, not a visitor credential. It reaches the client only when the
  // deployment sets it at build time; an unset variable is simply absent,
  // and the app then behaves exactly as it did before the shared key existed.
  envPrefix: ['VITE_', 'CENSUS_APP_KEY'],
  build: {
    target: 'es2022',
    // Source maps are useful during development and are a 500KB public
    // disclosure of application source in production, so they are opt-in per
    // build rather than always-on.
    sourcemap: mode !== 'production',
  },
  test: {
    environment: 'node',
    // The named gate tests live in tests/, alongside the sources they assert
    // about rather than inside them.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // `src/live` is excluded so the default suite is genuinely hermetic, which is
    // what the CI workflow's verify step has claimed all along: "Hermetic: no
    // network, no credentials." Until now that claim was false — the glob above
    // pulled the live API contracts in, so every pull request's "hermetic" job
    // phoned NCES, CDC and TIGERweb, and a government API outage failed an
    // unrelated feature. Found exactly that way: NCES EDGE returned HTTP 500 on
    // 2026-10-06 and blocked a similarity-search PR whose diff touched nothing
    // near it.
    //
    // No coverage is lost. The live contracts have two dedicated homes that both
    // remain: the `live-contracts` CI job, and the completion gate's own
    // `live API contracts` step, which runs `vitest.live.config.ts`.
    exclude: ['src/live/**', 'node_modules/**', 'dist/**'],
  },
}))
