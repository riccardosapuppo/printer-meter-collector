import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { describeSupply } from '../src/fleet/read.js';
import { readingStore, since } from '../src/fleet/store.js';
import { collector } from '../src/fleet/schedule.js';
import { addressesIn, isPrivate } from '../src/fleet/discover.js';
import { whatItNeeds } from '../src/http/api.js';
import { compareOids } from '../sim/printer.js';

describe('a supply, said in a way somebody can act on', () => {
  it('gives a percentage when there is honestly one to give', () => {
    const said = describeSupply('1.1', { description: 'Black Toner', level: 64, max: 100, unit: 19, kind: 3 });

    assert.equal(said.remaining, 64);
    assert.equal(said.why, null);
  });

  it('refuses to invent one from a level the device says it cannot measure', () => {
    // RFC 3805 uses -2 for "there is some, and I do not measure it". Divided by
    // the maximum it becomes a confident -2%, or clamped, a confident 0% — and
    // 0% orders a cartridge for a machine that does not need one.
    const said = describeSupply('1.1', { description: 'Black Toner', level: -2, max: 100, unit: 19, kind: 3 });

    assert.equal(said.remaining, null);
    assert.equal(said.percent, null);
    assert.match(said.why, /does not measure/);
  });

  it('and not from a maximum the device would not state', () => {
    const said = describeSupply('1.1', { description: 'Drum', level: 40, max: 0, unit: 19, kind: 3 });

    assert.equal(said.remaining, null);
    assert.match(said.why, /what full is/);
  });

  it('turns a receptacle the right way round', () => {
    // A waste bottle 90% full has 10% of its life left. Reporting 90 as
    // "remaining" says the opposite of the truth about the machine that is
    // closest to stopping.
    const said = describeSupply('1.2', { description: 'Waste Toner', level: 90, max: 100, unit: 19, kind: 4 });

    assert.equal(said.percent, 90);
    assert.equal(said.remaining, 10);
    assert.match(said.why, /fills up/);
  });

  it('keeps the unit, so 430 sheets is not 430 per cent', () => {
    const said = describeSupply('1.1', { description: 'Label roll', level: 430, max: 2000, unit: 8, kind: 3 });

    assert.equal(said.unit, 'sheets');
    assert.equal(said.remaining, 22);
  });
});

describe('what a person would have to do about it', () => {
  const fine = { reachable: true, supplies: [], trays: [], alerts: [] };

  it('says nothing about a machine that is fine', () => {
    assert.deepEqual(whatItNeeds(fine), []);
  });

  it('names a machine that is not answering, and calls it urgent', () => {
    const needs = whatItNeeds({ reachable: false, why: 'nothing answered' });

    assert.equal(needs.length, 1);
    assert.equal(needs[0].urgent, true);
  });

  it('does not ask anybody to change a toner the device cannot measure', () => {
    // The whole reason `remaining` is allowed to be null. A threshold applied
    // to "unknown" produces a job for an engineer that did not need doing.
    const needs = whatItNeeds({
      ...fine,
      supplies: [{ description: 'Black Toner', remaining: null, percent: null, kind: 'consumed' }],
    });

    assert.deepEqual(needs, []);
  });

  it('reads a full waste container as needing attention, not an empty one', () => {
    const full = whatItNeeds({
      ...fine,
      supplies: [{ description: 'Waste Toner', remaining: 5, percent: 95, kind: 'filled' }],
    });
    const fresh = whatItNeeds({
      ...fine,
      supplies: [{ description: 'Waste Toner', remaining: 95, percent: 5, kind: 'filled' }],
    });

    assert.equal(full.length, 1);
    assert.equal(full[0].urgent, true);
    assert.deepEqual(fresh, []);
  });
});

describe('the history', () => {
  let file;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meters-')), 'readings.jsonl');
  });

  afterEach(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const reading = (over) => ({
    host: '127.0.0.1',
    port: 161,
    at: new Date().toISOString(),
    reachable: true,
    serial: 'SIM-1',
    pages: 100,
    supplies: [],
    trays: [],
    alerts: [],
    ...over,
  });

  it('keeps a device that has never once answered', () => {
    // It has no serial, so it has no history, so it is not on the dashboard,
    // so nobody knows it is down. The switched-off printer is the one thing a
    // fleet report must not lose.
    const store = readingStore({ file });
    store.record({ host: '127.0.0.1', port: 16106, at: new Date().toISOString(), reachable: false, why: 'silence' });

    const devices = store.devices();
    assert.equal(devices.length, 1);
    assert.match(devices[0].serial, /127\.0\.0\.1:16106/);
    assert.equal(devices[0].latest.reachable, false);
  });

  it('does not file a silent address as an unidentified device', () => {
    // Two different problems. One answered and would not say who it is; the
    // other said nothing at all. Mixing them means an engineer sent to
    // investigate the wrong thing.
    const store = readingStore({ file });
    store.record({ host: '127.0.0.1', port: 16106, at: new Date().toISOString(), reachable: false });
    store.record({ host: '127.0.0.1', port: 16107, at: new Date().toISOString(), reachable: true, serial: null });

    assert.equal(store.unidentified().length, 1);
    assert.equal(store.unidentified()[0].port, 16107);
  });

  it('survives a half-written line at the end of the file', () => {
    // What a process killed mid-append leaves behind. Refusing to start
    // because of it turns a rough shutdown into a lost history.
    fs.writeFileSync(file, `${JSON.stringify(reading())}\n{"serial":"SIM-2","pa`);

    const store = readingStore({ file });
    assert.equal(store.counts().devices, 1);
  });

  it('works out pages a day from the counter', () => {
    const store = readingStore({ file, at: () => Date.parse('2026-03-11T00:00:00Z') });

    store.record(reading({ at: '2026-03-01T00:00:00Z', pages: 1000 }));
    store.record(reading({ at: '2026-03-11T00:00:00Z', pages: 2000 }));

    assert.equal(store.usage('SIM-1').perDay, 100);
  });

  it('does not read a replaced counter as a negative day', () => {
    // A counter only goes up. One that went down means a new board or a
    // different machine — not that somebody un-printed nine hundred pages.
    const store = readingStore({ file, at: () => Date.parse('2026-03-21T00:00:00Z') });

    store.record(reading({ at: '2026-03-01T00:00:00Z', pages: 1000 }));
    store.record(reading({ at: '2026-03-11T00:00:00Z', pages: 100 }));
    store.record(reading({ at: '2026-03-21T00:00:00Z', pages: 200 }));

    const usage = store.usage('SIM-1');
    assert.equal(usage.resets, 1);
    assert.equal(usage.perDay, 10, 'the reset span must be left out, not averaged in');
  });

  it('says nothing rather than guessing from one reading', () => {
    const store = readingStore({ file });
    store.record(reading());

    assert.equal(store.usage('SIM-1'), null);
  });
});

describe('what changed since last time', () => {
  it('notices a counter that went backwards', () => {
    const changed = since({ pages: 1000, reachable: true }, { pages: 10, reachable: true });

    assert.equal(changed.changes.length, 1);
    assert.match(changed.changes[0].what, /backwards/);
  });

  it('notices a new alert and stays quiet about an old one', () => {
    const before = { reachable: true, alerts: [{ text: 'Paper jam' }] };

    assert.deepEqual(since(before, { reachable: true, alerts: [{ text: 'Paper jam' }] }).changes, []);
    assert.equal(
      since(before, { reachable: true, alerts: [{ text: 'Paper jam' }, { text: 'Toner low' }] }).changes.length,
      1
    );
  });

  it('notices a machine going quiet and coming back', () => {
    assert.match(since({ reachable: true }, { reachable: false }).changes[0].what, /stopped answering/);
    assert.match(since({ reachable: false }, { reachable: true }).changes[0].what, /answering again/);
  });
});

describe('going round the fleet', () => {
  const store = () => ({ record: () => ({ first: true, changes: [] }) });

  it('reads every device even when one of them throws', () => {
    return (async () => {
      const asked = [];
      const rounds = collector({
        devices: () => [{ host: 'a' }, { host: 'b' }, { host: 'c' }],
        read: async (device) => {
          asked.push(device.host);
          if (device.host === 'b') throw new Error('the socket would not open');
          return { ...device, reachable: true };
        },
        store: store(),
        retries: 0,
        atATime: 2,
        wait: async () => {},
      });

      const said = await rounds.round();

      assert.deepEqual(asked.sort(), ['a', 'b', 'c']);
      assert.equal(said.asked, 3);
      assert.equal(said.silent, 1);
    })();
  });

  it('does not retry a device that has settled on "did not answer"', async () => {
    // The defect this was written for: the SNMP client already sends three
    // times because UDP drops packets, and retrying on top of it made nine
    // two-second waits for a printer that is switched off.
    let calls = 0;

    const rounds = collector({
      devices: () => [{ host: 'off' }],
      read: async (device) => {
        calls += 1;
        return { ...device, reachable: false, why: 'nothing answered' };
      },
      store: store(),
      retries: 2,
      wait: async () => {},
    });

    await rounds.round();
    assert.equal(calls, 1);
  });

  it('but does try again when the attempt itself failed', async () => {
    let calls = 0;

    const rounds = collector({
      devices: () => [{ host: 'flaky' }],
      read: async (device) => {
        calls += 1;
        if (calls < 3) throw new Error('the socket would not open');
        return { ...device, reachable: true };
      },
      store: store(),
      retries: 2,
      wait: async () => {},
    });

    const said = await rounds.round();
    assert.equal(calls, 3);
    assert.equal(said.answered, 1);
  });

  it('will not start a second round on top of one that is still going', async () => {
    // Invisible until it is serious: a sweep taking eleven minutes on a
    // ten-minute timer puts two on the same fleet, and then three.
    let release;
    const held = new Promise((done) => {
      release = done;
    });

    const rounds = collector({
      devices: () => [{ host: 'slow' }],
      read: async (device) => {
        await held;
        return { ...device, reachable: true };
      },
      store: store(),
      wait: async () => {},
    });

    const first = rounds.round();
    const second = await rounds.round();

    assert.equal(second, null, 'the second round should have declined');
    assert.equal(rounds.state().skipped, 1);

    release();
    await first;
  });
});

describe('sweeping a range', () => {
  it('leaves out the network and broadcast addresses', () => {
    const found = addressesIn('192.168.1.0/24');

    assert.equal(found.length, 254);
    assert.equal(found[0], '192.168.1.1');
    assert.equal(found.at(-1), '192.168.1.254');
  });

  it('handles a single address', () => {
    assert.deepEqual(addressesIn('10.0.0.7/32'), ['10.0.0.7']);
  });

  it('refuses a range wide enough to be a mistake', () => {
    // A mistyped /8 is sixteen million addresses and would still be running
    // tomorrow. This first asserted that a /8 was refused for its SIZE, and it
    // is not — the prefix bound catches it before anything counts addresses,
    // which meant the size guard behind it could never fire. It has been
    // removed rather than left in reading as protection it was not providing.
    for (const range of ['10.0.0.0/8', '10.0.0.0/12', '10.0.0.0/15']) {
      assert.throws(() => addressesIn(range), /between \/16 and \/32/, range);
    }

    assert.equal(addressesIn('10.0.0.0/16').length, 65_534, 'a /16 is the widest it will do');
  });

  it('knows which addresses are somebody’s own network', () => {
    assert.equal(isPrivate('192.168.1.10'), true);
    assert.equal(isPrivate('10.4.4.4'), true);
    assert.equal(isPrivate('172.16.0.1'), true);
    assert.equal(isPrivate('172.32.0.1'), false, '172.32 is outside the private range and is easy to get wrong');
    assert.equal(isPrivate('8.8.8.8'), false);
  });
});

describe('ordering object identifiers', () => {
  it('sorts by arc as a number, so .10 comes after .9', () => {
    const sorted = ['1.3.6.1.2.1.43.11.1.1.9.1.10', '1.3.6.1.2.1.43.11.1.1.9.1.9'].sort(compareOids);

    // Sorted as text, "10" comes before "9" — and a get-next walk built on
    // that revisits rows and either loops or stops early.
    assert.deepEqual(sorted, ['1.3.6.1.2.1.43.11.1.1.9.1.9', '1.3.6.1.2.1.43.11.1.1.9.1.10']);
  });

  it('puts a shorter OID before the longer ones under it', () => {
    assert.ok(compareOids('1.3.6.1.2.1.43', '1.3.6.1.2.1.43.11') < 0);
  });
});
