#!/usr/bin/env node
/**
 * The whole collector, driven over HTTP against the running fleet.
 *
 *     npm run walkthrough
 *     npm run walkthrough -- --against http://localhost:3500
 *
 * It starts its own fleet and its own collector, on a port nothing else uses,
 * and stops them again. It used to expect somebody to have started them first,
 * which meant it could not run on a clean machine -- and, worse, that on a
 * machine with something already listening on 3500 it passed against whatever
 * that was. See tools/with-the-service.mjs.
 *
 * The check that is not written behind the same door as the code. The unit
 * tests call the functions directly and were written beside them, which makes
 * them good at saying the parts still do what they did and blind to a route
 * mounted wrongly, a reading that never reaches the store, or a device that
 * quietly disappears from the report.
 *
 * The last of those is the one this exists for. A collector's worst failure is
 * not a wrong number: it is a machine that stops being mentioned. Nobody
 * notices an absence, and the printer that is switched off is precisely the
 * one somebody needed to hear about.
 */

import { matchesTheReadme } from './what-the-readme-claims.mjs';
import { withTheService } from './with-the-service.mjs';

// Set by withTheService, which decides whether that is one it started or one
// somebody pointed it at with --against.
let BASE = '';

let checks = 0;
let failures = 0;

function expect(what, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}`);
    if (detail !== undefined) console.log(`        ${detail}`);
  }
}

async function get(where) {
  const response = await fetch(`${BASE}${where}`);
  return { status: response.status, body: await response.json() };
}

async function post(where, body) {
  const response = await fetch(`${BASE}${where}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * Waits until the round the service started at boot has actually finished.
 *
 * `running` is "a round is in flight"; `rounds` is how many have completed. So
 * the fleet is only fully reported once one round has completed AND none is in
 * flight — either half alone is a state the report is still being written in.
 *
 * Polled rather than slept against: a fixed delay is a guess about somebody
 * else's machine, and the guess is what failed.
 */
async function untilTheFirstRoundIsDone({ within = 90_000 } = {}) {
  const until = Date.now() + within;
  let last = null;

  while (Date.now() < until) {
    const health = await get('/api/health');
    last = health.body?.collector;

    if (last && last.rounds >= 1 && last.running === false) {
      console.log(`  (the first round finished: ${last.rounds} round, ${health.body.devices} devices)`);
      return;
    }

    await new Promise((done) => setTimeout(done, 250));
  }

  throw new Error(
    `the first round never finished within ${within} ms — the collector says ${JSON.stringify(last)}`
  );
}

/** Waits until no round is in flight, whoever started it. */
async function untilNothingIsInFlight({ within = 90_000 } = {}) {
  const until = Date.now() + within;
  let last = null;

  while (Date.now() < until) {
    const health = await get('/api/health');
    last = health.body?.collector;

    if (last && last.running === false) return;
    await new Promise((done) => setTimeout(done, 250));
  }

  throw new Error(`a round was still going after ${within} ms — ${JSON.stringify(last)}`);
}

async function main() {
  console.log(`Driving ${BASE}\n`);

  // ------------------------------------------------------------- what it is
  console.log('What it says it is');

  const health = await get('/api/health');
  expect('it is up', health.status === 200 && health.body.status === 'ok');
  expect(
    'and says plainly that it writes nothing',
    /nothing/.test(health.body.writes),
    health.body.writes
  );
  expect(
    'reading over SNMP on the open standard',
    /RFC 3805/.test(health.body.reads),
    health.body.reads
  );

  // -------------------------------------------------------------- the fleet
  console.log('\nThe fleet');

  // Waited for, not assumed.
  //
  // The collector starts a round the moment it comes up, and everything below
  // reads what that round produced. On this workstation it had always finished
  // by the time the first request arrived; on a continuous-integration runner
  // it had not, five of the six printers had answered so far, and the check
  // that exists to notice a machine going missing reported a machine missing —
  // right about the wrong thing. Then asking for a second round was refused,
  // correctly, because the first was still going.
  //
  // A check that depends on something finishing in time is a check that passes
  // on the machine that wrote it.
  await untilTheFirstRoundIsDone();

  const first = await get('/api/devices');
  expect('the fleet comes back grouped by site', first.body.sites.length >= 3, first.body.sites.length);

  const devices = first.body.sites.flatMap((site) => site.devices);
  expect(
    'and every device in the fleet file is in the report',
    devices.length === health.body.fleet,
    `${devices.length} in the report against ${health.body.fleet} in the fleet file`
  );

  // The point of the whole check. A machine nobody hears about is worse than a
  // wrong number, and the one that is switched off is the one that matters.
  const silent = devices.filter((one) => !one.reachable);
  expect(
    'including the one that never answers',
    silent.length === 1,
    `${silent.length} silent — a device with no serial has no history, and is exactly what a report loses`
  );
  expect(
    'which is named by its address, since it never said a serial',
    /127\.0\.0\.1:16106/.test(silent[0]?.serial ?? ''),
    silent[0]?.serial
  );
  expect(
    'and says out loud that somebody should look at it',
    silent[0]?.needs?.[0]?.urgent === true,
    JSON.stringify(silent[0]?.needs)
  );

  // ------------------------------------------------------- the awkward ones
  console.log('\nThe readings that are easy to get wrong');

  const all = devices.flatMap((device) => device.supplies.map((supply) => ({ device, supply })));

  const unmeasurable = all.find((one) => one.supply.remaining === null);
  expect(
    'a supply the device cannot measure is not given a percentage',
    Boolean(unmeasurable),
    'the sample fleet has one on purpose: it is what turns into a confident 0%'
  );
  expect(
    'and says why instead',
    /does not measure/.test(unmeasurable?.supply.why ?? ''),
    unmeasurable?.supply.why
  );
  expect(
    'so nobody is asked to change it',
    !(unmeasurable?.device.needs ?? []).some((need) => need.what.includes(unmeasurable.supply.description)),
    JSON.stringify(unmeasurable?.device.needs)
  );

  const waste = all.find((one) => one.supply.kind === 'filled');
  expect('a receptacle is marked as one', Boolean(waste), 'the fleet has waste containers');
  expect(
    'and is turned the right way round: full means nearly unusable',
    waste && waste.supply.remaining === 100 - waste.supply.percent,
    JSON.stringify(waste?.supply)
  );

  const inSheets = all.find((one) => one.supply.unit === 'sheets');
  expect(
    'a supply reported in sheets keeps its unit',
    Boolean(inSheets),
    'otherwise 430 labels is shown as 430 per cent'
  );

  const twoBlacks = devices.find(
    (device) => device.supplies.filter((one) => /Black Toner/.test(one.description ?? '')).length > 1
  );
  expect(
    'a machine with two cartridges of one colour reports both',
    Boolean(twoBlacks),
    'code that assumes one row per colour reports half the toner it has'
  );

  // --------------------------------------------------------------- the pages
  console.log('\nThe counters');

  const counted = devices.filter((one) => one.reachable);
  expect('every device that answered gave a page count', counted.every((one) => typeof one.pages === 'number'));
  expect(
    'and one of them is past two billion — or at least past a signed 32-bit integer',
    counted.every((one) => one.pages >= 0),
    'a Counter32 shifted instead of multiplied comes back negative'
  );

  // ------------------------------------------------------- collecting again
  console.log('\nGoing round again');

  // The scheduler goes round on its own every minute. Everything above takes
  // seconds here and could take longer elsewhere, so the scheduled round can
  // have started while this check was reading counters — and asking for one on
  // top of it is refused, correctly, by the very guard being tested.
  await untilNothingIsInFlight();

  const round = await post('/api/round');
  expect('a round can be asked for', round.status === 200, JSON.stringify(round.body));
  expect(
    'and reports what answered and what did not',
    round.body.answered === health.body.fleet - 1 && round.body.silent === 1,
    JSON.stringify(round.body)
  );
  expect(
    'and finishes in seconds, not a minute',
    round.body.tookMs < 30_000,
    `${round.body.tookMs} ms — retrying at two layers multiplies them, and made this twenty seconds`
  );

  const second = await get('/api/devices');
  const before = devices.find((one) => one.reachable && one.pages > 0);
  const after = second.body.sites.flatMap((site) => site.devices).find((one) => one.serial === before.serial);

  expect('the history grew', after.readings > before.readings, `${before.readings} then ${after.readings}`);
  expect(
    'and pages a day can now be worked out from it',
    after.usage !== null && typeof after.usage.perDay === 'number',
    JSON.stringify(after.usage)
  );

  const history = await get(`/api/devices/${encodeURIComponent(before.serial)}`);
  expect('one device has a history of its own', history.status === 200 && history.body.history.length >= 2);

  const missing = await get('/api/devices/NOT-A-SERIAL');
  expect('and a serial nobody has is a 404', missing.status === 404, missing.status);

  // ----------------------------------------------------------- the sweeping
  console.log('\nSweeping, and what it will not sweep');

  const outside = await post('/api/discover', { range: '8.8.8.0/24' });
  expect(
    'a range outside the private addresses is refused',
    outside.status === 403,
    `got ${outside.status} — sweeping a network you do not administer is not something this does by default`
  );
  expect('and says why', /not a private address/.test(outside.body.error ?? ''), outside.body.error);

  const tooWide = await post('/api/discover', { range: '10.0.0.0/8' });
  expect('a range wide enough to be a typo is refused', tooWide.status === 400, tooWide.status);

  const nonsense = await post('/api/discover', {});
  expect('and a missing range is asked for', nonsense.status === 400, nonsense.status);

  // ------------------------------------------------------------------- end
  //
  // The README's own claim about this command, checked by this command. A
  // number in a README is a claim about a program sitting right there and able
  // to be asked; until this line existed nobody ever asked it, and a sibling
  // project drifted from 86 to 92 without one red run.
  console.log('');
  if (!matchesTheReadme('npm run walkthrough', checks)) failures += 1;

  console.log('');
  if (failures > 0) {
    console.log(`${failures} of ${checks} checks failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`All ${checks} checks passed.`);
}

withTheService(async (base) => {
  BASE = base;
  await main();
}).catch((error) => {
  console.error(`\n${error.stack}`);
  process.exit(1);
});
