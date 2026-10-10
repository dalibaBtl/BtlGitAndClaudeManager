// Build script: bundles the server (Node ESM) and the web front-end (browser) with esbuild.
// `node build.mjs --watch` rebuilds on change for development.
import { context, build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const server = {
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // node-pty ships a native addon and must stay a runtime dependency.
  external: ['node-pty'],
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
};

/** @type {import('esbuild').BuildOptions} */
const web = {
  entryPoints: ['src/web/main.tsx'],
  outfile: 'dist/web/main.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
};

await mkdir('dist/web', { recursive: true });
await cp('src/web/index.html', 'dist/web/index.html');

if (watch) {
  const [s, w] = await Promise.all([context(server), context(web)]);
  await Promise.all([s.watch(), w.watch()]);
  console.log('watching…');
} else {
  await Promise.all([build(server), build(web)]);
}
