/**
 * ASN.1 BER, the encoding SNMP is written in.
 *
 * Everything on the wire is a triple: a tag saying what this is, a length, and
 * that many bytes. Structures nest by putting more triples inside the bytes of
 * one. That is the whole idea, and the rest is the handful of places it is
 * fiddlier than it sounds:
 *
 *   - **Lengths under 128 are one byte.** Longer ones set the top bit of the
 *     first byte and use the low seven bits to say how many bytes of length
 *     follow. A parser that reads every length as one byte works perfectly
 *     until the first packet with more than 127 bytes in it — which is any walk
 *     of a real device, and never a hand-written test.
 *   - **Integers are signed, two's complement, and minimally encoded.** A
 *     counter of 128 is `00 80`, not `80`, because `80` is −128. Leaving the
 *     leading zero out gives a page count that goes negative above 127.
 *   - **Object identifiers are packed.** The first two arcs are folded into one
 *     byte, and every arc after that is base-128 with a continuation bit. An
 *     OID is the one part of this that cannot be guessed at.
 *
 * Written by hand rather than taken from a library, because the encoding IS the
 * subject here: a service that reads printers over SNMP and cannot say what its
 * packets look like is a service nobody can debug at three in the morning.
 * `npm run check:snmp` puts it against a real agent, so it is not merely
 * agreeing with itself.
 */

/** The tags this needs. SNMP uses a few of its own beyond the universal ones. */
export const TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,

  // Application tags, from RFC 2578. A gauge and a counter are both unsigned
  // 32-bit and mean different things: a counter only ever goes up and wraps, a
  // gauge goes up and down. Reading a gauge as a counter turns "the toner went
  // down" into "the toner wrapped around".
  IP_ADDRESS: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIME_TICKS: 0x43,
  OPAQUE: 0x44,
  COUNTER64: 0x46,

  // What an agent says instead of a value when it has none. These are not
  // errors and must not be treated as one: walking a table ends with
  // END_OF_MIB_VIEW, and a device that lacks one optional object answers
  // NO_SUCH_OBJECT for it and everything else normally.
  NO_SUCH_OBJECT: 0x80,
  NO_SUCH_INSTANCE: 0x81,
  END_OF_MIB_VIEW: 0x82,

  GET: 0xa0,
  GET_NEXT: 0xa1,
  RESPONSE: 0xa2,
  GET_BULK: 0xa5,
};

// ------------------------------------------------------------------- writing

export function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);

  const bytes = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>>= 8;
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function wrap(tag, body) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export function encodeInteger(value, tag = TAG.INTEGER) {
  const bytes = [];
  let rest = Math.trunc(value);

  // Two's complement, minimally encoded: keep taking the low byte until what
  // remains is only sign bits AND the top bit of the last byte written agrees
  // with the sign. That second condition is the one people leave out.
  do {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  } while (!((rest === 0 && (bytes[0] & 0x80) === 0) || (rest === -1 && (bytes[0] & 0x80) !== 0)));

  return wrap(tag, Buffer.from(bytes));
}

/** An unsigned 32-bit value: a counter, a gauge, or a number of ticks. */
export function encodeUnsigned(value, tag) {
  const bytes = [];
  let rest = Math.trunc(value) >>> 0;

  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);

  // A leading zero when the top bit is set, so 3_000_000_000 is not read back
  // as a negative number by anything that decodes it as signed.
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0);

  return wrap(tag, Buffer.from(bytes));
}

export function encodeString(text) {
  return wrap(TAG.OCTET_STRING, Buffer.from(text, 'latin1'));
}

export function encodeNull(tag = TAG.NULL) {
  return Buffer.from([tag, 0x00]);
}

/**
 * An OID, packed.
 *
 * `1.3.6.1.2.1` becomes `2b 06 01 02 01`: the first two arcs collapse into
 * `40 * a + b`, and each arc after that is base-128, seven bits per byte, with
 * the top bit set on every byte but the last.
 */
export function encodeOid(oid) {
  const arcs = oid.split('.').map(Number);
  if (arcs.length < 2) throw new Error(`not an object identifier: ${oid}`);

  const bytes = [arcs[0] * 40 + arcs[1]];

  for (const arc of arcs.slice(2)) {
    if (arc < 0x80) {
      bytes.push(arc);
      continue;
    }

    const packed = [];
    let rest = arc;
    while (rest > 0) {
      packed.unshift(rest & 0x7f);
      rest >>>= 7;
    }
    for (let at = 0; at < packed.length - 1; at += 1) packed[at] |= 0x80;
    bytes.push(...packed);
  }

  return wrap(TAG.OID, Buffer.from(bytes));
}

// ------------------------------------------------------------------- reading

/**
 * Reads one triple, and says where the next one starts.
 *
 * `at` is carried rather than the buffer being sliced, because a walk of a
 * printer's supply table is a few hundred nested values and slicing at every
 * level copies the packet once per element.
 */
export function read(buffer, at = 0) {
  if (at >= buffer.length) throw new Error('the packet ended in the middle of a value');

  const tag = buffer[at];
  let cursor = at + 1;

  if (cursor >= buffer.length) throw new Error('the packet ended before its length');

  let length = buffer[cursor];
  cursor += 1;

  if ((length & 0x80) !== 0) {
    const count = length & 0x7f;
    if (count === 0) throw new Error('indefinite lengths are not used in SNMP');
    if (count > 4) throw new Error('a length that long is not a packet this reads');
    if (cursor + count > buffer.length) throw new Error('the packet ended inside its own length');

    length = 0;
    for (let step = 0; step < count; step += 1) {
      length = length * 256 + buffer[cursor];
      cursor += 1;
    }
  }

  const end = cursor + length;
  if (end > buffer.length) {
    throw new Error(`this value says it is ${length} bytes and the packet has ${buffer.length - cursor}`);
  }

  return { tag, from: cursor, end, body: buffer.subarray(cursor, end), next: end };
}

export function readInteger(body) {
  if (body.length === 0) return 0;

  let value = (body[0] & 0x80) !== 0 ? -1 : 0;
  for (const byte of body) value = value * 256 + byte;

  return value;
}

export function readUnsigned(body) {
  let value = 0;
  // Times, not shifts. A Counter32 of 3_000_000_000 shifted left in JavaScript
  // goes through a 32-bit signed conversion and comes back negative — which on
  // a printer means a page count that suddenly reads as minus a billion.
  for (const byte of body) value = value * 256 + byte;
  return value;
}

export function readOid(body) {
  if (body.length === 0) return '';

  const arcs = [Math.floor(body[0] / 40), body[0] % 40];

  let arc = 0;
  for (const byte of body.subarray(1)) {
    arc = arc * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(arc);
      arc = 0;
    }
  }

  return arcs.join('.');
}

/**
 * A value, as whatever its tag says it is.
 *
 * The three "no value" tags come back as `null` with a reason rather than as an
 * exception, because a device answering NO_SUCH_OBJECT for one optional field
 * is behaving correctly and the rest of the reply is still good.
 */
export function readValue(tag, body) {
  switch (tag) {
    case TAG.INTEGER:
      return { value: readInteger(body), kind: 'integer' };
    case TAG.COUNTER32:
      return { value: readUnsigned(body), kind: 'counter' };
    case TAG.GAUGE32:
      return { value: readUnsigned(body), kind: 'gauge' };
    case TAG.TIME_TICKS:
      return { value: readUnsigned(body), kind: 'ticks' };
    case TAG.COUNTER64:
      return { value: readUnsigned(body), kind: 'counter64' };
    case TAG.OCTET_STRING:
      return { value: readOctetString(body), kind: 'string' };
    case TAG.OID:
      return { value: readOid(body), kind: 'oid' };
    case TAG.IP_ADDRESS:
      return { value: [...body].join('.'), kind: 'address' };
    case TAG.NULL:
      return { value: null, kind: 'null' };
    case TAG.NO_SUCH_OBJECT:
      return { value: null, kind: 'no such object' };
    case TAG.NO_SUCH_INSTANCE:
      return { value: null, kind: 'no such instance' };
    case TAG.END_OF_MIB_VIEW:
      return { value: null, kind: 'end of the tree' };
    default:
      return { value: body.toString('hex'), kind: `unknown tag 0x${tag.toString(16)}` };
  }
}

/**
 * An octet string, which is usually text and sometimes is not.
 *
 * A serial number is text. A MAC address is six bytes that are not. Printers
 * return both from the same kind of field, so bytes outside the printable range
 * mean this is not a string and it comes back as hex — which is readable, where
 * the alternative is a row of replacement characters that looks like corruption.
 */
export function readOctetString(body) {
  const printable = [...body].every((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127));
  return printable ? body.toString('latin1') : body.toString('hex');
}
