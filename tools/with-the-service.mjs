/**
 * Start everything a check needs, and stop it again.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `npm run walkthrough` and `npm run check:screen` used to fetch
 * `http://localhost:3500` and expect somebody to have started the fleet and the
 * collector first. That has two failure modes, and the second is much worse.
 *
 * On a clean machine they fail with `fetch failed`, which is honest — and means
 * the publication gate cannot run them at all, so they run only when somebody
 * remembers, which is the arrangement every rule in this repository exists to
 * avoid.
 *
 * And on a machine where something *is* listening on 3500, they pass, **against
 * whatever that is**. A collector left running from an hour ago on an older
 * commit answers exactly like a fresh one. The check goes green having checked
 * the wrong thing — and that is worse than no check, because no check leaves
 * the doubt, and the doubt is the only thing that makes anybody look. It has
 * already happened here once.
 *
 * So a check starts its own, on a port nothing else uses, with a readings file
 * of its own, and takes both away afterwards.
 *
 * `--against <url>` points a check at something already running. That is a
 * deliberate act with a flag on it, which is the whole difference.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** A port for checks and nothing else. Not 3500: that is where a person runs it. */
export const CHECK_PORT = 3599;

/** `--against http://…`, when somebody means to test a running instance. */
export function against(argv = process.argv) {
  const at = argv.indexOf('--against');
  return at !== -1 && argv[at + 1] ? argv[at + 1] : null;
}

/**
 * Starts a fleet and a collector, and returns where to talk to them.
 *
 * @returns {Promise<{base: string, stop: () => Promise<void>, mine: boolean}>}
 */
export async function startTheService({ quiet = true } = {}) {
  const already = against();

  if (already) {
    console.log(`Against ${already}, which somebody else started.\n`);
    return { base: already, mine: false, stop: async () => {} };
  }

  const children = [];
  let readings = null;

  const stop = async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }

    // A moment for the sockets to go, so a check run twice in a row does not
    // meet its own previous fleet.
    await new Promise((done) => setTimeout(done, 400));

    if (readings) {
      try {
        fs.rmSync(readings, { force: true });
      } catch {
        /* a file that will not go is not worth failing a check over */
      }
    }
  };

  const say = (name, chunk) => {
    if (!quiet) process.stderr.write(`[${name}] ${chunk}`);
  };

  try {
    const fleet = spawn(process.execPath, [path.join(root, 'sim', 'fleet.js')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(fleet);
    fleet.stdout.setEncoding('utf8');
    fleet.stderr.setEncoding('utf8');
    fleet.stderr.on('data', (chunk) => say('printers', chunk));

    await untilItSays(fleet, /printers are answering SNMP/, 20_000, 'the invented printers');

    // A readings file of its own, thrown away afterwards.
    //
    // Sharing the one a person's own runs write to made the check depend on the
    // history of this machine: a run where the fleet had not come up left six
    // devices recorded by address rather than by serial, and the next check
    // then found eleven devices in a fleet of six and failed for a reason with
    // nothing to do with the code. A check whose result depends on what else
    // has been run here is not a check.
    readings = path.join(os.tmpdir(), `meters-check-${process.pid}.jsonl`);

    const collector = spawn(
      process.execPath,
      [path.join(root, 'src', 'index.js'), '--port', String(CHECK_PORT), '--data', readings, '--no-open'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.push(collector);
    collector.stdout.setEncoding('utf8');
    collector.stderr.setEncoding('utf8');
    collector.stderr.on('data', (chunk) => say('collector', chunk));

    const base = `http://127.0.0.1:${CHECK_PORT}`;

    // Not until it answers: until it has finished a ROUND.
    //
    // The board binds its port before it has polled anything, so `/api/health`
    // returns 200 with `rounds: 0` and a fleet of four out of six — the two
    // slowest devices simply have not been asked yet. A check that started
    // there found half the fleet missing and two machines "not answering",
    // which is a true statement about a moment nobody cares about.
    //
    // Waiting on the socket instead of on the work is the same mistake as
    // waiting on a published Docker port instead of on the server behind it.
    await untilItAnswers(`${base}/api/health`, 40_000, (health) => (health?.collector?.rounds ?? 0) >= 1);

    return { base, mine: true, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Runs `body(base)` with a fleet and a collector of its own, and stops them
 * afterwards however the body ended — a check that leaves a collector running
 * is a check that makes the next one lie.
 */
export async function withTheService(body, options = {}) {
  const service = await startTheService(options);

  try {
    return await body(service.base);
  } finally {
    await service.stop();
  }
}

function untilItSays(child, pattern, ms, what) {
  return new Promise((done, fail) => {
    let seen = '';

    const giveUp = setTimeout(() => {
      finish();
      fail(new Error(`${what} did not start within ${ms / 1000}s. Last said: ${seen.trim().split('\n').at(-1) ?? ''}`));
    }, ms);

    const look = (chunk) => {
      seen += chunk;
      if (pattern.test(seen)) {
        finish();
        done();
      }
    };

    const stopped = (code) => {
      finish();
      fail(new Error(`${what} exited with ${code} before it was ready. It said: ${seen.trim()}`));
    };

    function finish() {
      clearTimeout(giveUp);
      child.stdout.off('data', look);
      child.off('exit', stopped);
    }

    child.stdout.on('data', look);
    child.on('exit', stopped);
  });
}

/**
 * Poll until the board answers in the way the caller is waiting for.
 *
 * A TCP connect would not do: the collector binds the port before it has polled
 * anything, so connecting proves the socket is open and nothing else. Nor does
 * a 200, for the same reason one step further along — hence `ready`, which says
 * what about the answer actually matters.
 */
async function untilItAnswers(url, ms, ready = () => true) {
  const until = Date.now() + ms;
  let last = null;

  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        last = await response.json();
        if (ready(last)) return last;
      }
    } catch {
      /* not up yet */
    }

    if (Date.now() > until) {
      throw new Error(
        `${url} was not ready within ${ms / 1000}s` + (last ? `. It last said: ${JSON.stringify(last)}` : '')
      );
    }

    await new Promise((done) => setTimeout(done, 250));
  }
}
