/**
 * One device, read once, turned into something comparable across makes.
 *
 * The hard part is not fetching the numbers. It is that two machines report the
 * same fact differently and both are correct: one gives toner as a percentage,
 * the next in sheets remaining, and a third says it cannot tell. A collector
 * that treats all three as percentages produces a fleet report in which one
 * device is at 400% and another has run out.
 *
 * So every level comes back with **the unit it was given in**, and a percentage
 * only when one can honestly be worked out. `null` is a real answer here and it
 * has a reason attached.
 */

import { snmp } from '../snmp/client.js';
import { HOST, PRINTER, SEVERITY, SUPPLY_CLASS, SYSTEM, UNITS, UNMEASURED } from '../snmp/oids.js';

/**
 * Reads everything a meter report needs from one address.
 *
 * A device that does not answer is a result, not an exception: `reachable:
 * false` with what was tried. A fleet always has one machine switched off, and
 * a collector that throws on it stops before reaching the rest — which is how
 * one unplugged printer costs a month of readings for a whole site.
 */
export async function readDevice({ host, port = 161, community = 'public', timeoutMs = 2000, retries = 2 }) {
  const at = new Date().toISOString();
  const device = snmp({ host, port, community, timeoutMs, retries });

  let identity;
  try {
    identity = await device.get([SYSTEM.description, SYSTEM.name, SYSTEM.location, SYSTEM.uptime]);
  } catch (error) {
    return {
      host,
      port,
      at,
      reachable: false,
      why:
        error.code === 'NO_ANSWER'
          ? 'nothing answered, or it does not accept this community string'
          : error.message,
    };
  }

  const [description, name, location, uptime] = identity.map((one) => one.value);

  // Read in parallel: five walks one after another over a slow device is five
  // round trips of latency for no reason, and a fleet of two hundred turns
  // that into an hour.
  const [serials, pages, supplies, trays, alerts] = await Promise.all([
    device.walk(HOST.serial),
    device.walk(PRINTER.markerLifeCount),
    readSupplies(device),
    readTrays(device),
    readAlerts(device),
  ]);

  return {
    host,
    port,
    at,
    reachable: true,

    /**
     * The serial is what a reading is filed against, not the address.
     *
     * An address is where a device is today; a serial is which device it is. A
     * history keyed on the address is lost the first time a printer moves
     * between floors, and merges two machines' counters the first time an
     * address is reused.
     */
    serial: firstText(serials) ?? null,
    model: description ?? null,
    name: name ?? null,
    location: location ?? null,
    upSeconds: typeof uptime === 'number' ? Math.floor(uptime / 100) : null,

    /**
     * Every marker added together.
     *
     * A machine with two print engines has two rows, and reading only the first
     * reports half the pages it has printed — which on a production press is a
     * bill that is half what it should be.
     */
    pages: pages.length === 0 ? null : pages.reduce((total, one) => total + (one.value ?? 0), 0),
    markers: pages.length,

    supplies,
    trays,
    alerts,
  };
}

async function readSupplies(device) {
  const [descriptions, levels, maxima, units, classes] = await Promise.all([
    device.walk(PRINTER.supplyDescription),
    device.walk(PRINTER.supplyLevel),
    device.walk(PRINTER.supplyMaxCapacity),
    device.walk(PRINTER.supplyUnit),
    device.walk(PRINTER.supplyClass),
  ]);

  const byRow = new Map();
  const row = (oid, root) => oid.slice(root.length + 1);

  for (const one of descriptions) byRow.set(row(one.oid, PRINTER.supplyDescription), { description: one.value });
  for (const one of levels) atRow(byRow, row(one.oid, PRINTER.supplyLevel)).level = one.value;
  for (const one of maxima) atRow(byRow, row(one.oid, PRINTER.supplyMaxCapacity)).max = one.value;
  for (const one of units) atRow(byRow, row(one.oid, PRINTER.supplyUnit)).unit = one.value;
  for (const one of classes) atRow(byRow, row(one.oid, PRINTER.supplyClass)).kind = one.value;

  return [...byRow.entries()].map(([index, supply]) => describeSupply(index, supply));
}

/**
 * A supply, with a percentage only where one is honest.
 *
 * Three things stop it being honest, and all three are in the sample fleet
 * because all three are in every real one:
 *
 *   - **A negative level is not a quantity.** RFC 3805 uses −1, −2 and −3 to
 *     say the device cannot measure. Dividing one by the maximum gives a
 *     confident number that is a lie, and it is the sort that gets a cartridge
 *     ordered for a machine that does not need one.
 *   - **A receptacle fills.** A waste bottle at 90 is nearly full and nearly
 *     unusable, where a cartridge at 90 is nearly new. "How much is left" has
 *     the opposite meaning depending on the class, so the answer says which.
 *   - **A maximum of zero or less** means the device declines to say what full
 *     is. There is nothing to divide by.
 */
export function describeSupply(index, supply) {
  const { description = null, level = null, max = null, unit = null, kind = null } = supply;

  const said = {
    index,
    description,
    level,
    max,
    unit: UNITS[unit] ?? (unit === null ? null : `unit ${unit}`),
    kind: SUPPLY_CLASS[kind] ?? 'other',
    percent: null,
    remaining: null,
    why: null,
  };

  if (level === null) {
    said.why = 'the device did not report a level';
    return said;
  }

  if (level < 0) {
    said.level = null;
    said.why = UNMEASURED[String(level)] ?? 'the device reported a level that is not a quantity';
    return said;
  }

  if (max === null || max <= 0) {
    said.why = 'the device did not say what full is, so there is nothing to compare against';
    return said;
  }

  const filled = Math.round((level / max) * 100);

  // A receptacle fills up. Reporting "10% remaining" for a waste bottle that is
  // 90% full is the right number attached to the wrong sentence.
  said.percent = filled;
  said.remaining = said.kind === 'filled' ? 100 - filled : filled;
  said.why =
    said.kind === 'filled'
      ? 'this fills up rather than empties, so the figure is how full it is'
      : null;

  return said;
}

async function readTrays(device) {
  const [descriptions, levels, maxima] = await Promise.all([
    device.walk(PRINTER.inputDescription),
    device.walk(PRINTER.inputLevel),
    device.walk(PRINTER.inputMaxCapacity),
  ]);

  const byRow = new Map();
  const row = (oid, root) => oid.slice(root.length + 1);

  for (const one of descriptions) byRow.set(row(one.oid, PRINTER.inputDescription), { description: one.value });
  for (const one of levels) atRow(byRow, row(one.oid, PRINTER.inputLevel)).level = one.value;
  for (const one of maxima) atRow(byRow, row(one.oid, PRINTER.inputMaxCapacity)).max = one.value;

  return [...byRow.entries()].map(([index, tray]) => ({
    index,
    description: tray.description ?? null,
    sheets: typeof tray.level === 'number' && tray.level >= 0 ? tray.level : null,
    max: typeof tray.max === 'number' && tray.max > 0 ? tray.max : null,
    empty: tray.level === 0,
    why: typeof tray.level === 'number' && tray.level < 0 ? (UNMEASURED[String(tray.level)] ?? null) : null,
  }));
}

async function readAlerts(device) {
  const [descriptions, severities] = await Promise.all([
    device.walk(PRINTER.alertDescription),
    device.walk(PRINTER.alertSeverity),
  ]);

  const byRow = new Map();
  const row = (oid, root) => oid.slice(root.length + 1);

  for (const one of descriptions) byRow.set(row(one.oid, PRINTER.alertDescription), { text: one.value });
  for (const one of severities) atRow(byRow, row(one.oid, PRINTER.alertSeverity)).severity = one.value;

  return [...byRow.entries()].map(([index, alert]) => ({
    index,
    text: alert.text ?? null,
    severity: SEVERITY[alert.severity] ?? 'other',
    serious: alert.severity === 3,
  }));
}

function atRow(map, index) {
  if (!map.has(index)) map.set(index, {});
  return map.get(index);
}

/** The first row that looks like text somebody wrote, not an empty string. */
function firstText(rows) {
  return rows.map((one) => one.value).find((one) => typeof one === 'string' && one.trim().length > 0);
}
