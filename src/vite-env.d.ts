/**
 * Build-time configuration a deployment may supply.
 *
 * `vite/client` (already in tsconfig types) declares the base ImportMetaEnv;
 * this augments it with the one deployment variable this app reads, so the
 * read in getSharedCensusKey is typed rather than an index into `any`.
 */
interface ImportMetaEnv {
  /**
   * Shared Census application key supplied by the deployment at build time
   * (see vite.config.ts envPrefix). Absent in builds whose deployment did
   * not provide one — the code ships with no value.
   */
  readonly CENSUS_APP_KEY?: string
}
