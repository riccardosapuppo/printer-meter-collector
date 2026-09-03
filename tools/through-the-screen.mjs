#!/usr/bin/env node
/**
 * The board, driven with a browser.
 *
 *     npm run check:screen
 *     npm run check:screen -- --show
 *
 * A third layer, and it caught something neither of the others could. The API
 * was returning all six devices correctly; the page drew one site out of three
 * and stopped, because a device that never answered has no `pages` key at all
 * and `=== null` does not catch `undefined`. Nothing threw where a test could
 * see it, and the report simply lost two thirds of the fleet.
 *
 * So the assertion this exists for is the boring one: **what is on the screen
 * matches what the API said**. Counted, not sampled.
 */

import { createRequire } from 'node:module';

import { matchesTheReadme } from './what-the-readme-claims.mjs';
import { startTheService } from './with-the-service.mjs';

const show = process.argv.includes('--show');

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so this check cannot run.');
  console.error('It is a check, not a dependency: install it where you keep such things.');
  process.exit(2);
}

let failures = 0;
let checks = 0;

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

// A fleet and a collector of its own, on a port nothing else uses. This used
// to expect somebody to have started them, which meant the check could not
// run on a clean machine and -- worse -- passed against whatever happened to
// be listening on 3500. See with-the-service.mjs.
const service = await startTheService();
const BASE = service.base;

const browser = await chromium.launch({ channel: 'msedge', headless: !show });
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 }, reducedMotion: 'reduce' });

const thrown = [];
page.on('pageerror', (error) => thrown.push(`threw: ${error.message}`));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/Failed to load resource/.test(message.text())) return;
  thrown.push(message.text());
});

try {
  console.log(`Driving ${BASE} through the screen\n`);

  const said = await (await fetch(`${BASE}/api/devices`)).json();
  const expected = said.sites.flatMap((site) => site.devices);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // ------------------------------------------------- everything, or nothing
  console.log('The board shows what the collector found');

  const sites = await page.locator('.site').count();
  const drawn = await page.locator('.device').count();

  expect('every site is on the page', sites === said.sites.length, `${sites} drawn against ${said.sites.length}`);
  expect(
    'and every device, not most of them',
    drawn === expected.length,
    `${drawn} drawn against ${expected.length} — a page that stops halfway loses machines in silence`
  );

  for (const device of expected) {
    const card = page.locator(`.device[data-serial="${device.serial}"]`);
    // eslint-disable-next-line no-await-in-loop
    expect(`${device.serial} is on the board`, (await card.count()) === 1);
  }

  // ------------------------------------------------------- the silent one
  console.log('\nThe machine that is switched off');

  const off = expected.find((one) => !one.reachable);
  const offCard = page.locator(`.device[data-reachable="false"]`);

  expect('is drawn, and marked as not answering', (await offCard.count()) === 1);
  expect(
    'and says so in words on the card',
    /not answering/.test((await offCard.textContent()) ?? ''),
    (await offCard.textContent())?.trim().slice(0, 80)
  );
  expect('and is the one the API named', /16106/.test(off?.serial ?? ''), off?.serial);

  // ---------------------------------------------------- the unknown gauge
  console.log('\n"Nobody knows", drawn as itself');

  const unknown = page.locator('.gauge[data-state="unknown"]');
  expect('a supply the device cannot measure has its own state', (await unknown.count()) >= 1);

  expect(
    'and the word, not a number',
    /unknown/.test((await unknown.first().textContent()) ?? ''),
    await unknown.first().textContent()
  );

  // The whole argument. An empty bar is a confident picture of a machine about
  // to stop; this one must be visibly neither full nor empty.
  const hatched = await unknown.first().locator('.bar').getAttribute('data-unknown');
  expect('the bar says it is not a reading', hatched === 'true', hatched);

  const width = await unknown.first().locator('.fill').evaluate((el) => el.style.width);
  expect(
    'and is drawn full width, because the hatching is the value',
    width === '100%',
    `${width} — a hatched bar at 40% would be a number nobody has`
  );

  // -------------------------------------------------------------- finding
  console.log('\nFinding one machine among them');

  await page.fill('#find', 'magenta');
  await page.waitForTimeout(300);

  const found = await page.locator('.device').count();
  expect('searching what a device NEEDS finds it, not only its name', found >= 1, `${found} matched "magenta"`);
  expect(
    'and hides the rest',
    found < expected.length,
    'a search that matches everything is not a search'
  );

  await page.fill('#find', 'zzzz-nothing');
  await page.waitForTimeout(300);
  expect('and nothing matching says so', (await page.locator('#none').isVisible()) === true);

  await page.fill('#find', '');
  await page.waitForTimeout(300);
  expect('clearing it brings everything back', (await page.locator('.device').count()) === expected.length);

  // ------------------------------------------------------- collecting now
  console.log('\nCollecting from the page');

  await page.click('#collectNow');
  // Options are the THIRD argument of waitForFunction; the second is the value
  // passed into the page. Putting them second silently used the default
  // timeout, and the check failed on a round that simply takes longer than 30
  // seconds on a cold fleet.
  await page.waitForFunction(
    () => /answered in/.test(document.getElementById('lastRound')?.textContent ?? ''),
    undefined,
    { timeout: 60000 }
  );

  expect(
    'the button collects and reports what answered',
    /answered in/.test((await page.textContent('#lastRound')) ?? ''),
    await page.textContent('#lastRound')
  );

  expect('nothing on the page threw along the way', thrown.length === 0, thrown.join(' | '));

  console.log('');
  if (failures > 0) {
    console.log(`${failures} checks failed.`);
    process.exitCode = 1;
  } else {
    console.log('');
    // Il numero non si mantiene: lo verifica il programma di cui e il numero.
    if (!matchesTheReadme('npm run check:screen', checks)) process.exitCode = 1;
    console.log('');
    console.log('Every machine the collector found is on the board, including the one that is off.');
  }
} catch (error) {
  console.error(`\nThe journey stopped: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await service.stop();
}
