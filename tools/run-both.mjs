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

import { FLEET } from '../sim/devices.js';
import { snmp } from '../src/snmp/client.js';
import { SYSTEM } from '../src/snmp/oids.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const running = [];
let closing = false;

const fleet = start('the printers', path.join(root, 'sim', 'fleet.js'), [], { ipc: true });

// Ask the printers whether they are answering, rather than reading what they
// say about themselves. See `untilThePrintersAnswer`.
await untilThePrintersAnswer(20_000);

start('the collector', path.join(root, 'src', 'index.js'), process.argv.slice(2));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => closeEverything(0));
}

// ---------------------------------------------------------------------------

function start(name, script, argv, { ipc = false } = {}) {
  const child = spawn(process.execPath, [script, ...argv], {
    cwd: root,
    // The fourth entry opens a message channel between this process and that
    // one. It is how the fleet says it is ready in a way nothing else on the
    // machine can say for it: see the note where it sends.
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
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

  console.log(`[both] ${name} is pid ${child.pid}`);

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

/**
 * Wait until a printer answers a real SNMP request.
 *
 * ── Two things this used to get wrong ────────────────────────────────────────
 *
 * It watched the fleet's own stdout for the line "printers are answering
 * SNMP". That is the fleet's opinion of itself, printed at the moment it
 * decides to print it, and it is not the question: the question is whether a
 * UDP packet sent to 16101 comes back. So this asks, with the same client the
 * collector uses, for the same object it would read.
 *
 * And it gave up by RESOLVING -- "starting anyway" -- which is a readiness
 * check that passes when the thing is not ready. The collector then polled a
 * fleet that was not there, drew six red rows, and the one picture this whole
 * command exists to avoid is the one that opened. A deadline reached is a
 * failure and says so.
 *
 * The fleet dying is watched for separately, because it is the likely case and
 * because waiting twenty seconds to report a process that exited two seconds
 * ago is its own small cruelty: the fleet has already printed the reason.
 */
async function untilThePrintersAnswer(ms) {
  const first = FLEET[0];

  // Whose, and then working. The first is a message only the fleet this
  // launcher started can send; the second is a real request to the socket it
  // claims to have bound. Either on its own answers half the question, and it
  // is the missing half that bites: a second copy of the fleet, left in
  // another terminal, answers SNMP on 16101 exactly like ours -- so "the port
  // answered" was satisfied while OUR printers were failing to bind, and the
  // collector was started against somebody else's.
  const said = await whatTheFleetSays(ms);

  if (said !== 'ready') {
    if (said === 'stopped') {
      console.error('[both] the printers stopped before they were answering. The reason is above.');
    } else {
      console.error(`[both] the printers did not report ready within ${ms / 1000}s.`);
    }

    // Awaited, and it never comes back: closeEverything exits. Called without
    // awaiting it this returned, the caller's await resolved, and the
    // collector was started against a fleet that had just died -- the exact
    // thing this function exists to prevent, arrived at by making the stop
    // asynchronous.
    await closeEverything(1);
  }

  const asking = snmp({ host: '127.0.0.1', port: first.port, timeoutMs: 700, retries: 1 });

  try {
    await asking.get([SYSTEM.description]);
  } catch (silent) {
    console.error(`[both] the printers said ready and then did not answer on ${first.port}: ${silent.message}`);
    console.error('[both] Not starting the collector: it would poll nothing and draw a board of red rows,');
    console.error('[both] which is the picture this command exists to avoid.');

    await closeEverything(1);
  }
}

/** 'ready', 'stopped', or 'too long' -- and never "probably". */
function whatTheFleetSays(ms) {
  return new Promise((say) => {
    const giveUp = setTimeout(() => finish('too long'), ms);

    const heard = (message) => {
      if (message?.ready) finish('ready');
    };

    const gone = () => finish('stopped');

    function finish(how) {
      clearTimeout(giveUp);
      fleet.off('message', heard);
      fleet.off('exit', gone);
      say(how);
    }

    fleet.on('message', heard);
    fleet.on('exit', gone);
  });
}

/**
 * Stop both halves, and leave only when they are actually gone.
 *
 * This used to kill the children and then exit on a three-hundred-millisecond
 * timer, which is a guess dressed as a wait. When the guess was wrong the
 * launcher exited first and the children were orphaned: two node processes
 * still holding 3500 and 16101-16105, with nothing on screen to say so. The
 * next `npm start` then failed for a reason one step removed from the cause,
 * and that is how twenty minutes go.
 *
 * So it waits for each child's `exit`, and only then leaves. The timer is
 * still here as a backstop with a different job: after it, the ones still
 * standing are killed harder and named, because a launcher that hangs on
 * shutdown is its own kind of stuck.
 */
async function closeEverything(code) {
  if (closing) return;
  closing = true;

  const alive = running.filter((one) => one.child.exitCode === null && one.child.signalCode === null);

  await Promise.all(
    alive.map(
      (one) =>
        new Promise((gone) => {
          const harder = setTimeout(() => {
            console.error(`[both] ${one.name} did not stop when asked; killing it.`);
            one.child.kill('SIGKILL');
          }, 3000);

          one.child.once('exit', () => {
            clearTimeout(harder);
            gone();
          });

          one.child.kill();
        })
    )
  );

  process.exit(code);
}
