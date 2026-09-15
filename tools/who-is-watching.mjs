/**
 * Whether a person is in front of this, told to the child that cannot see.
 *
 * ── The bug this exists because of ───────────────────────────────────────────
 *
 * The collector opens the board unless one of four things is true, and the
 * fourth is "nothing is attached to this terminal" — which keeps a window from
 * appearing on a server's console when a supervisor starts the service.
 *
 * It asks `process.stdout.isTTY`. Started on its own that is the right
 * question. Started by `npm start` it is not even close: the launcher pipes
 * both children's output so it can put `[the collector]` in front of every
 * line, and a pipe is not a terminal. So the guard was true of the child for
 * ever, the board never opened, and the README said it did.
 *
 * Every check passed while that was so, and it is worth being precise about
 * why: the tests pass `isTTY: true` in, because the decision is the part worth
 * testing without spawning a browser. They tested the decision. Nobody tested
 * the wiring, and the wiring was the whole of it.
 *
 * ── Why an environment variable and not a flag ───────────────────────────────
 *
 * The collector takes `--no-open`, and that is somebody's instruction. This is
 * not an instruction, it is an observation, and it travels to the child the
 * same way the rest of its world does. It is also what keeps the guard honest:
 * only a launcher that itself has a terminal sets it, so the chain from a
 * person to an opened window is unbroken — person, terminal, npm start,
 * launcher, collector.
 */

// Imported from the service rather than declared here, so the two cannot
// drift: the thing that reads a name owns it.
export { WATCHING } from '../src/open-a-browser.js';

import { WATCHING } from '../src/open-a-browser.js';

/**
 * The environment to give a child, given what this process can see.
 *
 * @param {{isTTY?: boolean, env?: NodeJS.ProcessEnv}} world
 * @returns {NodeJS.ProcessEnv} the child's environment.
 */
export function environmentFor({ isTTY = process.stdout.isTTY, env = process.env } = {}) {
  // Absent rather than '0' when there is nobody: an empty value is a value,
  // and the reader would have to know that this one means no. Nothing to read
  // means nothing to get wrong.
  if (!isTTY) {
    const { [WATCHING]: _ignored, ...rest } = env;
    return rest;
  }

  return { ...env, [WATCHING]: '1' };
}
