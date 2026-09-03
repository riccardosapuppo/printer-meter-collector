#!/usr/bin/env node
/**
 * One command: some printers, and the thing that reads them.
 *
 *     npm start
 *     npm start -- --port 3500
 *
 * This project needs two processes to show anything at all — a collector with
 * no fleet to poll draws six red rows and looks broken — and a README whose
 * first instruction is "open a second terminal" is a README that gets skimmed.
 * Whoever is looking has a few minutes, and a manoeuvre does not get performed.
 *
 * Both halves are still available on their own, and the README says so after
 * this one:
 *
 *     npm run fleet        just the invented printers
 *     npm run collector    just the collector, for pointing at real devices
 *
 * The second is not a debugging convenience. Pointing this at a real fleet is
 * the actual use, and it must not require starting a simulator first.
 *
 * ── What starting two processes obliges you to do ────────────────────────────
 *
 *  1. **Start them in the right order, and prove it.** The collector polls on a
 *     timer from the moment it starts; if the printers are not answering yet
 *     the first round is six timeouts and a board full of red, which is exactly
 *     the picture this is meant to avoid. So the fleet is started first and
 *     waited for — by reading its output, not by sleeping a guessed number of
 *     milliseconds on a machine that may be slower than this one.
 *  2. **If one dies, the other stops.** A collector polling nothing, or a
 *     simulator nobody is reading, is a process left running that the next
 *     start fights with over a port.
 *  3. **Every line says which process said it.**
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const running = [];
let closing = false;

const fleet = start('the printers', path.join(root, 'sim', 'fleet.js'), []);

// Wait for the fleet to say it is answering, rather than for a guessed number
// of milliseconds. `1500` works here and is a coin toss on a slower machine,
// and a start-up race that only fails sometimes is the worst kind to own.
await untilItSays(fleet, /printers are answering SNMP/, 15_000);

start('the collector', path.join(root, 'src', 'index.js'), process.argv.slice(2));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => closeEverything(0));
}

// ---------------------------------------------------------------------------

function start(name, script, argv) {
  const child = spawn(process.execPath, [script, ...argv], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  label(child.stdout, name);
  label(child.stderr, name);

  child.on('error', (error) => {
    console.error(`[${name}] would not start: ${error.message}`);
    closeEverything(1);
  });

  child.on('exit', (code) => {
    if (closing) return;
    console.error(`[${name}] stopped${code ? ` with code ${code}` : ''}, so this is stopping too.`);
    closeEverything(code ?? 0);
  });

  running.push({ name, child });
  return child;
}

/**
 * Prefix each line with which process said it.
 *
 * By line rather than by chunk: the collector writes one JSON object per line,
 * and a chunk boundary can fall in the middle of one — which would put the
 * label inside a record and make the whole log unparseable.
 */
function label(stream, name) {
  if (!stream) return;

  let rest = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`[${name}] ${line}\n`);
  });

  stream.on('end', () => {
    if (rest) process.stdout.write(`[${name}] ${rest}\n`);
  });
}

/** Resolve when the child's output matches, or when it has taken too long. */
function untilItSays(child, pattern, ms) {
  return new Promise((done) => {
    let seen = '';

    const giveUp = setTimeout(() => {
      console.error(`[both] the printers did not say they were ready within ${ms / 1000}s; starting anyway`);
      finish();
    }, ms);

    const look = (chunk) => {
      seen += chunk;
      if (pattern.test(seen)) finish();
    };

    function finish() {
      clearTimeout(giveUp);
      child.stdout?.off('data', look);
      done();
    }

    child.stdout?.on('data', look);
  });
}

function closeEverything(code) {
  if (closing) return;
  closing = true;

  for (const one of running) {
    if (one.child.exitCode === null && one.child.signalCode === null) one.child.kill();
  }

  setTimeout(() => process.exit(code), 300);
}
