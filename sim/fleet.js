#!/usr/bin/env node
/**
 * A fleet of six invented printers, on localhost.
 *
 *     npm run fleet
 *
 * The devices themselves are in `devices.js`, with the note on why each one
 * is awkward. This file is the program that serves them: it binds a socket
 * per printer, says what is answering where, and stops on Ctrl-C.
 *
 * Anything that needs to know a port reads `devices.js`. Importing this file
 * to find one out would bind six sockets and print a banner as a side effect
 * of reading a number.
 */


import { startPrinter } from './printer.js';
import { FLEET, SILENT } from './devices.js';


const running = [];

/*
 * Started one at a time, and a refusal is said out loud.
 *
 * The ordinary way for this to fail is a second copy of the fleet already
 * holding 16101 -- somebody left a terminal open, or a previous run was not
 * tidied away. That deserves a sentence naming the port and what to do about
 * it. What it got instead, for as long as this file existed, was Node's own
 * "Detected unsettled top-level await" and exit code 13, because the promise
 * that binds the socket had no way to refuse: see the note in `printer.js`.
 *
 * Whatever did come up is stopped before leaving. A half-started fleet holding
 * three of six ports is the thing that makes the NEXT attempt fail too, and
 * for a reason one step further from the cause.
 */
for (const device of FLEET) {
  try {
    running.push(await startPrinter(device, { port: device.port }));
  } catch (wrong) {
    await Promise.all(running.map((one) => one.stop()));

    if (wrong.code === 'EADDRINUSE') {
      console.error(`Something is already listening on 127.0.0.1:${wrong.port}.`);
      console.error('Most likely another copy of these printers, still running.');
      console.error('Stop it with Ctrl-C in the terminal that started it, or');
      console.error('find it with:');
      console.error(
        process.platform === 'win32'
          ? `  netstat -ano | findstr :${wrong.port}`
          : `  lsof -nP -iUDP:${wrong.port}`
      );
    } else {
      console.error(`The printer on 127.0.0.1:${wrong.port} would not start: ${wrong.message}`);
    }

    process.exit(1);
  }
}

console.log(`${running.length} invented printers are answering SNMP on 127.0.0.1:`);
for (const one of running) {
  console.log(`  ${one.port}  ${one.device.name.padEnd(11)} ${one.device.site.padEnd(15)} ${one.device.serial}`);
}
console.log(`  ${SILENT.port}  ${SILENT.name.padEnd(11)} ${SILENT.site.padEnd(15)} nothing is listening here, on purpose`);
console.log('\nEverything above is invented. Stop it with Ctrl-C.');

/*
 * And a word to whoever started this, if anybody did.
 *
 * `npm start` has to know when these are answering before it starts the
 * collector, and every other way of knowing is somebody else's word for it.
 * Reading this file's stdout is reading an opinion. Asking 16101 over SNMP
 * proves a socket answers and proves nothing about WHOSE: a second copy of
 * this fleet, left over in another terminal, answers exactly the same and is
 * indistinguishable by anything in the packet.
 *
 * A message on the channel the launcher opened is neither. Nobody else can
 * send it, it cannot arrive early, and when there is no launcher -- `npm run
 * fleet` on its own -- `process.send` is undefined and this costs nothing.
 */
process.send?.({ ready: true, ports: running.map((one) => one.port) });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await Promise.all(running.map((one) => one.stop()));
    process.exit(0);
  });
}
