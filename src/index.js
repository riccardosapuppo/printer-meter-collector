#!/usr/bin/env node
/**
 * Starts the collector and serves what it has found.
 *
 *     npm run fleet     # six invented printers, in another terminal
 *     npm start         # http://127.0.0.1:3500
 *
 * 3500, and not 3000. That is the port every project on a machine uses in turn,
 * and a browser remembers service workers, storage and permissions per origin —
 * so two projects sharing a port share state neither knows about.
 *
 * Bound to localhost unless told otherwise. This holds a list of the addresses
 * of every printer somebody owns, which is not a thing to publish by leaving a
 * default alone.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApi } from './http/api.js';
import { collector } from './fleet/schedule.js';
import { readDevice } from './fleet/read.js';
import { readingStore } from './fleet/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const port = Number(argument('port', process.env.PORT ?? 3500));
const host = argument('host', process.env.HOST ?? '127.0.0.1');
const fleetFile = path.resolve(argument('fleet', process.env.FLEET_FILE ?? path.join(here, '..', 'config', 'fleet.json')));
const dataFile = path.resolve(argument('data', process.env.DATA_FILE ?? path.join(here, '..', 'data', 'readings.jsonl')));
const everyMs = Number(argument('every-ms', process.env.COLLECT_EVERY_MS ?? 60_000));

function log(level, message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, ...detail })}\n`);
}

if (!fs.existsSync(fleetFile)) {
  log('error', 'there is no fleet file, so there is nothing to collect from', { file: fleetFile });
  log('info', 'there is one to copy in config/fleet.example.json');
  process.exit(1);
}

/**
 * The fleet, re-read from the file each round.
 *
 * A printer is added when somebody plugs one in, which is not a moment anybody
 * wants to restart a service for.
 */
function fleet() {
  try {
    return JSON.parse(fs.readFileSync(fleetFile, 'utf8')).devices ?? [];
  } catch (error) {
    log('warn', 'the fleet file could not be read; the last good list stays in force', {
      detail: error.message,
    });
    return lastGoodFleet;
  }
}

let lastGoodFleet = [];
try {
  lastGoodFleet = JSON.parse(fs.readFileSync(fleetFile, 'utf8')).devices ?? [];
} catch (error) {
  log('error', 'the fleet file is not readable JSON', { file: fleetFile, detail: error.message });
  process.exit(1);
}

const store = readingStore({ file: dataFile });

const rounds = collector({
  devices: () => {
    const now = fleet();
    if (now.length > 0) lastGoodFleet = now;
    return lastGoodFleet;
  },
  read: (device) =>
    readDevice({
      host: device.host,
      port: device.port ?? 161,
      community: device.community ?? 'public',
    }).then((reading) => ({ ...reading, site: device.site ?? null })),
  store,
  everyMs,
  log,
});

const api = buildApi({ store, collector: rounds, fleet: () => lastGoodFleet, log });

const server = api.listen(port, host, async () => {
  log('info', 'listening', {
    url: `http://${host}:${port}/`,
    fleet_file: fleetFile,
    data_file: dataFile,
    devices: lastGoodFleet.length,
  });

  // A round at startup, so the dashboard has something in it rather than a
  // blank page for the first interval. Somebody starting this wants to see the
  // fleet, not to wait a minute to find out whether it works.
  await rounds.round();
  rounds.start();
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log('error', `something is already listening on ${host}:${port}`, {
      try: `npm start -- --port ${port + 1}`,
    });
    process.exit(1);
  }
  throw error;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'stopping', { signal });
    rounds.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
