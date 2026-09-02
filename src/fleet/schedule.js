/**
 * Going round the fleet, on a timer, without falling over one dead machine.
 *
 * Three things a collector has to get right, and each one is a lesson somebody
 * paid for:
 *
 *   1. **A device that does not answer must not stop the round.** A fleet
 *      always has a machine switched off, and a sweep that throws on the third
 *      of two hundred loses a hundred and ninety-seven readings.
 *   2. **A few at a time, not all at once.** Two hundred simultaneous UDP
 *      requests from one process is a burst a switch will drop, and the drops
 *      look exactly like devices that are offline.
 *   3. **Retries wait longer AND spread out.** A site that comes back after a
 *      network wobble is met by every collector retrying in the same second.
 *      Doubling alone synchronises them; the randomness is the part usually
 *      left out.
 *
 * A round overrunning its interval is the fourth, and it is the one that is
 * invisible until it is serious: a sweep taking eleven minutes on a ten-minute
 * timer starts a second sweep on top of the first, and then a third. So a round
 * that is still going is not started again — it is reported.
 */

export function collector({
  devices,
  read,
  store,
  atATime = 8,
  everyMs = 600_000,
  retries = 2,
  baseDelayMs = 1000,
  maxDelayMs = 30_000,
  log = () => {},
  at = () => Date.now(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  let running = false;
  let timer = null;
  let rounds = 0;
  let lastRound = null;
  let skipped = 0;

  /**
   * One device. Never throws: a failure is a reading too.
   *
   * **Retries do not happen at two layers.** The SNMP client already sends each
   * request three times, because UDP drops packets and that is what those
   * retries are for. Retrying here on top of that multiplied them: nine two-
   * second waits for a printer that is simply switched off, and on a fleet of
   * two hundred with ten off, six minutes of a round spent waiting for machines
   * nobody expected to answer.
   *
   * So the two layers are given different jobs. `reachable: false` is the
   * client's conclusion after its own attempts — a settled answer, taken as it
   * is. A THROWN error is something else: a socket that could not be opened, a
   * name that would not resolve. That is worth another go, after a wait that is
   * spread out so two collectors started together do not stay together.
   */
  async function readOne(device) {
    let last = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        const doubled = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await wait(Math.floor(doubled / 2 + Math.random() * (doubled / 2)));
      }

      try {
        return await read(device);
      } catch (error) {
        last = {
          ...device,
          at: new Date(at()).toISOString(),
          reachable: false,
          why: error.message,
        };
      }
    }

    return last;
  }

  /**
   * A round: every device, a few at a time.
   *
   * The pool is written out rather than reached for, because the shape matters:
   * workers pull from a shared list, so one slow device holds up one worker
   * instead of a whole batch. Splitting into fixed batches makes every batch as
   * slow as its slowest member.
   */
  async function round() {
    if (running) {
      skipped += 1;
      log('warn', 'a round was still going when the next was due', {
        skipped,
        meaning: 'the sweep takes longer than the interval — raise the interval or the concurrency',
      });
      return null;
    }

    running = true;
    const started = at();
    const queue = [...devices()];
    const readings = [];

    try {
      const workers = Array.from({ length: Math.min(atATime, queue.length) }, async () => {
        for (;;) {
          const device = queue.shift();
          if (!device) return;

          const reading = await readOne(device);
          const changed = store.record(reading);
          readings.push(reading);

          for (const change of changed.changes) {
            log('warn', 'something changed on a device', {
              serial: reading.serial,
              host: reading.host,
              ...change,
            });
          }
        }
      });

      await Promise.all(workers);
    } finally {
      running = false;
    }

    rounds += 1;
    lastRound = {
      at: new Date(started).toISOString(),
      tookMs: at() - started,
      asked: readings.length,
      answered: readings.filter((one) => one.reachable).length,
      silent: readings.filter((one) => !one.reachable).length,
    };

    log('info', 'round finished', lastRound);
    return lastRound;
  }

  return {
    round,

    start() {
      if (timer) return;
      // `unref` so a round pending does not hold the process open when
      // somebody has asked it to stop.
      timer = setInterval(() => void round(), everyMs);
      timer.unref?.();
      log('info', 'collecting', { every_ms: everyMs, at_a_time: atATime });
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },

    state() {
      return { running, rounds, skipped, lastRound, everyMs, atATime };
    },
  };
}
