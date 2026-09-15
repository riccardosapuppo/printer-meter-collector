/**
 * When the page is opened, and — mostly — when it is not.
 *
 * Every one of these refusals is a way of being wrong that is hard to
 * diagnose from the symptom. A launcher that blocks on a runner turns a green
 * job into one that hangs for six hours; a window opening on a server's console
 * because a supervisor started the service is a surprise nobody can trace back
 * to a line of code.
 *
 * Nothing here spawns anything: the decision is the part worth testing, and the
 * spawn is one line beneath it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openInABrowser, WATCHING } from '../src/open-a-browser.js';
import { environmentFor } from '../tools/who-is-watching.mjs';

const url = 'http://127.0.0.1:3500/';

describe('opening the page when the service starts', () => {
  it('does not, when told not to on the command line', () => {
    const said = openInABrowser(url, { argv: ['node', 'index.js', '--no-open'], env: {}, isTTY: true });
    assert.equal(said.opened, false);
    assert.match(said.why, /--no-open/);
  });

  it('does not, when told not to in the environment', () => {
    const said = openInABrowser(url, { argv: [], env: { NO_OPEN: '1' }, isTTY: true });
    assert.equal(said.opened, false);
    assert.match(said.why, /NO_OPEN/);
  });

  it('and NO_OPEN=0 means what it says, rather than being any value at all', () => {
    // A guard that treats "0" as "yes" is the reason people write NO_OPEN=0 and
    // then file a bug about the flag not working.
    const said = openInABrowser(url, { argv: [], env: { NO_OPEN: '0', CI: 'true' }, isTTY: true });
    assert.match(said.why, /CI/, 'NO_OPEN=0 should have been ignored, leaving CI to refuse');
  });

  it('does not, in CI, where there is no browser and the launcher may block', () => {
    const said = openInABrowser(url, { argv: [], env: { CI: 'true' }, isTTY: true });
    assert.equal(said.opened, false);
    assert.match(said.why, /CI/);
  });

  it('does not, when nothing is attached to the terminal', () => {
    const said = openInABrowser(url, { argv: [], env: {}, isTTY: false });
    assert.equal(said.opened, false);
    assert.match(said.why, /terminal/);
  });

  it('always says why it did not, because silence reads as breakage', () => {
    for (const [argv, env, isTTY] of [
      [['--no-open'], {}, true],
      [[], { NO_OPEN: '1' }, true],
      [[], { CI: '1' }, true],
      [[], {}, false],
    ]) {
      const said = openInABrowser(url, { argv, env, isTTY });
      assert.ok(said.why && said.why.length > 4, 'a refusal with no reason in it');
    }
  });
});

/*
 * The wiring, which is the part that was wrong while every check above was
 * green.
 *
 * Each of those passes `isTTY: true` in, because the decision is what is worth
 * testing without spawning a browser. That is right, and it is also how the
 * only thing that mattered went untested for as long as the file existed:
 * `npm start` runs the collector as a child with its output piped so every
 * line can be labelled, a pipe is not a TTY, and so the fourth guard was true
 * for ever. The board never opened from the command the README tells people to
 * use, and nothing anywhere said so.
 */
describe('a piped stdout, which is what npm start gives the collector', () => {
  it('does not by itself mean nobody is watching', () => {
    const asked = [];

    const said = openInABrowser(url, {
      argv: [],
      env: { [WATCHING]: '1' },
      isTTY: undefined,

      // Written down rather than run. Without this seam the only check that
      // could confirm the board opens is one that opens a browser on whatever
      // machine runs the suite, which is why it went unwritten.
      start: (command, args) => {
        asked.push({ command, args });
        return { on() {}, unref() {} };
      },
    });

    assert.equal(said.opened, true, said.why);
    assert.equal(asked.length, 1, 'the board was reported open and nothing was launched');
    assert.ok(asked[0].args.some((one) => one.includes(url)), 'launched something, but not the board');
  });

  it('still means nobody is watching when no launcher said otherwise', () => {
    const said = openInABrowser(url, { argv: [], env: {}, isTTY: undefined });

    assert.equal(said.opened, false);
    assert.match(said.why, /terminal/);
  });

  it('and the observation is not an instruction: the refusals still win', () => {
    // A launcher with a terminal must not be able to override somebody who
    // said no, or CI, which is the guard that keeps a runner from hanging.
    for (const [argv, env, expected] of [
      [['node', 'index.js', '--no-open'], { [WATCHING]: '1' }, /--no-open/],
      [[], { [WATCHING]: '1', NO_OPEN: '1' }, /NO_OPEN/],
      [[], { [WATCHING]: '1', CI: 'true' }, /CI/],
    ]) {
      const said = openInABrowser(url, { argv, env, isTTY: undefined });

      assert.equal(said.opened, false);
      assert.match(said.why, expected);
    }
  });

  it('is told to the child only by a launcher that has a terminal itself', () => {
    // The chain has to be unbroken: person, terminal, npm start, launcher,
    // collector. A launcher whose own output is piped -- on a runner, or
    // behind a supervisor -- passes nothing on, and passes nothing on even if
    // it was handed the variable from somewhere else.
    assert.equal(environmentFor({ isTTY: true, env: {} })[WATCHING], '1');
    assert.equal(environmentFor({ isTTY: undefined, env: {} })[WATCHING], undefined);
    assert.equal(environmentFor({ isTTY: undefined, env: { [WATCHING]: '1' } })[WATCHING], undefined);
  });
});
