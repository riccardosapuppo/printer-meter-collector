#!/usr/bin/env node
/**
 * The pictures in the README, taken from the running collector.
 *
 *     npm run screenshots
 *
 * A script rather than files somebody cropped by hand, for the same reason the
 * mark is drawn and not exported: a picture made once drifts from the thing it
 * is a picture of.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.METERS_URL || 'http://localhost:3500';
const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, '..', 'docs');

let chromium;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so the pictures cannot be retaken.');
  process.exit(2);
}

fs.mkdirSync(DOCS, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const say = (name) => console.log(`  docs/${name}`);

try {
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1100 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);

  await page.screenshot({ path: path.join(DOCS, 'board.png'), fullPage: true });
  say('board.png');

  // The device that cannot measure its toner, on its own. This is the picture
  // that says what the project is about.
  const unknown = page.locator('.device').filter({ has: page.locator('.gauge[data-state="unknown"]') }).first();
  await unknown.screenshot({ path: path.join(DOCS, 'unknown.png') });
  say('unknown.png');

  // And the one that is switched off, which a report must never lose.
  await page.locator('.device[data-reachable="false"]').first().screenshot({
    path: path.join(DOCS, 'silent.png'),
  });
  say('silent.png');
  await page.close();

  const phone = await browser.newPage({
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  await phone.goto(BASE, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(1200);
  await phone.screenshot({ path: path.join(DOCS, 'phone.png'), fullPage: true });
  say('phone.png');
  await phone.close();

  console.log('\nThe pictures in the README are of the board as it is now.');
} catch (error) {
  console.error(`\nThe pictures could not be retaken: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
