#!/usr/bin/env node
/**
 * The SNMP codec, against an agent somebody else wrote.
 *
 *     npm run check:snmp
 *
 * This is the check that keeps the rest of the project honest, and it exists
 * because of one specific danger: the simulator in `sim/` is built on the same
 * BER encoder the client decodes with. Anything they both get wrong they will
 * agree about — a length field read as one byte, an OID sorted as text, a
 * Counter32 shifted instead of multiplied. Every test would be green and the
 * first real device would be unreadable.
 *
 * So this talks to `net-snmp`, which has been in the field for twenty-five
 * years and was written by people with no interest in agreeing with it:
 *
 *     docker run -d --rm --name snmp-probe -p 16200:161/udp polinux/snmpd
 *     npm run check:snmp
 *     docker stop snmp-probe
 *
 * It asks for eight objects at once and walks a table of more than nine rows,
 * both on purpose. Eight objects put the reply's outer length over 127 bytes,
 * which is where a length read as a single byte stops working; ten rows are
 * where an OID sorted as a string stops matching one sorted as numbers. A tidy
 * three-row table exercises neither.
 *
 * With nothing to talk to it says so and exits 2 — a check that could not run
 * is not a check that failed, and treating them alike is how a suite gets its
 * red ignored.
 */

import { snmp } from '../src/snmp/client.js';

const HOST = process.env.SNMP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SNMP_PORT ?? 16200);

let failures = 0;

function expect(what, condition, detail) {
  if (condition) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}`);
    if (detail !== undefined) console.log(`        ${detail}`);
  }
}

const agent = snmp({ host: HOST, port: PORT, timeoutMs: 3000, retries: 1 });

console.log(`Putting the codec against a real agent at ${HOST}:${PORT}\n`);

if (!(await agent.reachable())) {
  console.log('Nothing is answering there, so this check did not run.\n');
  console.log('  docker run -d --rm --name snmp-probe -p 16200:161/udp polinux/snmpd');
  console.log('  npm run check:snmp');
  console.log('  docker stop snmp-probe\n');
  console.log('A check that could not run is not a check that failed.');
  process.exit(2);
}

try {
  console.log('The shapes every agent answers with');

  const basics = await agent.get([
    '1.3.6.1.2.1.1.1.0', // sysDescr, a long octet string
    '1.3.6.1.2.1.1.3.0', // sysUpTime, TimeTicks: an application tag
    '1.3.6.1.2.1.1.5.0', // sysName
  ]);

  expect('three questions in one packet come back as three answers', basics.length === 3, basics.length);

  const [descr, uptime, name] = basics;

  expect(
    'a long string arrives whole',
    descr.kind === 'string' && descr.value.length > 20,
    `${descr.kind}: ${String(descr.value).slice(0, 60)}`
  );
  expect(
    'TimeTicks is read as a number and named as ticks, not as an integer',
    uptime.kind === 'ticks' && uptime.value > 0,
    `${uptime.kind}: ${uptime.value}`
  );
  expect('and sysName comes back', name.kind === 'string' && name.value.length > 0, name.value);

  // ---------------------------------------------------- multi-byte lengths
  console.log('\nA reply too big for a one-byte length');

  const many = [
    '1.3.6.1.2.1.1.1.0',
    '1.3.6.1.2.1.1.2.0',
    '1.3.6.1.2.1.1.3.0',
    '1.3.6.1.2.1.1.4.0',
    '1.3.6.1.2.1.1.5.0',
    '1.3.6.1.2.1.1.6.0',
    '1.3.6.1.2.1.1.7.0',
    '1.3.6.1.2.1.1.1.0',
  ];

  const bulky = await agent.get(many);

  // Eight bindings, one of them a hundred-character string: the outer sequence
  // is comfortably over 127 bytes, so its length is written across two bytes
  // with the top bit set. A reader that takes every length as one byte stops
  // after the first few here, or throws.
  expect(
    'eight objects asked at once all come back',
    bulky.length === many.length,
    `${bulky.length} of ${many.length}`
  );
  expect(
    'in the order they were asked for',
    bulky.every((one, at) => one.oid === many[at]),
    bulky.map((one) => one.oid).join(' ')
  );
  expect(
    'and the long one is still whole at the end of the packet',
    bulky.at(-1)?.value === descr.value,
    `${String(bulky.at(-1)?.value).slice(0, 40)} against ${String(descr.value).slice(0, 40)}`
  );

  // ------------------------------------------------------------- the walk
  console.log('\nA walk over a table with more than nine rows');

  const rows = await agent.walk('1.3.6.1.2.1.1.9.1.3');

  expect('the walk found rows', rows.length > 0, rows.length);
  expect(
    'more than nine of them, which is where string ordering breaks',
    rows.length >= 10,
    `${rows.length} rows — with fewer, this proves nothing about ordering`
  );

  const indexes = rows.map((row) => Number(row.oid.split('.').pop()));
  expect(
    'and they arrive in numeric order, so .10 follows .9',
    indexes.every((one, at) => at === 0 || one > indexes[at - 1]),
    indexes.join(' ')
  );
  expect(
    'with no row visited twice',
    new Set(rows.map((row) => row.oid)).size === rows.length,
    'a walk that repeats an OID is a walk that can never end'
  );
  expect(
    'and nothing from outside the subtree',
    rows.every((row) => row.oid.startsWith('1.3.6.1.2.1.1.9.1.3.')),
    rows.map((row) => row.oid).join(' ')
  );

  // ------------------------------------------------------------ the refusals
  console.log('\nWhat it does when there is nothing to give');

  const nothing = await agent.get(['1.3.6.1.4.1.99999.1.2.3.0']);
  expect(
    'an object the agent does not have is "no such object", not an error',
    nothing[0]?.value === null && /no such/.test(nothing[0]?.kind ?? ''),
    JSON.stringify(nothing[0])
  );

  const wrongCommunity = snmp({
    host: HOST,
    port: PORT,
    community: 'not-the-community',
    timeoutMs: 800,
    retries: 0,
  });
  expect(
    'a wrong community string gets silence, and silence is reported as silence',
    (await wrongCommunity.reachable()) === false,
    'an agent does not answer the wrong community, and this must not wait forever for it'
  );

  const nobody = snmp({ host: '127.0.0.1', port: 16299, timeoutMs: 400, retries: 0 });
  const started = Date.now();
  const answered = await nobody.reachable();
  expect(
    'and an address with nothing behind it gives up rather than hanging',
    answered === false && Date.now() - started < 3000,
    `${Date.now() - started} ms`
  );

  console.log('');
  if (failures > 0) {
    console.log(`${failures} checks failed against a real agent.`);
    process.exit(1);
  }
  console.log('The codec agrees with an implementation that has no interest in agreeing with it.');
} catch (error) {
  console.error(`\nThe check stopped: ${error.message}`);
  process.exit(1);
}
