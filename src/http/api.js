/**
 * What the collector will tell you, over HTTP.
 *
 * Read-only, like everything else here, with two exceptions that both do the
 * same kind of thing: `POST /api/round` collects now instead of waiting for the
 * timer, and `POST /api/discover` sweeps a range. Neither writes to a device.
 *
 * Nothing is authenticated, and the README says so plainly: this binds to
 * localhost and is meant to sit behind whatever a deployment already uses. What
 * it must not do is *look* protected while being open, so there is no token
 * field, no login page, and no reassuring padlock anywhere.
 */

import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

import { discover } from '../fleet/discover.js';

export function buildApi({ store, collector, fleet, log = () => {} }) {
  const api = express();
  api.disable('x-powered-by');
  api.use(express.json({ limit: '64kb' }));

  api.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      reads: 'SNMP v2c, read-only, on the Printer MIB (RFC 3805)',
      writes: 'nothing — there is no set in this service',
      fleet: fleet().length,
      collector: collector.state(),
      ...store.counts(),
    });
  });

  /**
   * Every device, grouped by site.
   *
   * Grouped because that is the shape somebody uses it in: an engineer visits a
   * site, not a serial number, and a flat list of two hundred rows has to be
   * sorted by hand every time.
   */
  api.get('/api/devices', (req, res) => {
    const known = new Map(fleet().map((one) => [one.serial ?? `${one.host}:${one.port}`, one]));

    const devices = store.devices().map((device) => ({
      serial: device.serial,
      site: device.latest.site ?? known.get(device.serial)?.site ?? 'unknown',
      name: device.latest.name,
      model: device.latest.model,
      host: device.latest.host,
      reachable: device.latest.reachable,
      why: device.latest.why ?? null,
      pages: device.latest.pages,
      at: device.latest.at,
      readings: device.readings,
      supplies: device.latest.supplies ?? [],
      trays: device.latest.trays ?? [],
      alerts: device.latest.alerts ?? [],
      usage: store.usage(device.serial),
      needs: whatItNeeds(device.latest),
    }));

    const sites = new Map();
    for (const device of devices) {
      if (!sites.has(device.site)) sites.set(device.site, []);
      sites.get(device.site).push(device);
    }

    res.json({
      at: new Date().toISOString(),
      sites: [...sites.entries()]
        .map(([site, inIt]) => ({
          site,
          devices: inIt,
          needs: inIt.flatMap((one) => one.needs).length,
          silent: inIt.filter((one) => !one.reachable).length,
        }))
        .sort((a, b) => b.needs - a.needs || a.site.localeCompare(b.site)),

      // Addresses that answered and would not say which device they are. Kept
      // apart rather than filed under a made-up key, because two of them would
      // merge into one machine with impossible counters.
      unidentified: store.unidentified(),
    });
  });

  api.get('/api/devices/:serial', (req, res) => {
    const readings = store.history(req.params.serial);
    if (readings.length === 0) return res.status(404).json({ error: 'nothing has ever been read from that serial' });

    res.json({
      serial: req.params.serial,
      latest: readings.at(-1),
      usage: store.usage(req.params.serial),
      history: readings.map((one) => ({
        at: one.at,
        pages: one.pages,
        reachable: one.reachable,
        supplies: (one.supplies ?? []).map((supply) => ({
          description: supply.description,
          remaining: supply.remaining,
        })),
      })),
    });
  });

  /** Collect now rather than at the next tick. */
  api.post('/api/round', async (req, res) => {
    const said = await collector.round();
    if (!said) {
      return res.status(409).json({
        error: 'a round is already going',
        error_description: 'it will finish on its own; asking again would put two sweeps on the same fleet',
      });
    }
    res.json(said);
  });

  api.post('/api/discover', async (req, res) => {
    const { range, community = 'public', allowPublic = false } = req.body ?? {};

    if (!range) return res.status(400).json({ error: 'give it a range, like 192.168.1.0/24' });

    try {
      const found = await discover({ range, community, allowPublic, log });
      res.json({ range, found });
    } catch (error) {
      res.status(error.code === 'NOT_PRIVATE' ? 403 : 400).json({ error: error.message });
    }
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  api.use(express.static(path.join(here, '..', '..', 'public'), { etag: false, maxAge: 0 }));

  api.use((req, res) => {
    res.status(404).json({
      error: 'no such endpoint',
      you_asked_for: `${req.method} ${req.originalUrl}`,
      it_starts_at: '/api/health',
    });
  });

  return api;
}

/**
 * What a person would have to do about this device, in plain words.
 *
 * The whole point of collecting any of this. A dashboard that shows numbers and
 * leaves somebody to work out which of two hundred machines needs a visit has
 * moved the work rather than done it.
 *
 * The thresholds are here and not in a settings page on purpose: they are three
 * numbers, and a configuration screen for three numbers is a screen nobody
 * opens and a file nobody remembers to fill in.
 */
export function whatItNeeds(reading, { low = 15, nearlyFull = 85, trayLow = 10 } = {}) {
  if (!reading.reachable) return [{ what: 'it is not answering', why: reading.why, urgent: true }];

  const needs = [];

  for (const supply of reading.supplies ?? []) {
    if (supply.remaining === null) continue;

    if (supply.kind === 'filled' && supply.percent >= nearlyFull) {
      needs.push({
        what: `${supply.description} is ${supply.percent}% full`,
        why: 'this fills up rather than empties; when it is full the machine stops',
        urgent: supply.percent >= 95,
      });
      continue;
    }

    if (supply.kind !== 'filled' && supply.remaining <= low) {
      needs.push({
        what: `${supply.description} is at ${supply.remaining}%`,
        why: null,
        urgent: supply.remaining <= 5,
      });
    }
  }

  for (const tray of reading.trays ?? []) {
    if (tray.sheets === null || tray.max === null) continue;
    if (tray.sheets === 0) {
      needs.push({ what: `${tray.description} is empty`, why: null, urgent: false });
      continue;
    }
    if ((tray.sheets / tray.max) * 100 <= trayLow) {
      needs.push({ what: `${tray.description} is nearly empty`, why: `${tray.sheets} sheets`, urgent: false });
    }
  }

  for (const alert of reading.alerts ?? []) {
    needs.push({ what: alert.text, why: `the device reports this as ${alert.severity}`, urgent: alert.serious });
  }

  return needs;
}
