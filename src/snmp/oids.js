/**
 * The objects this reads, and where each one is defined.
 *
 * All of them come from open IETF standards — the Printer MIB (RFC 3805), the
 * Host Resources MIB (RFC 2790) and SNMPv2-MIB (RFC 3418). Nothing here is a
 * vendor's private branch, and that is the point of the whole design: a fleet
 * is never one make, and a collector written against one manufacturer's own
 * numbers is a collector that has to be rewritten for the next purchase.
 *
 * It is also why this project can exist in the open at all. These numbers are a
 * published standard anybody may implement; a vendor's private MIB, or their
 * admin web page, is neither.
 *
 * The service this was rebuilt from read consumable levels by measuring **the
 * width of a coloured bar** on the device's own web page. `prtMarkerSupplies`
 * below is the device saying the number itself.
 */

/** RFC 3418 — what any agent at all will answer. */
export const SYSTEM = {
  description: '1.3.6.1.2.1.1.1.0',
  uptime: '1.3.6.1.2.1.1.3.0',
  name: '1.3.6.1.2.1.1.5.0',
  location: '1.3.6.1.2.1.1.6.0',
};

/** RFC 2790 — the device as a piece of hardware. */
export const HOST = {
  /**
   * The serial number, which is what a meter reading is filed against.
   *
   * An address is where a device is today; a serial is which device it is. A
   * fleet that keys on the address loses its history the first time somebody
   * moves a printer between floors, and merges two devices' counters the first
   * time an address is reused.
   */
  serial: '1.3.6.1.2.1.25.3.2.1.3',
};

/**
 * RFC 3805 — the printer itself.
 *
 * The tables are indexed by device and then by row, so a walk of each root
 * gives one entry per marker, per supply, per input tray. A machine with two
 * cartridges of the same colour has two rows, and code that assumes one row per
 * colour reports half the toner it has.
 */
export const PRINTER = {
  /** The description of each marking subsystem: a name for the engine. */
  markerDescription: '1.3.6.1.2.1.43.11.1.1.6',

  /** Pages this marker has ever printed. A counter: it only goes up. */
  markerLifeCount: '1.3.6.1.2.1.43.10.2.1.4',

  /** What each supply is, in words the device chose: "Black Toner Cartridge". */
  supplyDescription: '1.3.6.1.2.1.43.11.1.1.6',

  /**
   * How much is left, in the units below — NOT a percentage.
   *
   * Two negative values are not quantities and must never be shown as one:
   * −1 means "the device cannot tell", −2 means "there is some but it does not
   * measure". Divided by the maximum, they produce a confident number that is
   * a lie, which is exactly the sort of thing that gets a toner ordered for a
   * machine that does not need one.
   */
  supplyLevel: '1.3.6.1.2.1.43.11.1.1.9',

  /** What "full" is for that supply, so a level means something. */
  supplyMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',

  /** The units the two numbers above are in. See UNITS. */
  supplyUnit: '1.3.6.1.2.1.43.11.1.1.7',

  /** Whether it is a consumable being used up or a receptacle filling up. */
  supplyClass: '1.3.6.1.2.1.43.11.1.1.4',

  /** Paper trays: what is in them, and how much. */
  inputDescription: '1.3.6.1.2.1.43.8.2.1.18',
  inputLevel: '1.3.6.1.2.1.43.8.2.1.10',
  inputMaxCapacity: '1.3.6.1.2.1.43.8.2.1.9',

  /** Anything the device is complaining about. */
  alertDescription: '1.3.6.1.2.1.43.18.1.1.8',
  alertSeverity: '1.3.6.1.2.1.43.18.1.1.2',
};

/** RFC 3805, prtMarkerSuppliesSupplyUnitTC. Only the ones printers use. */
export const UNITS = {
  3: 'ten-thousandths of an inch',
  4: 'micrometres',
  7: 'impressions',
  8: 'sheets',
  11: 'hours',
  12: 'thousandths of an ounce',
  13: 'tenths of grams',
  14: 'hundredths of fluid ounces',
  15: 'tenths of millilitres',
  16: 'feet',
  17: 'metres',
  18: 'items',
  19: 'percent',
};

/** prtMarkerSuppliesClassTC: a cartridge empties, a waste bottle fills. */
export const SUPPLY_CLASS = {
  1: 'other',
  3: 'consumed',
  4: 'filled',
};

/** prtAlertSeverityLevel. */
export const SEVERITY = {
  1: 'other',
  3: 'critical',
  4: 'warning',
  5: 'warning, taken care of',
};

/** What a negative level means, in words, per RFC 3805. */
export const UNMEASURED = {
  '-1': 'the device cannot tell',
  '-2': 'there is some, but the device does not measure it',
  '-3': 'the device says it is at some unknown level',
};
