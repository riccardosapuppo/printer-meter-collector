/**
 * SNMP version 2c, over UDP, read-only.
 *
 * **Read-only on purpose, and enforced rather than promised.** There is no
 * `set` in this file and there is nowhere to add one without noticing. The
 * service this was rebuilt from drove a printer's admin web page with a browser
 * and could change the device's IP address; a tool that reads meters has no
 * business being able to do that, and the surest way to keep it that way is not
 * to build the capability.
 *
 * Version 2c because that is what office printers speak. It is a community
 * string in clear text and it is not authentication — the README says so, and
 * says that the answer for anything that matters is v3, which these devices
 * mostly do not have. Pretending otherwise would be worse than saying it.
 *
 * UDP, which is the part people underestimate. There is no connection, no
 * ordering, and no delivery: a request that gets no answer is indistinguishable
 * from one that was never asked. So every request carries an id, replies are
 * matched to it, and anything unmatched is dropped rather than mistaken for the
 * answer to whatever was asked last.
 */

import dgram from 'node:dgram';

import {
  TAG,
  encodeInteger,
  encodeNull,
  encodeOid,
  encodeString,
  read,
  readInteger,
  readOid,
  readValue,
  wrap,
} from './ber.js';

/** Bigger than any single reply a printer sends, and small enough not to matter. */
const ENOUGH = 8192;

const ERRORS = {
  0: null,
  1: 'the reply was too big for one packet',
  2: 'there is no such name on this device',
  3: 'that value is the wrong type',
  4: 'that object is read-only',
  5: 'the device could not say why',
};

export function snmp({
  host,
  port = 161,
  community = 'public',
  timeoutMs = 2000,
  retries = 2,
  socket = null,
}) {
  let requestId = Math.floor(Math.random() * 0x7fffffff);

  function nextId() {
    // Wrapped by hand. Left to overflow, it becomes negative, and a negative
    // request id is encoded as a different number of bytes — which some agents
    // reject and others answer with an id that no longer matches.
    requestId = (requestId + 1) % 0x7fffffff;
    return requestId;
  }

  /** One request, one reply, or an explanation. */
  function ask(type, oids, { nonRepeaters = 0, maxRepetitions = 0 } = {}) {
    const id = nextId();

    const bindings = wrap(
      TAG.SEQUENCE,
      Buffer.concat(oids.map((oid) => wrap(TAG.SEQUENCE, Buffer.concat([encodeOid(oid), encodeNull()]))))
    );

    // For get-bulk these two fields carry the counts instead of the error
    // status and index. Same shape on the wire, different meaning — which is
    // why they are named here rather than passed as two zeroes.
    const request = wrap(
      type,
      Buffer.concat([
        encodeInteger(id),
        encodeInteger(type === TAG.GET_BULK ? nonRepeaters : 0),
        encodeInteger(type === TAG.GET_BULK ? maxRepetitions : 0),
        bindings,
      ])
    );

    const packet = wrap(
      TAG.SEQUENCE,
      Buffer.concat([
        encodeInteger(1), // version 1 means SNMP v2c. It is a numbering quirk.
        encodeString(community),
        request,
      ])
    );

    return send(packet, id);
  }

  function send(packet, id) {
    return new Promise((resolve, reject) => {
      const mine = socket ?? dgram.createSocket('udp4');
      const ownsSocket = socket === null;

      let attempt = 0;
      let timer = null;
      let settled = false;

      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        mine.removeListener('message', onMessage);
        mine.removeListener('error', onError);
        if (ownsSocket) mine.close();
        fn(value);
      };

      function onMessage(reply) {
        let parsed;
        try {
          parsed = readReply(reply);
        } catch {
          // A packet this cannot read is not this request's answer. Dropped,
          // not raised: on a busy network something else is talking too.
          return;
        }

        // The id is the whole of the matching. Without it a late reply to the
        // previous question is accepted as the answer to this one, and a
        // printer reports the page count of the machine asked before it.
        if (parsed.id !== id) return;

        done(resolve, parsed);
      }

      function onError(error) {
        done(reject, error);
      }

      function attemptOnce() {
        mine.send(packet, port, host, (error) => {
          if (error) done(reject, error);
        });

        timer = setTimeout(() => {
          attempt += 1;
          if (attempt > retries) {
            const silent = new Error(
              `${host}:${port} did not answer in ${timeoutMs} ms, after ${retries + 1} attempts`
            );
            silent.code = 'NO_ANSWER';
            return done(reject, silent);
          }
          attemptOnce();
        }, timeoutMs);
      }

      mine.on('message', onMessage);
      mine.on('error', onError);

      if (ownsSocket) mine.bind(0, () => attemptOnce());
      else attemptOnce();
    });
  }

  return {
    /** Several objects in one packet. */
    async get(oids) {
      const reply = await ask(TAG.GET, [].concat(oids));
      if (reply.error) throw Object.assign(new Error(reply.error), { code: 'SNMP_ERROR' });
      return reply.bindings;
    },

    /**
     * Everything under an OID.
     *
     * get-next one at a time rather than get-bulk, and that is deliberate: bulk
     * is faster and a device that mis-implements it returns overlapping ranges
     * that a naive reader turns into an endless loop. Printers have small
     * tables. Correct and slightly slower is the right trade here, and the
     * guard below is the second half of it.
     */
    async walk(root, { limit = 500 } = {}) {
      const found = [];
      let at = root;

      for (let step = 0; step < limit; step += 1) {
        const reply = await ask(TAG.GET_NEXT, [at]);
        if (reply.error) break;

        const binding = reply.bindings[0];
        if (!binding) break;

        // Out of the subtree, or the agent has nothing further.
        if (!binding.oid.startsWith(`${root}.`) && binding.oid !== root) break;
        if (binding.kind === 'end of the tree') break;

        // The one that turns a bad agent into a hang: an OID that does not move
        // forward means walking it again asks the same question forever.
        if (binding.oid === at) break;

        found.push(binding);
        at = binding.oid;
      }

      return found;
    },

    /** Is anything there, and does it answer to this community string. */
    async reachable() {
      try {
        // sysDescr. Every agent has it, and an agent that does not is not one.
        await ask(TAG.GET, ['1.3.6.1.2.1.1.1.0']);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** A reply packet, taken apart. */
export function readReply(packet) {
  const envelope = read(packet);
  if (envelope.tag !== TAG.SEQUENCE) throw new Error('this is not an SNMP message');

  const version = read(packet, envelope.from);
  const community = read(packet, version.next);
  const pdu = read(packet, community.next);

  if (pdu.tag !== TAG.RESPONSE) throw new Error('this is not a reply');

  const id = read(packet, pdu.from);
  const errorStatus = read(packet, id.next);
  const errorIndex = read(packet, errorStatus.next);
  const bindings = read(packet, errorIndex.next);

  const status = readInteger(errorStatus.body);

  const found = [];
  let at = bindings.from;

  while (at < bindings.end) {
    const pair = read(packet, at);
    const oid = read(packet, pair.from);
    const value = read(packet, oid.next);

    const said = readValue(value.tag, value.body);
    found.push({ oid: readOid(oid.body), ...said });

    at = pair.next;
  }

  return {
    id: readInteger(id.body),
    error: status === 0 ? null : (ERRORS[status] ?? `the device answered error ${status}`),
    errorIndex: readInteger(errorIndex.body),
    bindings: found,
  };
}
