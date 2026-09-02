/**
 * Finding printers on a network you administer.
 *
 * **Private address ranges only, unless somebody says otherwise in writing.**
 * Sweeping a range for SNMP is ordinary network management on your own network
 * and is something else entirely on somebody else's, so the default refuses
 * anything outside RFC 1918 and the caller has to pass `allowPublic` to get
 * past it. That is a speed bump rather than a wall — the point is that nobody
 * scans the internet by leaving a field blank.
 *
 * It asks each address one question: sysDescr, with a short timeout and no
 * retry. A device that is there answers in milliseconds; an address with
 * nothing behind it costs the timeout and no more. There is nothing here that
 * probes for a version, guesses at a community string, or tries a list of them:
 * that is not discovery, it is a scanner, and this is not one.
 */

import { snmp } from '../snmp/client.js';
import { SYSTEM } from '../snmp/oids.js';

/** The ranges a network somebody administers is on. RFC 1918, plus loopback. */
const PRIVATE = [
  { from: ip('10.0.0.0'), to: ip('10.255.255.255') },
  { from: ip('172.16.0.0'), to: ip('172.31.255.255') },
  { from: ip('192.168.0.0'), to: ip('192.168.255.255') },
  { from: ip('127.0.0.0'), to: ip('127.255.255.255') },
  { from: ip('169.254.0.0'), to: ip('169.254.255.255') },
];

export function ip(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((one) => !Number.isInteger(one) || one < 0 || one > 255)) {
    throw new Error(`not an address: ${address}`);
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function address(number) {
  return [(number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255].join('.');
}

export function isPrivate(one) {
  const value = ip(one);
  return PRIVATE.some((range) => value >= range.from && value <= range.to);
}

/**
 * Turns `192.168.1.0/24` into the addresses inside it.
 *
 * The network and broadcast addresses are left out, because nothing answers on
 * them and asking wastes two timeouts per subnet.
 *
 * **Nothing wider than /16.** A /16 is sixty-five thousand addresses and
 * already several minutes; a mistyped /8 is sixteen million and would still be
 * running tomorrow. The bound is on the prefix and nowhere else — there was a
 * second guard on the count of addresses, and with a floor of /16 it could
 * never fire. An unreachable guard is worse than none: it reads as protection
 * and is not, and nothing can test it.
 */
export function addressesIn(range) {
  const [base, bits] = range.split('/');
  const prefix = Number(bits);

  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 32) {
    throw new Error(`${range}: the prefix must be between /16 and /32, and a /16 is already 65534 addresses`);
  }

  const size = 2 ** (32 - prefix);
  const network = (ip(base) & (0xffffffff << (32 - prefix))) >>> 0;
  const found = [];

  // A /32 is one host and a /31 is a point-to-point link: both have no network
  // or broadcast address to skip, and skipping them would leave nothing.
  const first = size > 2 ? 1 : 0;
  const last = size > 2 ? size - 1 : size;

  for (let step = first; step < last; step += 1) found.push(address(network + step));

  return found;
}

/**
 * Asks each address whether something is there.
 *
 * A few at a time, because a few hundred simultaneous UDP requests from one
 * process is a burst a switch will drop — and the drops look exactly like
 * addresses with nothing behind them, which is the one thing this must not get
 * wrong.
 */
export async function discover({
  range,
  community = 'public',
  timeoutMs = 500,
  atATime = 32,
  allowPublic = false,
  log = () => {},
}) {
  const addresses = addressesIn(range);

  if (!allowPublic) {
    const outside = addresses.find((one) => !isPrivate(one));
    if (outside) {
      const refused = new Error(
        `${range} includes ${outside}, which is not a private address. ` +
          'Sweeping a network you do not administer is not something this does by default.'
      );
      refused.code = 'NOT_PRIVATE';
      throw refused;
    }
  }

  log('info', 'sweeping', { range, addresses: addresses.length, at_a_time: atATime });

  const queue = [...addresses];
  const found = [];

  const workers = Array.from({ length: Math.min(atATime, queue.length) }, async () => {
    for (;;) {
      const host = queue.shift();
      if (!host) return;

      // One question, one timeout, no retry. Discovery is a sweep, not a
      // conversation; anything that did not answer can be asked again by name.
      const device = snmp({ host, community, timeoutMs, retries: 0 });

      try {
        const [said] = await device.get([SYSTEM.description]);
        if (said?.value) found.push({ host, description: said.value });
      } catch {
        /* Nothing there, or it does not answer to this community string. */
      }
    }
  });

  await Promise.all(workers);

  found.sort((a, b) => ip(a.host) - ip(b.host));
  log('info', 'sweep finished', { range, found: found.length });

  return found;
}
