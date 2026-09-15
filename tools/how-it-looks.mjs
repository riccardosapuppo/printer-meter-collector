#!/usr/bin/env node
/**
 * The board, measured rather than read.
 *
 *     npm run check:looks
 *     npm run check:looks -- --show
 *
 * ── Why this exists, which is a bug it would have caught ─────────────────────
 *
 * `check:screen` drives the same page and asserts what is on it: every site,
 * every device, the right states, the search. Twenty-one checks, green, for
 * months — while the header was collapsed to twenty-one pixels with half a
 * logo showing, and every supply bar on the board was drawing an empty grey
 * track with no level in it.
 *
 * One cause for both. The row across the top was `class="bar"`, and so is the
 * little bar you read a supply level off; the gauge's rule is declared later
 * in the stylesheet and says `height: 10px; overflow: hidden`, so it won. The
 * header collapsed and clipped its own contents, and the gauge inherited the
 * header's flex layout and stopped drawing its fill.
 *
 * Nothing could see it. A check that reads the DOM finds the elements exactly
 * where it expects them: they are all present, correctly labelled, with the
 * right text — and invisible, or the wrong size, or on top of each other.
 * **Where a thing is, and whether it can be seen, is a different question from
 * whether it is there**, and this project had never asked the first one.
 *
 * So these are geometric. Nothing here reads a word.
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

/**
 * The things allowed to be smaller than what is inside them.
 *
 * An allowance, written down with its reason, because the alternative is a
 * check nobody can keep green and which therefore gets deleted. It is meant to
 * stay this short: anything added here is a thing that can no longer be seen
 * to be broken, and it should cost an argument.
 */
const MAY_CLIP = [
  {
    // `.gauge > .bar` and not `.bar`, and that is not fussiness.
    //
    // Written as `.bar` this allowance excused the header as well, because the
    // header's row was ALSO called `.bar` -- which was the fault. The first
    // time these checks were run against the broken page, the clipping
    // assertion passed: the deroga had been written using the very name that
    // was the bug, and so it covered for it. An allowance keyed on what
    // something is called forgives everything that shares the name.
    selector: '.gauge > .bar',
    because: 'the gauge track: the fill inside it is drawn to the level and cropped by the track',
  },
];

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

const service = await startTheService();
const BASE = service.base;

const browser = await chromium.launch({ channel: 'msedge', headless: !show });
const page = await browser.newPage({ viewport: { width: 1360, height: 800 }, reducedMotion: 'reduce' });

try {
  console.log(`Measuring ${BASE}\n`);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // ------------------------------------------------------- nothing is cut off
  console.log('Nothing is cut off by something that hides what overflows');

  const clipped = await page.evaluate((allowed) => {
    const found = [];

    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      if (!/hidden|clip/.test(style.overflow) && !/hidden|clip/.test(style.overflowY)) continue;
      if (allowed.some((one) => el.matches(one))) continue;

      // A pixel of slack: sub-pixel layout rounds, and a check that fails on
      // half a device pixel is a check somebody turns off.
      const tall = el.scrollHeight - el.clientHeight;
      const wide = el.scrollWidth - el.clientWidth;
      if (tall <= 1 && wide <= 1) continue;

      found.push(
        `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').join('.') : ''} ` +
          `hides ${tall > 1 ? `${tall}px below` : ''}${tall > 1 && wide > 1 ? ' and ' : ''}${wide > 1 ? `${wide}px to the side` : ''}`
      );
    }

    return found;
  }, MAY_CLIP.map((one) => one.selector));

  expect('nothing on the board is hiding part of itself', clipped.length === 0, clipped.join(' | '));

  // ------------------------------------------------------ the header, on top
  console.log('\nThe row across the top stays across the top');

  const header = await page.evaluate(() => {
    const top = document.querySelector('.top');
    const inside = [...top.querySelectorAll('*')];
    const tallest = Math.max(...inside.map((one) => one.getBoundingClientRect().height));

    return { height: top.getBoundingClientRect().height, tallest };
  });

  // The failure was exactly this: a header shorter than the things in it.
  expect(
    'it is at least as tall as what is in it',
    header.height >= header.tallest,
    `the header is ${Math.round(header.height)}px and something inside it is ${Math.round(header.tallest)}px`
  );

  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(250);

  const afterScrolling = await page.evaluate(() => {
    const whole = (el) => {
      const box = el.getBoundingClientRect();
      return box.top >= -1 && box.bottom <= window.innerHeight + 1 && box.height > 0;
    };

    return {
      brand: whole(document.querySelector('.brand')),
      button: whole(document.querySelector('.topbar button')),
      scrolled: Math.round(window.scrollY),
    };
  });

  expect('and the page really did scroll', afterScrolling.scrolled > 100, `${afterScrolling.scrolled}px`);
  expect('the name is still whole on the screen', afterScrolling.brand);
  expect('and so is the button that collects now', afterScrolling.button);

  // ------------------------------------------------- the bars show the level
  console.log('\nEvery supply bar draws the level it states');

  const gauges = await page.evaluate(() => {
    const out = [];

    for (const gauge of document.querySelectorAll('.gauge')) {
      const track = gauge.querySelector('.bar');
      const fill = gauge.querySelector('.fill');
      if (!track || !fill) {
        out.push({ said: gauge.dataset.supply, drawn: null });
        continue;
      }

      out.push({
        said: gauge.dataset.supply,
        state: gauge.dataset.state,
        width: fill.getBoundingClientRect().width,
        track: track.getBoundingClientRect().width,
        asked: fill.style.width,
      });
    }

    return out;
  });

  expect('there are bars to measure at all', gauges.length > 0, `${gauges.length} found`);

  // Drawn, and not merely present. An empty track is what the board looked
  // like for months, and it is the picture this whole project exists to say
  // is dishonest.
  const empty = gauges.filter((one) => one.width !== undefined && one.width < 1 && one.asked !== '0%');
  expect('none of them is an empty track', empty.length === 0, empty.map((one) => one.said).join(', '));

  // And the width on screen is the width it asked for, rather than whatever a
  // rule meant for something else did to it.
  const wrong = gauges.filter((one) => {
    if (one.width === undefined || !one.asked.endsWith('%')) return false;
    const wanted = (parseFloat(one.asked) / 100) * one.track;
    return Math.abs(one.width - wanted) > 2;
  });

  expect(
    'and each is as wide as the level it names',
    wrong.length === 0,
    wrong.map((one) => `${one.said}: asked ${one.asked}, drawn ${Math.round(one.width)}px of ${Math.round(one.track)}px`).join(' | ')
  );

  console.log('');
  if (failures > 0) {
    console.log(`${failures} checks failed.`);
    process.exitCode = 1;
  } else {
    if (!matchesTheReadme('npm run check:looks', checks)) process.exitCode = 1;
    console.log('');
    console.log('The board is the size and shape it says it is.');
  }
} catch (error) {
  console.error(`\nThe measuring stopped: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await service.stop();
}
