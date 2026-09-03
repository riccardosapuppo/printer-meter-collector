# Printer meter collector

Reads page counters and consumable levels from networked printers over SNMP,
keeps the history, and puts what needs doing on a board somebody can glance at.

**Read-only.** There is no `set` anywhere in this service and nowhere to add one
without noticing. It reads meters; it cannot change a device.

![The board: three sites, each device leading with what needs doing, supplies drawn as gauges, and the machine that is not answering marked in red](docs/board.png)

## Where this came from

The original was built for a company that got through consumables in volume — a
floor of machines from one major manufacturer, printing all day, and a recurring
toner bill large enough that somebody wanted to see it coming. Two questions,
and neither had an answer anybody trusted: **which machine is about to stop**,
and **what did we actually print last month**.

It answered them by **driving each printer's own admin web page**. A headless
browser logged into the device, clicked through to the supplies screen, and read
the toner level by **measuring the width of a coloured bar** — because the
number was not in the markup. Only the bar was.

It worked, and it paid for itself, and it was wrong in three ways that only show
up later:

- **the reading was an inference from a CSS pixel width.** A firmware update
  that restyled that page would change every number without anything changing
  about the printers;
- **it needed an administrator's login on every device**, kept somewhere, to
  read a figure the device will hand to anybody who asks politely;
- **it worked for one make.** The next purchase is a different make with a
  different admin page, and the collector gets rewritten rather than pointed.

### What this one does instead, and what is missing because of it

This reads **SNMP**, and everything it reads is defined in an open IETF
standard: the **Printer MIB (RFC 3805)**, the Host Resources MIB (RFC 2790) and
SNMPv2-MIB (RFC 3418). Nothing comes from a vendor's private branch, and
`prtMarkerSuppliesLevel` is the device stating the number rather than a picture
of the number that has to be measured. It is also what makes it useful across a
fleet, which is never one make.

That is not a compromise made for a public repository. It is what the original
should have done — and this is worth saying plainly, because the scraping was
the harder-looking half and it is not here.

**The page-scraping is not reproduced, and will not be.** Not because it is
difficult: because a public repository cannot ship something whose demonstration
is logging into a device it does not own, with credentials it has no business
holding. There is no fleet here to point it at, and a scraper aimed at somebody
else's hardware is not a thing to publish.

What survives is the part that transfers: reading a fleet nobody wrote this for,
over a protocol nobody has to be asked for permission to speak. The invented
printers in [`sim/`](sim/) answer real SNMP on real sockets, so the collector is
doing the real work against something that behaves like the real thing — the BER
encoder and the timeouts included.

What SNMP cannot give, and a scraper could, is a **per-user or per-department**
page count: on most devices that lives only in the vendor's own accounting
screen. Named here rather than left to be discovered.

## The other decision worth arguing about

### Three states, not two

A supply is not always a number. Sometimes the device says it cannot measure,
and RFC 3805 has values that say exactly that: −1, −2, −3.

Dividing one of those by the maximum gives a confident percentage that is a lie.
Clamped to zero it becomes an empty bar, which looks exactly like a machine
about to stop — so a cartridge is ordered and an engineer sent for a printer
that is perfectly full.

So "unknown" is drawn as itself: hatched, full width, and labelled in words.

![A device whose black toner cannot be measured, showing a hatched bar and the word unknown with the reason underneath](docs/unknown.png)

The other two that catch people, both in the sample fleet because both are in
every real one: a **waste container fills** rather than empties, so 90 means
nearly unusable and not nearly new; and a supply reported **in sheets** is not a
percentage, so 430 labels is not 430%.

## Before you start

- **Node 20.11 or newer.** Declared in `engines` and pinned in CI.
- **One runtime dependency**, Express, for the board. The SNMP client is written
  here, in `src/snmp/`.
- **No hardware.** `npm run fleet` starts six invented printers on localhost
  that answer real SNMP.
- **No database.** Readings are append-only lines of JSON in `data/`.
- **Docker, only for one check.** `npm run check:snmp` puts the codec against a
  real `net-snmp` agent. Everything else runs without it.
- **Microsoft Edge, only for two more.** `npm run check:screen` and
  `npm run check:mark` drive the browser already on this machine
  (`channel: 'msedge'`) rather than downloading one, and they need
  `playwright-core`, a devDependency. Both say so and stop if it is missing,
  rather than reporting a pass they did not earn.

**Measured, not estimated:** `npm install` writes **14 MB** into `node_modules`;
`npm run check:snmp` pulls `polinux/snmpd` once, which is **89 MB**; the
readings file is the only thing written and is **1.7 MB** after the rounds that
made the pictures below. Nothing else touches the network, ever.

**To put the machine back:** delete the folder — nothing is written outside it —
and `docker image rm polinux/snmpd` if you ran the SNMP check.

## Running it

One command. It starts six invented printers, waits until they are answering,
starts the collector, and opens the board.

```
npm install
npm start
```

The board is at <http://127.0.0.1:3500> and opens by itself — after the first
round, so what appears is a fleet rather than an empty page that fills in a
second later. Not in CI, not without a terminal, and not with `--no-open` or
`NO_OPEN=1`; it says which of those happened.

### The two halves, separately

```
npm run fleet       # just the six invented printers, on 127.0.0.1:16101-16106
npm run collector   # just the collector, for pointing at real devices
```

The second is not only for debugging. **Pointing this at a real fleet is the
actual use**, and that must not require starting a simulator first.

Point it at real devices by editing [`config/fleet.json`](config/fleet.json).
The file is **re-read every round**, so a printer can be added without a
restart.

```json
{ "devices": [{ "host": "192.168.1.40", "site": "Harbour Street", "community": "public" }] }
```

**3500, not 3000.** That is the port every project on a machine uses in turn,
and a browser remembers service workers, storage and permissions per origin — so
two projects sharing a port share state neither knows about.

## The six invented printers

Every device, site, serial and page count in `sim/` is made up. They are shaped
to be awkward in the ways real fleets are, because a collector that only ever
meets tidy devices has never been tested.

| | why it is there |
|---|---|
| `front-desk` | ordinary, with a waste container that fills |
| `accounts` | **cannot measure its toner**, and says so with −2 |
| `studio` | **two black cartridges**, so code assuming one row per colour reports half the toner it has; and a paper jam |
| `workshop` | supplies **in sheets**, not percent |
| `reception` | a waste container nearly full, and a tray nearly empty |
| `stores` | **nothing is listening**, because a fleet always has one machine off |

That last one is not decoration. A device that has never answered has no serial,
so it has no history, so it is not on the board, so nobody knows it is down — and
that is the failure a fleet report must not have. It is filed under its address
instead, marked provisional:

![A card for an address that is not answering, named by its address and saying that nothing answered or it does not accept this community string](docs/silent.png)

## What it does, and what it will not do

```
GET  /api/health           what it is, and what it has collected
GET  /api/devices          every device, grouped by site, with what it needs
GET  /api/devices/:serial  one device, and its history
POST /api/round            collect now rather than at the next tick
POST /api/discover         sweep a range for anything that answers SNMP
```

The sweep **refuses anything outside the private address ranges** unless the
caller passes `allowPublic`, and refuses anything wider than a /16. Sweeping a
range on a network you administer is ordinary network management; on somebody
else's it is not, and nobody should do the second by leaving a field blank.

There is no authentication, and this says so rather than looking protected while
being open. It binds to localhost and belongs behind whatever a deployment
already has.

**SNMP v2c is a community string in clear text and it is not authentication.**
It is what office printers speak. The answer for anything that matters is v3,
which most of these devices do not have; pretending otherwise would be worse
than saying it.

## On a phone

<p>
  <img src="docs/phone.png" alt="The board on a phone: sites stack, gauges become one per row, and what needs doing stays at the top of each card" width="300" />
</p>

## Checking it

```
npm test                # 55 assertions over the parts
npm run check:snmp      # the codec against an agent nobody here wrote
npm run walkthrough     # 28 over HTTP against the running collector
npm run check:screen    # drives the board with a browser
npm run check:mark      # the header mark and the tab icon are one drawing
```

Four layers, and each one has caught something the others could not.

**`npm test`** covers the encoding, the normalisation and the scheduler. The BER
tests check against byte sequences written down from the standard, not against
this project's own encoder — a codec tested by encoding and decoding its own
output agrees with itself about everything, including what it gets wrong.

**`npm run check:snmp`** is the other half of that, and it is the check that
keeps the rest honest:

```
docker run -d --rm --name snmp-probe -p 16200:161/udp polinux/snmpd
npm run check:snmp
docker stop snmp-probe
```

The simulator in `sim/` is built on the same encoder the client decodes with, so
anything they both get wrong they will agree about. `net-snmp` has been in the
field for twenty-five years and has no interest in agreeing with this. Two of
the fifteen assertions are chosen for where hand-rolled codecs break: eight
objects in one request, which puts the reply's outer length over 127 bytes; and
a walk of more than nine rows, which is where an OID sorted as a string stops
matching one sorted as numbers.

Without a container it exits 2 and says how to start one. A check that could not
run is not a check that failed.

**`npm run walkthrough`** drives the running collector. Half of it is about the
readings that are easy to get wrong — the unmeasurable toner, the waste
container, the sheets, the two black cartridges — and half about the device that
is switched off still being in the report.

**`npm run check:screen`** found something neither of the others could. The API
was returning all six devices correctly and the board drew **one site out of
three** and stopped, because a device that never answered has no `pages` key and
`=== null` does not catch `undefined`. Nothing threw where a test could see it;
the report simply lost two thirds of the fleet. So the assertion it exists for is
the boring one: what is on the screen is counted against what the API said.

## Where things are

```
src/
  snmp/
    ber.js         ASN.1 BER, by hand: the encoding SNMP is written in
    client.js      get, get-next and walk over UDP. Read-only
    oids.js        the objects it reads, and which RFC defines each
  fleet/
    read.js        one device, turned into something comparable across makes
    store.js       append-only history, filed by serial and never by address
    schedule.js    going round without falling over one dead machine
    discover.js    a sweep, bounded to private ranges
  http/api.js      what it will tell you, and what needs doing
sim/               six invented printers that answer real SNMP
public/            the board: no framework, no build step
tools/             the checks not written behind the same door
```

## What this is not

- **Readings are in a file.** Append-only lines of JSON, loaded at startup: a
  few hundred thousand readings, not a few hundred million. A real deployment
  puts those lines in PostgreSQL or a time-series store and keeps this
  interface, which is four functions and says nothing about files.
- **No SNMP v3.** Adding it means USM, engine discovery, and key localisation,
  which is a project of its own and not what these devices speak.
- **No traps.** This asks; it does not listen. A device that wants to report a
  jam the moment it happens needs the other half.
- **Nothing is written to a device, ever.** Not a limitation — the point.

## A note on manufacturers

This reads the **standard** Printer MIB, which every networked office printer
implements. It is not written for, tested against, endorsed by, or affiliated
with any manufacturer, and it contains no vendor firmware, interface, private
MIB or branding. Every device in `sim/` is invented.

## Licence

MIT. See [LICENSE](LICENSE).

Developed by Riccardo Sapuppo.
