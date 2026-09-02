import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TAG,
  encodeInteger,
  encodeLength,
  encodeOid,
  encodeUnsigned,
  read,
  readInteger,
  readOid,
  readOctetString,
  readUnsigned,
} from '../src/snmp/ber.js';

/**
 * Against bytes written down here, not against this file's own encoder.
 *
 * A codec tested only by encoding and decoding its own output agrees with
 * itself about everything, including whatever it gets wrong. So the values
 * below are the ones the standard specifies, written as hex, and checked in
 * both directions. `npm run check:snmp` does the other half of this against an
 * agent nobody here wrote.
 */

const hex = (buffer) => buffer.toString('hex');

describe('lengths', () => {
  it('writes a short length in one byte', () => {
    assert.equal(hex(encodeLength(5)), '05');
    assert.equal(hex(encodeLength(127)), '7f');
  });

  it('writes a long one with a count first', () => {
    // 128 is the first length that does not fit: the top bit means "the low
    // seven bits are how many bytes of length follow".
    assert.equal(hex(encodeLength(128)), '8180');
    assert.equal(hex(encodeLength(300)), '82012c');
  });

  it('reads a length spread over two bytes', () => {
    // A value of 200 bytes. A reader taking every length as one byte reads
    // this as a value of length 0x81 = 129 and loses the end of every real
    // reply.
    const body = Buffer.alloc(200, 0x41);
    const packet = Buffer.concat([Buffer.from([TAG.OCTET_STRING]), encodeLength(200), body]);

    const value = read(packet);
    assert.equal(value.body.length, 200);
    assert.equal(readOctetString(value.body), 'A'.repeat(200));
  });

  it('refuses a length that runs past the end of the packet', () => {
    // Half an answer, which is what a truncated UDP datagram is. It must say
    // so rather than read whatever memory follows.
    const packet = Buffer.from([TAG.OCTET_STRING, 0x40, 0x41, 0x42]);
    assert.throws(() => read(packet), /says it is 64 bytes/);
  });
});

describe('integers', () => {
  it('writes them as the standard says, minimally and signed', () => {
    assert.equal(hex(encodeInteger(0)), '020100');
    assert.equal(hex(encodeInteger(127)), '02017f');
    // The one people get wrong. 0x80 alone is -128, so a positive 128 needs a
    // leading zero — without it, a page count above 127 goes negative.
    assert.equal(hex(encodeInteger(128)), '02020080');
    assert.equal(hex(encodeInteger(-1)), '0201ff');
    assert.equal(hex(encodeInteger(-128)), '020180');
    assert.equal(hex(encodeInteger(-129)), '0202ff7f');
  });

  it('reads back what it wrote, over the range that matters', () => {
    for (const value of [0, 1, 127, 128, 255, 256, 65_535, 16_777_216, -1, -128, -129, -70_000]) {
      const written = encodeInteger(value);
      assert.equal(readInteger(read(written).body), value, `${value} did not survive`);
    }
  });

  it('reads an unsigned counter bigger than a signed 32-bit integer', () => {
    // A page counter on a production machine passes two billion, and a decoder
    // that shifts instead of multiplying wraps it into a negative number.
    const written = encodeUnsigned(3_000_000_000, TAG.COUNTER32);
    assert.equal(readUnsigned(read(written).body), 3_000_000_000);
  });

  it('never writes an unsigned value that reads back as negative', () => {
    const written = encodeUnsigned(4_000_000_000, TAG.GAUGE32);
    assert.ok(readInteger(read(written).body) > 0, 'a leading zero is missing');
  });
});

describe('object identifiers', () => {
  it('packs the first two arcs into one byte', () => {
    // 1.3 becomes 40*1 + 3 = 43 = 0x2b. Every OID in SNMP starts this way.
    assert.equal(hex(encodeOid('1.3.6.1.2.1')), '06052b06010201');
  });

  it('writes an arc over 127 across several bytes', () => {
    // sysUpTime lives at .43 in one place and a printer's tables at 43 —
    // fine — but an enterprise number is routinely five digits, and each arc
    // is base-128 with a continuation bit on all but the last byte.
    assert.equal(hex(encodeOid('1.3.6.1.4.1.9999')), '06072b06010401ce0f');
  });

  it('reads back every OID this project asks for', () => {
    for (const oid of [
      '1.3.6.1.2.1.1.1.0',
      '1.3.6.1.2.1.43.11.1.1.9.1.10',
      '1.3.6.1.2.1.25.3.2.1.3.1',
      '1.3.6.1.4.1.9999.128.65536',
    ]) {
      assert.equal(readOid(read(encodeOid(oid)).body), oid);
    }
  });
});

describe('octet strings', () => {
  it('gives text back as text', () => {
    assert.equal(readOctetString(Buffer.from('SIM-4200-000117', 'latin1')), 'SIM-4200-000117');
  });

  it('gives bytes that are not text back as hex rather than as rubble', () => {
    // A serial number is text; a MAC address is six bytes that are not, and
    // printers return both from the same kind of field. Hex is readable where
    // the alternative is a row of replacement characters that looks like
    // corruption.
    assert.equal(readOctetString(Buffer.from([0x00, 0x1b, 0x21, 0xff, 0x0e, 0x9a])), '001b21ff0e9a');
  });
});
