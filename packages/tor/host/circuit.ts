// A circuit you can open a stream on.
//
// `link.ts` gets you a CREATE2 and 72 bytes of key material. This turns that into something
// that carries data: relay cells in both directions, and a stream on top of them.
//
// ## The onion
//
// A circuit is a list of hops, and a cell for hop N is encrypted N times: with hop N's key
// first, then N-1's, out to hop 1's, which is the only layer the first relay can remove.
// Each relay peels one layer and forwards what it finds, so no relay sees more than its two
// neighbours. That is the whole idea, and it is why `extend` sends its request *through* the
// hops already built rather than opening a new connection.
//
// Receiving inverts it: peel with hop 1 and ask whether it is hop 1's cell; if not, peel
// with hop 2 and ask again. The peel always happens — every hop's cipher advanced when it
// forwarded the cell — while the digest advances only for the hop the cell came from. That
// asymmetry is why `hopPeel` and `hopCheck` are separate calls.
//
// ## Flow control
//
// Tor windows both directions. A sender may put 1000 cells on a circuit and 500 on any one
// stream before it must stop and wait for a RELAY_SENDME crediting it more; the receiver
// sends one every 100 cells (circuit) or 50 (stream).
//
// Circuit-level SENDMEs are authenticated: the body carries the running digest at the point
// the acknowledged cell arrived, so a relay cannot speed the sender up by inventing credit.
// Only a party that actually received the cells knows that value. Which cell's digest is
// the fiddly part — it is recorded when the deliver window reaches a multiple of the
// increment, which is one cell *before* the SENDME goes out.
//
// Stream SENDMEs carry nothing: a stream's credit is bounded by its circuit's, so there is
// nothing there worth forging.

import { wacBind } from "../../../harness/wacBind.ts";
import { CMD, type Link, readCell } from "./link.ts";

const mod = await wacBind("packages/tor/test/wac/link_probe.wac");
const hopInit = mod.hopInit as (material: Uint8Array) => Uint8Array;
const hopSend = mod.hopSend as (
  state: Uint8Array, cmd: number, streamId: number, data: Uint8Array,
) => Uint8Array;
const hopPeel = mod.hopPeel as (state: Uint8Array, payload: Uint8Array) => Uint8Array;
const hopWrap = mod.hopWrap as (state: Uint8Array, payload: Uint8Array) => Uint8Array;
const hopCheck = mod.hopCheck as (state: Uint8Array, body: Uint8Array) => Uint8Array;
const extend2Body = mod.extend2Body as (
  ipv4: Uint8Array, port: number, identity: Uint8Array, handshake: Uint8Array,
) => Uint8Array;
const extended2Reply = mod.extended2Reply as (data: Uint8Array) => Uint8Array;
const ntorClientRequest = mod.ntorClientRequest as (
  identity: Uint8Array, onionKey: Uint8Array, ephemeralPriv: Uint8Array,
) => Uint8Array;
const ntorClientFinish = mod.ntorClientFinish as (
  identity: Uint8Array, onionKey: Uint8Array, ephemeralPriv: Uint8Array,
  reply: Uint8Array, keyLen: number,
) => Uint8Array;
const hopDigest = mod.hopDigest as (state: Uint8Array, forward: boolean) => Uint8Array;
const sendmeBodyV1 = mod.sendmeBodyV1 as (digest: Uint8Array) => Uint8Array;
const hopStateLen = (mod.hopStateLen as () => number)();
const relayCommand = mod.relayCommand as (body: Uint8Array) => number;
const relayStreamId = mod.relayStreamId as (body: Uint8Array) => number;
const relayPayload = mod.relayPayload as (body: Uint8Array) => Uint8Array;
const beginBody = mod.beginBody as (hostPort: string) => Uint8Array;
const endReason = mod.endReason as (body: Uint8Array) => number;

const encodeFixed = mod.encodeFixed as (
  circId: number, command: number, payload: Uint8Array,
) => Uint8Array;
const cellCommand = mod.cellCommand as (buf: Uint8Array, at: number) => number;
const cellPayload = mod.cellPayload as (buf: Uint8Array, at: number) => Uint8Array;

export const RELAY = {
  begin: (mod.cmdRelayBegin as () => number)(),
  data: (mod.cmdRelayData as () => number)(),
  end: (mod.cmdRelayEnd as () => number)(),
  connected: (mod.cmdRelayConnected as () => number)(),
  sendme: (mod.cmdRelaySendme as () => number)(),
  beginDir: (mod.cmdRelayBeginDir as () => number)(),
  extend2: (mod.cmdRelayExtend2 as () => number)(),
  extended2: (mod.cmdRelayExtended2 as () => number)(),
} as const;

/** Why a stream ended, from tor-spec §6.3. Enough of them to make a message worth reading. */
const END_REASONS: Record<number, string> = {
  1: "misc", 2: "resolve failed", 3: "connection refused", 4: "exit policy",
  5: "destroy", 6: "done", 7: "timeout", 8: "no route", 9: "hibernating",
  10: "internal", 11: "resource limit", 12: "connection reset", 13: "tor protocol violation",
  14: "not a directory",
};

/** tor-spec §7.3: the windows, and how often credit is returned. */
const CIRCUIT_WINDOW = 1000;
const CIRCUIT_INCREMENT = 100;
const STREAM_WINDOW = 500;
const STREAM_INCREMENT = 50;

export class Circuit {
  #link: Link;
  #circId: number;
  #hops: Uint8Array[];
  #nextStreamId = 1;

  // How many more data cells we may send, and how many more we may receive before we owe
  // the far end a SENDME. Two separate counts in each direction, per circuit and per stream.
  #packageWindow = CIRCUIT_WINDOW;
  #deliverWindow = CIRCUIT_WINDOW;
  #streamPackage = new Map<number, number>();
  #streamDeliver = new Map<number, number>();

  // The digest to put in the next circuit-level SENDME, captured when the deliver window
  // hit a multiple of the increment — one cell before the SENDME is due.
  #pendingSendmeDigest: Uint8Array | null = null;

  constructor(link: Link, circId: number, material: Uint8Array) {
    this.#link = link;
    this.#circId = circId;
    this.#hops = [hopInit(material)];
  }

  /** How many relays the circuit runs through. */
  get length(): number {
    return this.#hops.length;
  }

  /**
   * Send one relay cell to hop `target` (the last hop by default).
   *
   * `cellCommand` exists for EXTEND2, which must travel in a RELAY_EARLY cell rather than a
   * RELAY one. The count of RELAY_EARLY cells a circuit may carry is capped, and that cap is
   * what bounds how long a circuit can be made — an attacker who could extend without limit
   * could build a circuit that loops through one relay repeatedly.
   */
  async #send(
    command: number, streamId: number, data: Uint8Array,
    opts: { target?: number; cellCommand?: number } = {},
  ): Promise<void> {
    const target = opts.target ?? this.#hops.length - 1;
    const r = hopSend(this.#hops[target], command, streamId, data);
    this.#hops[target] = r.slice(0, hopStateLen);
    let payload = r.slice(hopStateLen);
    // Then one layer per hop between us and the target, nearest last: hop 1's layer must be
    // the outermost, because hop 1 is the only relay that can remove it.
    for (let i = target - 1; i >= 0; i--) {
      const w = hopWrap(this.#hops[i], payload);
      this.#hops[i] = w.slice(0, hopStateLen);
      payload = w.slice(hopStateLen);
    }
    await this.#link.conn.write(
      encodeFixed(this.#circId, opts.cellCommand ?? CMD.relay, payload),
    );
  }

  /**
   * The next relay cell addressed to us.
   *
   * A cell that does not verify is fatal rather than skippable: its bytes are already in the
   * peer's running digest, so carrying on would mean every later cell failing too. Reporting
   * it as a dead circuit is both accurate and the only safe thing to do.
   */
  async #recv(): Promise<{ command: number; streamId: number; data: Uint8Array }> {
    for (;;) {
      const cell = await readCell(this.#link.conn, this.#link.buf);
      if (cell === null) throw new Error("the relay closed the connection");
      const cmd = cellCommand(cell, 0);
      if (cmd === CMD.destroy) {
        throw new Error(`circuit destroyed by the relay, reason ${cellPayload(cell, 0)[0]}`);
      }
      if (cmd !== CMD.relay) continue;   // padding and the like

      let payload = cellPayload(cell, 0);
      let body: Uint8Array | null = null;
      for (let i = 0; i < this.#hops.length; i++) {
        const peeled = hopPeel(this.#hops[i], payload);
        this.#hops[i] = peeled.slice(0, hopStateLen);
        payload = peeled.slice(hopStateLen);
        const checked = hopCheck(this.#hops[i], payload);
        this.#hops[i] = checked.slice(0, hopStateLen);
        if (checked[hopStateLen] === 1) {
          body = payload;
          break;
        }
      }
      if (body === null) {
        // Every hop's cipher has advanced by now and none claimed the cell, so there is no
        // state to roll back to and no way to resynchronise. Tor's own client tears the
        // circuit down here for the same reason.
        throw new Error("a relay cell was not recognised by any hop — the circuit is dead");
      }
      const command = relayCommand(body);
      const streamId = relayStreamId(body);

      // A SENDME is the far end giving us room to send more. Credit it and read on; it is
      // flow control, not something the caller asked for.
      if (command === RELAY.sendme) {
        if (streamId === 0) {
          this.#packageWindow += CIRCUIT_INCREMENT;
        } else {
          this.#streamPackage.set(
            streamId, (this.#streamPackage.get(streamId) ?? STREAM_WINDOW) + STREAM_INCREMENT,
          );
        }
        continue;
      }

      // Only data counts against the windows. Control cells are not metered, which is why a
      // circuit can always be extended and torn down however congested it is.
      if (command === RELAY.data) {
        this.#deliverWindow--;
        if (this.#deliverWindow < 0) {
          throw new Error("the far end sent past its window — protocol violation");
        }
        // Record the digest exactly when the window reaches a multiple of the increment.
        // This cell is the one the next SENDME will name, and the running hash has to be
        // read now: one more cell and it is a different value.
        if (this.#deliverWindow % CIRCUIT_INCREMENT === 0) {
          this.#pendingSendmeDigest = hopDigest(this.#hops[this.#hops.length - 1], false);
        }
        await this.#considerSendmes(streamId);
      }
      return { command, streamId, data: relayPayload(body) };
    }
  }

  /**
   * Open a stream to `host:port` through the exit, and return its id.
   *
   * The address goes as text for the exit to resolve. Resolving it here would hand the
   * destination to whoever answers our DNS — the one party the circuit exists to hide it
   * from — so this is a property of the design rather than a convenience.
   */
  async begin(hostPort: string): Promise<number> {
    const streamId = this.#nextStreamId++;
    await this.#send(RELAY.begin, streamId, beginBody(hostPort));
    const reply = await this.#recv();
    if (reply.command === RELAY.end) {
      const why = reply.data.length >= 1 ? reply.data[0] : 0;
      throw new Error(`stream refused: ${END_REASONS[why] ?? `reason ${why}`}`);
    }
    if (reply.command !== RELAY.connected) {
      throw new Error(`expected RELAY_CONNECTED, got relay command ${reply.command}`);
    }
    return streamId;
  }

  /**
   * Open a stream to this relay's own directory cache.
   *
   * No address and no exit policy involved, which makes it the one stream a single-hop
   * circuit can always open — and so the honest end-to-end test of everything below it.
   */
  async beginDir(): Promise<number> {
    const streamId = this.#nextStreamId++;
    await this.#send(RELAY.beginDir, streamId, new Uint8Array(0));
    const reply = await this.#recv();
    if (reply.command === RELAY.end) {
      const why = reply.data.length >= 1 ? reply.data[0] : 0;
      throw new Error(`directory stream refused: ${END_REASONS[why] ?? `reason ${why}`}`);
    }
    if (reply.command !== RELAY.connected) {
      throw new Error(`expected RELAY_CONNECTED, got relay command ${reply.command}`);
    }
    return streamId;
  }

  /**
   * Extend the circuit by one relay, through the hops already built.
   *
   * The request goes to the current last hop, which opens its own connection onward and
   * relays the ntor handshake. We authenticate the new relay ourselves: the AUTH check in
   * `ntorClientFinish` is against the onion key the consensus gave us, so a hop that
   * connected us somewhere else cannot produce a reply that verifies.
   */
  async extend(relay: {
    address: string;
    orPort: number;
    identity: Uint8Array;
    ntorOnionKey: Uint8Array;
  }): Promise<void> {
    const octets = relay.address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !(n >= 0 && n <= 255))) {
      throw new Error(`extend needs an IPv4 address, got ${relay.address}`);
    }
    const ephemeralPriv = crypto.getRandomValues(new Uint8Array(32));
    const handshake = ntorClientRequest(relay.identity, relay.ntorOnionKey, ephemeralPriv);
    const body = extend2Body(
      Uint8Array.from(octets), relay.orPort, relay.identity, handshake,
    );
    // Stream id 0: EXTEND2 is addressed to the hop, not to any stream on it.
    await this.#send(RELAY.extend2, 0, body, { cellCommand: CMD.relayEarly });

    const reply = await this.#recv();
    if (reply.command !== RELAY.extended2) {
      throw new Error(`expected RELAY_EXTENDED2, got relay command ${reply.command}`);
    }
    const keys = ntorClientFinish(
      relay.identity, relay.ntorOnionKey, ephemeralPriv,
      extended2Reply(reply.data), 72,
    );
    if (keys.length === 0) {
      throw new Error(`ntor failed extending to ${relay.address}: it did not authenticate`);
    }
    this.#hops.push(hopInit(keys));
  }

  /** Return credit to the far end when we owe it, circuit first then stream. */
  async #considerSendmes(streamId: number): Promise<void> {
    while (this.#deliverWindow <= CIRCUIT_WINDOW - CIRCUIT_INCREMENT) {
      // Version 1 when we have a digest to prove we received the cells, which we always
      // should — the record happens one cell earlier. Falling back to an empty body would
      // be silently downgrading to the unauthenticated form, so refuse instead.
      if (this.#pendingSendmeDigest === null) {
        throw new Error("a circuit SENDME is due but no cell digest was recorded");
      }
      await this.#send(RELAY.sendme, 0, sendmeBodyV1(this.#pendingSendmeDigest));
      this.#pendingSendmeDigest = null;
      this.#deliverWindow += CIRCUIT_INCREMENT;
    }
    if (streamId === 0) return;
    const w = (this.#streamDeliver.get(streamId) ?? STREAM_WINDOW) - 1;
    this.#streamDeliver.set(streamId, w);
    if (w <= STREAM_WINDOW - STREAM_INCREMENT) {
      // Stream SENDMEs carry nothing: a stream's credit is bounded by its circuit's.
      await this.#send(RELAY.sendme, streamId, new Uint8Array(0));
      this.#streamDeliver.set(streamId, w + STREAM_INCREMENT);
    }
  }

  /**
   * Spend one cell of send credit, waiting for a SENDME if there is none.
   *
   * Waiting rather than throwing: running past the window is a protocol violation and the
   * far end tears the circuit down, so a client that ignored this would work until it sent
   * 1000 cells and then fail in a way that looked like a network problem.
   */
  async #spend(streamId: number): Promise<void> {
    while (this.#packageWindow <= 0 || (this.#streamPackage.get(streamId) ?? STREAM_WINDOW) <= 0) {
      // #recv credits any SENDME it sees and returns the next real cell. There is nothing
      // else to do with that cell here, so this only works because a caller mid-write is
      // not also mid-read — a limitation worth knowing about rather than hiding.
      const stray = await this.#recv();
      throw new Error(
        `blocked on flow control with a ${stray.command} cell pending — ` +
        "interleaved read and write is not supported",
      );
    }
    this.#packageWindow--;
    this.#streamPackage.set(streamId, (this.#streamPackage.get(streamId) ?? STREAM_WINDOW) - 1);
  }

  async write(streamId: number, data: Uint8Array): Promise<void> {
    // 498 bytes is what fits beside the eleven-byte relay header.
    for (let at = 0; at < data.length; at += 498) {
      await this.#spend(streamId);
      await this.#send(RELAY.data, streamId, data.slice(at, at + 498));
    }
  }

  /** Read the stream until the far end closes it. */
  async readToEnd(streamId: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (;;) {
      const cell = await this.#recv();
      if (cell.streamId !== streamId) continue;
      if (cell.command === RELAY.end) break;
      if (cell.command === RELAY.data) parts.push(cell.data);
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}
