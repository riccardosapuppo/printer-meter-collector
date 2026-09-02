/**
 * The readings, kept.
 *
 * Append-only lines of JSON in a file, and that is a considered choice rather
 * than a shortcut. A meter read is an event that happened at a time and is
 * never corrected: nothing here updates a row, and a store whose only operation
 * is "append" cannot lose history to a bad UPDATE. It is the same shape a
 * time-series database has underneath.
 *
 * What it costs, said plainly: everything is loaded at startup, so this holds a
 * few hundred thousand readings and not a few hundred million. A real
 * deployment puts these lines in PostgreSQL or a time-series store and keeps
 * exactly this interface — which is why the interface is four functions and
 * says nothing about files.
 *
 * Filed by SERIAL, never by address. An address is where a device is today.
 */

import fs from 'node:fs';
import path from 'node:path';

export function readingStore({ file, at = () => Date.now() }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  /** @type {Map<string, object[]>} serial -> readings, oldest first */
  const bySerial = new Map();

  /** Devices seen that could not be identified. Kept apart, not thrown away. */
  const unidentified = [];

  load();

  function load() {
    if (!fs.existsSync(file)) return;

    const lines = fs.readFileSync(file, 'utf8').split('\n');

    for (const [number, line] of lines.entries()) {
      if (!line.trim()) continue;

      let reading;
      try {
        reading = JSON.parse(line);
      } catch {
        // One bad line does not lose the file. A process killed mid-write
        // leaves a half-line at the end, and refusing to start because of it
        // would turn a rough shutdown into a lost history.
        console.error(
          JSON.stringify({
            level: 'warn',
            message: 'a line of the reading file could not be read and was skipped',
            line: number + 1,
          })
        );
        continue;
      }

      keep(reading, { append: false });
    }
  }

  /**
   * Where a reading is filed.
   *
   * The serial, when there is one. When there is not — a device that did not
   * answer at all, which is every switched-off printer in every fleet — the
   * address, marked as provisional.
   *
   * Filing those under nothing was the first version and it lost them
   * completely: a machine that has never once answered has no serial, so it had
   * no history, so it was not on the dashboard, so nobody knew it was down. The
   * one device the sample fleet has specifically to catch this was the device it
   * hid. If it answers later its readings move to the real serial, and the
   * address entry stays as the record of the silence.
   */
  function keyFor(reading) {
    if (reading.serial) return { key: reading.serial, provisional: false };
    return { key: `at ${reading.host}:${reading.port}`, provisional: true };
  }

  function keep(reading, { append = true } = {}) {
    if (append) fs.appendFileSync(file, `${JSON.stringify(reading)}\n`);

    const { key, provisional } = keyFor(reading);

    // Answered, and would not say which device it is. That is neither a
    // healthy reading nor a silence, and merging two of them into one machine
    // would produce impossible counters.
    if (provisional && reading.reachable) unidentified.push(reading);

    if (!bySerial.has(key)) bySerial.set(key, []);
    bySerial.get(key).push({ ...reading, provisionalIdentity: provisional });
  }

  return {
    /** Records a reading. Returns what changed since the last one. */
    record(reading) {
      const before = bySerial.get(keyFor(reading).key)?.at(-1) ?? null;
      keep(reading);
      return since(before, reading);
    },

    /** Every device ever seen, most recently read first. */
    devices() {
      return [...bySerial.entries()]
        .map(([serial, readings]) => ({
          serial,
          latest: readings.at(-1),
          readings: readings.length,
          firstSeen: readings[0].at,
        }))
        .sort((a, b) => String(b.latest.at).localeCompare(String(a.latest.at)));
    },

    /** The history of one device, oldest first. */
    history(serial, { limit = 500 } = {}) {
      return (bySerial.get(serial) ?? []).slice(-limit);
    },

    /**
     * Pages printed per day, worked out from the counter.
     *
     * A page counter only goes up, so a rate is a difference over a time. Two
     * things spoil that and both are handled rather than averaged away: a
     * counter that goes DOWN means the board was replaced or the machine was
     * swapped, and a gap of days means nothing was collected — not that nothing
     * was printed.
     */
    usage(serial, { overDays = 30 } = {}) {
      const readings = (bySerial.get(serial) ?? []).filter((one) => typeof one.pages === 'number');
      if (readings.length < 2) return null;

      const from = at() - overDays * 86_400_000;
      const within = readings.filter((one) => Date.parse(one.at) >= from);
      const usable = within.length >= 2 ? within : readings.slice(-2);

      const spans = [];
      for (let step = 1; step < usable.length; step += 1) {
        const before = usable[step - 1];
        const now = usable[step];
        const pages = now.pages - before.pages;
        const ms = Date.parse(now.at) - Date.parse(before.at);

        if (ms <= 0) continue;
        if (pages < 0) {
          // A counter that went backwards. Not a negative day's printing:
          // a different machine, or a replaced board.
          spans.push({ ms, pages: null, reset: true });
          continue;
        }
        spans.push({ ms, pages, reset: false });
      }

      const counted = spans.filter((one) => !one.reset);
      if (counted.length === 0) return { perDay: null, why: 'the counter was reset in every span', resets: spans.length };

      const pages = counted.reduce((total, one) => total + one.pages, 0);
      const ms = counted.reduce((total, one) => total + one.ms, 0);

      return {
        perDay: Math.round((pages / ms) * 86_400_000),
        overDays: Math.round(ms / 86_400_000),
        pages,
        resets: spans.filter((one) => one.reset).length,
        why: null,
      };
    },

    /** Addresses that answered but would not say which device they are. */
    unidentified: () => unidentified.slice(-50),

    counts() {
      return {
        devices: bySerial.size,
        readings: [...bySerial.values()].reduce((total, one) => total + one.length, 0),
        unidentified: unidentified.length,
        file,
      };
    },
  };
}

/**
 * What changed between two readings of the same device.
 *
 * Only used for what is worth telling somebody about, so it names the things
 * that mean a person should act: a supply that has crossed a threshold, a new
 * alert, a counter that went backwards.
 */
export function since(before, now) {
  if (!before) return { first: true, changes: [] };

  const changes = [];

  if (typeof before.pages === 'number' && typeof now.pages === 'number' && now.pages < before.pages) {
    changes.push({
      what: 'the page counter went backwards',
      from: before.pages,
      to: now.pages,
      meaning: 'a replaced board, or a different machine at this address',
    });
  }

  const wasAlerting = new Set((before.alerts ?? []).map((one) => one.text));
  for (const alert of now.alerts ?? []) {
    if (!wasAlerting.has(alert.text)) {
      changes.push({ what: 'a new alert', text: alert.text, severity: alert.severity });
    }
  }

  if (before.reachable && !now.reachable) {
    changes.push({ what: 'it stopped answering', why: now.why });
  }

  if (!before.reachable && now.reachable) {
    changes.push({ what: 'it is answering again' });
  }

  return { first: false, changes };
}
