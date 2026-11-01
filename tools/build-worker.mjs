/**
 * Worker bundle step: esbuild tools/worker-entry.ts -> dist/_worker.js.
 *
 * Runs last in `npm run build`, after vite and the SEO generator have
 * written dist/, because vite empties the output directory at the start
 * of its own step. The bundle is what puts MeterDurableObject into the
 * deployed worker's module graph (advanced mode); see the header of
 * tools/worker-entry.ts for the measurement behind it.
 *
 * esbuild is not a direct dependency: this resolves the copy hoisted
 * into node_modules by vite (0.21.5 at the time of writing). The bundle
 * is plain ESM for the Workers runtime — platform neutral, workerd
 * condition, no node builtins anywhere in the handler graph.
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

await build({
  entryPoints: [path.join(root, 'tools/worker-entry.ts')],
  outfile: path.join(root, 'dist/_worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  conditions: ['workerd', 'worker'],
  logLevel: 'info',
})
