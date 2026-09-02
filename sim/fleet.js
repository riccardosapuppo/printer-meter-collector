#!/usr/bin/env node
/**
 * A fleet of six invented printers, on localhost.
 *
 *     npm run fleet
 *
 * Every device, site, serial and page count below is made up. They are shaped
 * to be awkward in the ways real fleets are, because a collector that only ever
 * meets tidy devices is a collector that has never been tested:
 *
 *   - one that **cannot measure its toner** and says so with −2, which turned
 *     into a confident "0%" the first time anything divided it by a maximum;
 *   - one with a **waste bottle**, which fills rather than empties, so "low" is
 *     the opposite direction;
 *   - one with **two black cartridges**, so a reader that assumes one row per
 *     colour reports half the toner it has;
 *   - one reporting its supplies in **sheets** rather than percent, so a level
 *     of 400 is not four hundred per cent;
 *   - one **switched off**, because a fleet always has one and a collector that
 *     cannot say "did not answer" is a collector that quietly forgets a machine;
 *   - one with a **paper jam**, so the alerts have something in them.
 */

import { startPrinter } from './printer.js';

const started = Date.now();

/** Counts drift while it runs, so the history is a history of something. */
function counting(from, perMinute) {
  return () => from + Math.floor(((Date.now() - started) / 60_000) * perMinute);
}

function draining(from, perMinute, floor = 0) {
  return () => Math.max(floor, Math.round(from - ((Date.now() - started) / 60_000) * perMinute));
}

export const FLEET = [
  {
    port: 16101,
    name: 'front-desk',
    site: 'Harbour Street',
    description: 'Invented Multifunction 4200 series',
    location: 'Harbour Street, ground floor',
    serial: 'SIM-4200-000117',
    startedAt: started - 86_400_000 * 31,
    pages: counting(184_233, 9),
    supplies: [
      { description: 'Black Toner Cartridge', class: 3, unit: 19, max: 100, level: draining(64, 0.4, 3) },
      { description: 'Waste Toner Container', class: 4, unit: 19, max: 100, level: counting(71, 0.2) },
    ],
    trays: [
      { description: 'Tray 1 (A4)', max: 520, level: draining(410, 3, 0) },
      { description: 'Bypass tray', max: 100, level: () => 0 },
    ],
    alerts: [],
  },

  {
    port: 16102,
    name: 'accounts',
    site: 'Harbour Street',
    description: 'Invented LaserWriter 310',
    location: 'Harbour Street, first floor',
    serial: 'SIM-310-004821',
    startedAt: started - 86_400_000 * 402,
    pages: counting(1_402_889, 3),
    supplies: [
      // The device cannot tell. RFC 3805 says −2: there is some, and it does
      // not measure. Anything that divides this by the maximum prints a
      // confident number that is a lie.
      { description: 'Black Toner Cartridge', class: 3, unit: 19, max: 100, level: () => -2 },
    ],
    trays: [{ description: 'Tray 1 (A4)', max: 250, level: draining(90, 1) }],
    alerts: [],
  },

  {
    port: 16103,
    name: 'studio',
    site: 'Marsh Lane',
    description: 'Invented ColourPress 900',
    location: 'Marsh Lane, studio',
    serial: 'SIM-900-000045',
    startedAt: started - 86_400_000 * 96,
    pages: counting(58_120, 22),
    supplies: [
      // Two black cartridges, which is normal on a production machine and is
      // the case that catches code assuming one row per colour.
      { description: 'Black Toner Cartridge 1', class: 3, unit: 19, max: 100, level: draining(88, 0.9) },
      { description: 'Black Toner Cartridge 2', class: 3, unit: 19, max: 100, level: draining(12, 0.9, 1) },
      { description: 'Cyan Toner Cartridge', class: 3, unit: 19, max: 100, level: draining(54, 0.5) },
      { description: 'Magenta Toner Cartridge', class: 3, unit: 19, max: 100, level: draining(9, 0.5, 2) },
      { description: 'Yellow Toner Cartridge', class: 3, unit: 19, max: 100, level: draining(77, 0.5) },
      { description: 'Drum Cartridge', class: 3, unit: 19, max: 100, level: draining(41, 0.1) },
    ],
    trays: [
      { description: 'Tray 1 (A4)', max: 1000, level: draining(830, 6) },
      { description: 'Tray 2 (A3)', max: 1000, level: draining(220, 1) },
    ],
    alerts: [{ text: 'Paper jam in the finisher', severity: 3 }],
  },

  {
    port: 16104,
    name: 'workshop',
    site: 'Marsh Lane',
    description: 'Invented LabelMaker 60',
    location: 'Marsh Lane, workshop',
    serial: 'SIM-60-000902',
    startedAt: started - 86_400_000 * 12,
    pages: counting(9_004, 40),
    supplies: [
      // Sheets, not percent. A level of 400 here is four hundred labels, and a
      // reader that assumes percent shows 400%.
      { description: 'Label roll', class: 3, unit: 8, max: 2000, level: draining(430, 20, 0) },
    ],
    trays: [],
    alerts: [{ text: 'Label roll low', severity: 4 }],
  },

  {
    port: 16105,
    name: 'reception',
    site: 'Quay Road',
    description: 'Invented Multifunction 4200 series',
    location: 'Quay Road, reception',
    serial: 'SIM-4200-000118',
    startedAt: started - 86_400_000 * 31,
    pages: counting(77_412, 5),
    supplies: [
      { description: 'Black Toner Cartridge', class: 3, unit: 19, max: 100, level: draining(31, 0.3) },
      { description: 'Waste Toner Container', class: 4, unit: 19, max: 100, level: counting(94, 0.1) },
    ],
    trays: [{ description: 'Tray 1 (A4)', max: 520, level: draining(55, 2) }],
    alerts: [],
  },
];

/** The sixth device: an address with nothing behind it. */
export const SILENT = { port: 16106, name: 'stores', site: 'Quay Road', serial: null };

const running = [];

for (const device of FLEET) {
  running.push(await startPrinter(device, { port: device.port }));
}

console.log(`${running.length} invented printers are answering SNMP on 127.0.0.1:`);
for (const one of running) {
  console.log(`  ${one.port}  ${one.device.name.padEnd(11)} ${one.device.site.padEnd(15)} ${one.device.serial}`);
}
console.log(`  ${SILENT.port}  ${SILENT.name.padEnd(11)} ${SILENT.site.padEnd(15)} nothing is listening here, on purpose`);
console.log('\nEverything above is invented. Stop it with Ctrl-C.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await Promise.all(running.map((one) => one.stop()));
    process.exit(0);
  });
}
