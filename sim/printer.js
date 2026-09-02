/**
 * A printer that answers SNMP, so this project runs with no hardware.
 *
 * It is a real agent, not a stub: it listens on UDP, decodes the request with
 * the same BER reader the client uses, and answers get and get-next with a
 * lexicographically ordered MIB. A collector talking to it is doing everything
 * it would do to a device on a desk.
 *
 * That shared codec is also its limit, and the limit is worth naming. A
 * simulator built from the same encoder as the client will agree with the
 * client about anything they both get wrong — so `npm run check:snmp` puts the
 * client against a real `snmpd`, which was written by somebody else and has no
 * interest in agreeing with it. This is for running and for tests; that is for
 * being right.
 *
 * The devices below are invented, and deliberately awkward in the ways real
 * ones are: one that cannot measure its toner, one whose waste bottle fills
 * rather than empties, one that is simply switched off.
 */

import dgram from 'node:dgram';

import {
  TAG,
  encodeInteger,
  encodeOid,
  encodeString,
  encodeUnsigned,
  read,
  readInteger,
  readOid,
  wrap,
} from '../src/snmp/ber.js';

import { HOST, PRINTER, SYSTEM } from '../src/snmp/oids.js';

/**
 * An OID sorts by its arcs as numbers, never as a string.
 *
 * `1.3.6.1.2.1.43.11.1.1.9.1.10` comes after `…9.1.9`, and comparing the two as
 * text puts "10" before "9". A get-next walk over a string-sorted table
 * revisits rows and either loops or stops early — which is the sort of thing a
 * simulator with three tidy rows never shows and a device with twelve does.
 */
export function compareOids(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);

  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const one = left[at] ?? -1;
    const other = right[at] ?? -1;
    if (one !== other) return one - other;
  }

  return 0;
}

/**
 * Builds the objects one device answers with.
 *
 * `pagesPrinted` and the supply levels are read at answer time rather than
 * baked in, so a running fleet drifts the way a real one does and the history
 * the collector keeps is a history of something.
 */
export function mibFor(device) {
  const objects = new Map();

  const put = (oid, tag, value) => objects.set(oid, { tag, value });

  put(SYSTEM.description, TAG.OCTET_STRING, device.description);
  put(SYSTEM.uptime, TAG.TIME_TICKS, () => Math.floor((Date.now() - device.startedAt) / 10));
  put(SYSTEM.name, TAG.OCTET_STRING, device.name);
  put(SYSTEM.location, TAG.OCTET_STRING, device.location);

  put(`${HOST.serial}.1`, TAG.OCTET_STRING, device.serial);

  // One marker. A device with a second engine would have `.1.2` as well, which
  // is what the collector's "sum the markers" is for.
  put(`${PRINTER.markerLifeCount}.1.1`, TAG.COUNTER32, () => device.pages());

  device.supplies.forEach((supply, at) => {
    const row = `1.${at + 1}`;
    put(`${PRINTER.supplyDescription}.${row}`, TAG.OCTET_STRING, supply.description);
    put(`${PRINTER.supplyClass}.${row}`, TAG.INTEGER, supply.class);
    put(`${PRINTER.supplyUnit}.${row}`, TAG.INTEGER, supply.unit);
    put(`${PRINTER.supplyMaxCapacity}.${row}`, TAG.INTEGER, supply.max);
    put(`${PRINTER.supplyLevel}.${row}`, TAG.INTEGER, () => supply.level());
  });

  device.trays.forEach((tray, at) => {
    const row = `1.${at + 1}`;
    put(`${PRINTER.inputDescription}.${row}`, TAG.OCTET_STRING, tray.description);
    put(`${PRINTER.inputMaxCapacity}.${row}`, TAG.INTEGER, tray.max);
    put(`${PRINTER.inputLevel}.${row}`, TAG.INTEGER, () => tray.level());
  });

  device.alerts.forEach((alert, at) => {
    const row = `1.${at + 1}`;
    put(`${PRINTER.alertDescription}.${row}`, TAG.OCTET_STRING, alert.text);
    put(`${PRINTER.alertSeverity}.${row}`, TAG.INTEGER, alert.severity);
  });

  return objects;
}

function encodeValue(tag, value) {
  const settled = typeof value === 'function' ? value() : value;

  switch (tag) {
    case TAG.OCTET_STRING:
      return encodeString(String(settled));
    case TAG.INTEGER:
      return encodeInteger(settled);
    case TAG.COUNTER32:
    case TAG.GAUGE32:
    case TAG.TIME_TICKS:
      return encodeUnsigned(settled, tag);
    default:
      return encodeString(String(settled));
  }
}

/**
 * Starts one device.
 *
 * Bound to 127.0.0.1 by default. A simulator that answers on every interface is
 * a device on somebody's network pretending to be a printer, which is not a
 * thing to do by accident.
 */
export function startPrinter(device, { port, host = '127.0.0.1', community = 'public' } = {}) {
  const objects = mibFor(device);
  const ordered = [...objects.keys()].sort(compareOids);

  const socket = dgram.createSocket('udp4');

  socket.on('message', (packet, from) => {
    let answer;
    try {
      answer = replyTo(packet, { objects, ordered, community });
    } catch {
      // A packet this cannot read gets no reply, which is what a real agent
      // does. Answering an error to something that was not a request for us is
      // how a network scanner learns there is something here.
      return;
    }

    if (answer) socket.send(answer, from.port, from.address);
  });

  return new Promise((ready) => {
    socket.bind(port, host, () => ready({
      port: socket.address().port,
      device,
      stop: () => new Promise((done) => socket.close(done)),
    }));
  });
}

function replyTo(packet, { objects, ordered, community }) {
  const envelope = read(packet);
  const version = read(packet, envelope.from);
  const said = read(packet, version.next);
  const pdu = read(packet, said.next);

  // A wrong community string is answered with silence, exactly as a device
  // does. An error reply would confirm that something is listening.
  if (said.body.toString('latin1') !== community) return null;
  if (pdu.tag !== TAG.GET && pdu.tag !== TAG.GET_NEXT) return null;

  const id = read(packet, pdu.from);
  const nonRepeaters = read(packet, id.next);
  const maxRepetitions = read(packet, nonRepeaters.next);
  const bindings = read(packet, maxRepetitions.next);

  const answers = [];
  let at = bindings.from;

  while (at < bindings.end) {
    const pair = read(packet, at);
    const oid = read(packet, pair.from);
    const asked = readOid(oid.body);

    if (pdu.tag === TAG.GET) {
      const held = objects.get(asked);
      answers.push(
        held
          ? Buffer.concat([encodeOid(asked), encodeValue(held.tag, held.value)])
          : Buffer.concat([encodeOid(asked), Buffer.from([TAG.NO_SUCH_OBJECT, 0])])
      );
    } else {
      const next = ordered.find((one) => compareOids(one, asked) > 0);
      answers.push(
        next
          ? Buffer.concat([encodeOid(next), encodeValue(objects.get(next).tag, objects.get(next).value)])
          : Buffer.concat([encodeOid(asked), Buffer.from([TAG.END_OF_MIB_VIEW, 0])])
      );
    }

    at = pair.next;
  }

  return wrap(
    TAG.SEQUENCE,
    Buffer.concat([
      encodeInteger(1),
      encodeString(community),
      wrap(
        TAG.RESPONSE,
        Buffer.concat([
          encodeInteger(readInteger(id.body)),
          encodeInteger(0),
          encodeInteger(0),
          wrap(TAG.SEQUENCE, Buffer.concat(answers.map((one) => wrap(TAG.SEQUENCE, one)))),
        ])
      ),
    ])
  );
}
