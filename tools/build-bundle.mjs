#!/usr/bin/env node
/**
 * One file to copy onto a machine.
 *
 *     npm run build
 *
 * A collector belongs on a machine that can see the printers, which is often a
 * small server in a cupboard at a site rather than anything anybody deploys to.
 * `dist/collector.cjs` is the whole service in one file: copy it beside a fleet
 * file and run it with a bare Node.
 *
 * The fleet file and the readings stay **outside** on purpose. They are
 * configuration and data: a collector whose list of printers is baked into the
 * bundle cannot have one added without a rebuild, which is the whole thing the
 * re-read file exists to avoid.
 *
 * The bundle is built AND started here, not just built. "The build passed" is
 * not "the result runs", and the distance between them is where a bundler's
 * quiet substitutions live — `import.meta.url` does not exist in CommonJS, and
 * esbuild replaces it with an empty object rather than complaining.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dist = path.join(root, 'dist');

fs.mkdirSync(dist, { recursive: true });

const { build } = await import('esbuild');

await build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.join(dist, 'collector.cjs'),
  // Left readable. This is read in an incident, and a minified stack trace at
  // that hour costs more than the megabyte it saves.
  minify: false,
  define: {
    // A single identifier, because that is all `define` accepts. An expression
    // here is ignored in silence and esbuild substitutes its own `{}`, which
    // builds cleanly and dies at startup on `fileURLToPath(undefined)`.
    'import.meta.url': '__bundleFileUrl',
  },
  banner: {
    js: [
      '// Built by tools/build-bundle.mjs. Edit src/, not this.',
      'const __bundleFileUrl = require("node:url").pathToFileURL(__filename).href;',
    ].join('\n'),
  },
});

const size = fs.statSync(path.join(dist, 'collector.cjs')).size;
console.log(`  dist/collector.cjs  ${Math.round(size / 1024)} KB`);

// ------------------------------------------------------- and does it run?

const port = 3599;

const started = execFile(
  process.execPath,
  [path.join(dist, 'collector.cjs'), '--port', String(port)],
  { cwd: root }
);

let said = '';
started.stdout?.on('data', (chunk) => {
  said += chunk;
});
started.stderr?.on('data', (chunk) => {
  said += chunk;
});

const answered = await waitFor(`http://127.0.0.1:${port}/api/health`, 15_000);
started.kill();

if (!answered) {
  console.error('\nThe bundle was built and would not start.\n');
  console.error(said.trim().split('\n').slice(-12).join('\n'));
  process.exit(1);
}

console.log(`  it starts, serves, and answers on ${answered.status ?? 'ok'}`);
console.log(`\nCopy it beside a fleet file:\n\n    node collector.cjs --fleet ./fleet.json --port 3500\n`);

async function waitFor(url, ms) {
  const until = Date.now() + ms;

  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 250));
  }

  return null;
}
