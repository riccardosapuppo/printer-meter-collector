import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { startPrinter } from '../sim/printer.js';
import { FLEET } from '../sim/devices.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Starting this twice, which is the ordinary way it goes wrong.
 *
 * Somebody leaves a terminal open, or a previous run was not tidied away, and
 * the next `npm start` meets a port that is already taken. That is not an
 * exotic case and it is the one the whole start-up path used to handle worst:
 * a promise with no way to refuse, an unsettled top-level await, Node's own
 * warning about its internals, and exit code 13.
 */
describe('a port that is already taken', () => {
  it('is refused by the printer rather than waited on for ever', async () => {
    // A stranger on the port, standing in for the copy somebody left running.
    const squatter = await squatOn(16199);

    try {
      // The failure this replaced was not an exception: it was silence. The
      // promise never settled, so there was nothing to catch, nothing to log
      // and nothing to time out — the process simply had no further work to do
      // and Node said so in its own words.
      await assert.rejects(
        () => startPrinter(FLEET[0], { port: 16199 }),
        (wrong) => {
          assert.equal(wrong.code, 'EADDRINUSE');
          assert.equal(wrong.port, 16199, 'the refusal has to name the port, or it names nothing');
          return true;
        }
      );
    } finally {
      await new Promise((done) => squatter.close(done));
    }
  });

  it('makes the fleet say what happened, and stop, instead of hanging', async () => {
    const squatter = await squatOn(FLEET[0].port);

    try {
      const { code, said } = await run(path.join(root, 'sim', 'fleet.js'));

      // Exit 1 and not 13: thirteen is Node reporting that the program stopped
      // making progress, which is a different fact about a different thing.
      assert.equal(code, 1, `the fleet exited ${code}: ${said}`);

      assert.match(said, /already listening on 127\.0\.0\.1:16101/);
      assert.match(said, /another copy of these printers/);

      // And nothing about Node's internals, which is what somebody whose real
      // problem is an open terminal was being shown.
      assert.doesNotMatch(said, /unsettled top-level await/);
    } finally {
      await new Promise((done) => squatter.close(done));
    }
  });

  it('leaves no printer behind when it gives up half way', async () => {
    // The sixth device is deliberately silent, so 16105 is the last one bound.
    // Taking it means the first four come up and then the fifth refuses.
    const squatter = await squatOn(FLEET.at(-1).port);

    try {
      const { code } = await run(path.join(root, 'sim', 'fleet.js'));
      assert.equal(code, 1);

      // A half-started fleet still holding four ports is what makes the NEXT
      // attempt fail too, for a reason one step further from the cause. Every
      // port it did get has to be free again.
      for (const device of FLEET.slice(0, -1)) {
        const after = dgram.createSocket('udp4');

        await new Promise((bound, no) => {
          after.once('error', no);
          after.bind(device.port, '127.0.0.1', bound);
        });

        await new Promise((done) => after.close(done));
      }
    } finally {
      await new Promise((done) => squatter.close(done));
    }
  });
});

/**
 * The launcher's readiness, which is about WHOSE fleet and not only whether
 * one answers.
 */
describe('the printers reporting that they are up', () => {
  it('say so on the channel their launcher opened, and nowhere else', async () => {
    const said = await new Promise((heard) => {
      const child = spawn(process.execPath, [path.join(root, 'sim', 'fleet.js')], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      const stop = (message) => {
        child.kill();
        heard(message);
      };

      child.on('message', stop);
      child.on('exit', () => heard(null));
      setTimeout(() => stop(null), 20_000);
    });

    assert.ok(said?.ready, 'the fleet never said it was ready on its channel');

    // The ports it says it bound, so the launcher is told rather than assuming.
    assert.deepEqual(said.ports, FLEET.map((one) => one.port));
  });
});

/**
 * Take a port, standing in for the copy somebody left running.
 *
 * With an error path, and that is not ceremony: written as a bind with only a
 * success callback -- which is what it was, and which is the exact defect
 * these checks are about -- a port already held by a stray fleet made this
 * promise hang instead of failing, and the file took three minutes to report
 * nothing useful. A check that cannot say why it could not run is worse than
 * one that fails.
 */
function squatOn(port) {
  return new Promise((taken, no) => {
    const socket = dgram.createSocket('udp4');

    socket.once('error', (wrong) =>
      no(
        new Error(
          `these checks need 127.0.0.1:${port} free and something is on it (${wrong.code}). ` +
            'Most likely a fleet left running: stop it and run them again.'
        )
      )
    );

    socket.bind(port, '127.0.0.1', () => taken(socket));
  });
}

/** Run a script to completion and hand back what it said. */
function run(script) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], { cwd: root });
    let said = '';

    child.stdout.on('data', (chunk) => (said += chunk));
    child.stderr.on('data', (chunk) => (said += chunk));
    child.on('exit', (code) => done({ code, said }));
  });
}
