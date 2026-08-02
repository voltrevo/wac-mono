// A circuit you can open a stream on.
//
// `link.ts` gets you a CREATE2 and 72 bytes of key material. This turns that into something
// that carries data: relay cells in both directions, and a stream on top of them.
//
// ## One hop
//
// A real client uses three, and extends to the second and third with RELAY_EXTEND2 cells
// sent through the hops already built — which is the property that makes Tor Tor, since no
// single relay learns both who you are and where you are going. This builds one, which is
// enough to exercise every layer below it and provides no anonymity whatsoever. Extending
// is the next piece of work, not a missing detail.
//
// ## Flow control is not implemented
//
// Tor windows both circuits and streams: 1000 cells per circuit and 500 per stream before
// the sender must stop and wait for a SENDME. This code answers SENDMEs it receives and
// never sends any, which is fine for responses under 500 cells and wrong above it — the
// exit will stop sending and the read will hang rather than fail. Issue 0013.

import { wacBind } from "../../../harness/wacBind.ts";
import { CMD, type Link, readCell } from "./link.ts";

const mod = await wacBind("packages/tor/test/wac/link_probe.wac");
const hopInit = mod.hopInit as (material: Uint8Array) => Uint8Array;
const hopSend = mod.hopSend as (
  state: Uint8Array, cmd: number, streamId: number, data: Uint8Array,
) => Uint8Array;
const hopRecv = mod.hopRecv as (state: Uint8Array, payload: Uint8Array) => Uint8Array;
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
} as const;

/** Why a stream ended, from tor-spec §6.3. Enough of them to make a message worth reading. */
const END_REASONS: Record<number, string> = {
  1: "misc", 2: "resolve failed", 3: "connection refused", 4: "exit policy",
  5: "destroy", 6: "done", 7: "timeout", 8: "no route", 9: "hibernating",
  10: "internal", 11: "resource limit", 12: "connection reset", 13: "tor protocol violation",
  14: "not a directory",
};

export class Circuit {
  #link: Link;
  #circId: number;
  #hop: Uint8Array;
  #nextStreamId = 1;

  constructor(link: Link, circId: number, material: Uint8Array) {
    this.#link = link;
    this.#circId = circId;
    this.#hop = hopInit(material);
  }

  /** Send one relay cell down the circuit. */
  async #send(command: number, streamId: number, data: Uint8Array): Promise<void> {
    const r = hopSend(this.#hop, command, streamId, data);
    this.#hop = r.slice(0, hopStateLen);
    await this.#link.conn.write(
      encodeFixed(this.#circId, CMD.relay, r.slice(hopStateLen)),
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

      const r = hopRecv(this.#hop, cellPayload(cell, 0));
      this.#hop = r.slice(0, hopStateLen);
      if (r[hopStateLen] !== 1) {
        throw new Error("a relay cell failed its digest — the circuit is out of step");
      }
      const body = r.slice(hopStateLen + 1);
      const command = relayCommand(body);
      // A SENDME is the peer giving us room to send more. We do not track a window, so
      // there is nothing to credit; swallow it rather than handing it to the caller as data.
      if (command === RELAY.sendme) continue;
      return { command, streamId: relayStreamId(body), data: relayPayload(body) };
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

  async write(streamId: number, data: Uint8Array): Promise<void> {
    // 498 bytes is what fits beside the eleven-byte relay header.
    for (let at = 0; at < data.length; at += 498) {
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
