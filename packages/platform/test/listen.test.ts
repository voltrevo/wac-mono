// Which interfaces a server binds, and who it says connected.
//
// `listen` took a port and nothing else, so the host bound `0.0.0.0` and every server written on this
// platform was reachable from every interface — wac-mono issue 0025. For most servers that is a
// deployment surprise; for `packages/tor`'s SOCKS proxy it was the difference between serving the
// person at the keyboard and running an open proxy that sources strangers' traffic out of somebody
// else's exit node.
//
// Driven against the handler table rather than through a built program, because what is being checked
// is the boundary: the address exists on the host side, and the question is whether it survives the
// crossing. The connections are made by Deno itself, which is the only honest way to ask "is this
// reachable from there" — a wac client would prove the same thing twice.

import { denoWorld } from "../host/deno.ts";
import { i32le, readI32le, str, unstr } from "../host/call.ts";
import { OP } from "../host/ops.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** The `listen` payload: the port, then the address. Empty means every interface. */
function listenPayload(address: string, port: number): Uint8Array {
  const host = str(address);
  const out = new Uint8Array(4 + host.length);
  out.set(i32le(port), 0);
  out.set(host, 4);
  return out;
}

/**
 * This machine's own non-loopback address, or null when it has none.
 *
 * The point of the test is the difference between two interfaces, so a host with only loopback cannot
 * answer it — and skipping is honest where inventing an address would not be.
 */
function ownAddress(): string | null {
  // `networkInterfaces` needs `--allow-sys`, which the shared suite deliberately withholds — see the
  // note in `browser_live.test.ts`. Without it the interface question cannot be asked, so the checks
  // that need a second interface stand down and the loopback ones still run. Asked rather than caught,
  // because a thrown permission error looks like a failure in the logs.
  if (Deno.permissions.querySync({ name: "sys", kind: "networkInterfaces" }).state !== "granted") {
    return null;
  }
  for (const nic of Deno.networkInterfaces()) {
    if (nic.family === "IPv4" && nic.address !== "127.0.0.1") return nic.address;
  }
  return null;
}

/** Whether a TCP connection to this address and port is accepted, within a moment. */
async function reachable(address: string, port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: address, port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

Deno.test("a listener bound to loopback is not reachable from another interface — 0025", async () => {
  const outside = ownAddress();
  const w = denoWorld({ net: true });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike>) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  // Port 0 is not usable here: the handler answers with a handle rather than with the port it got, so
  // the test picks one and would rather fail loudly on a clash than silently test nothing.
  const port = 45871;
  const listener = readI32le(await call(OP.LISTEN, listenPayload("127.0.0.1", port)));
  assertEquals(listener >= 1, true, "a handle");
  try {
    assertEquals(await reachable("127.0.0.1", port), true, "loopback should reach it");
    if (outside !== null) {
      assertEquals(
        await reachable(outside, port),
        false,
        `${outside} should not reach a loopback listener — this is the whole issue`,
      );
    }
  } finally {
    await call(OP.CLOSE_SOCKET, i32le(listener));
  }
});

Deno.test("...and an empty address still binds every interface, which is what it always did", async () => {
  const outside = ownAddress();
  if (outside === null) return;   // only loopback here; there is no second interface to ask about
  const w = denoWorld({ net: true });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike>) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  const port = 45872;
  const listener = readI32le(await call(OP.LISTEN, listenPayload("", port)));
  try {
    assertEquals(await reachable("127.0.0.1", port), true, "loopback");
    assertEquals(await reachable(outside, port), true, `${outside}`);
  } finally {
    await call(OP.CLOSE_SOCKET, i32le(listener));
  }
});

Deno.test("accept says who connected", async () => {
  // A server could not log its peer, rate-limit by source, or refuse a connection that did not come
  // from this machine — the address was dropped at the boundary. That last check is what makes a bind
  // to every interface survivable, and `Socket.fromLoopback` is written against this.
  const w = denoWorld({ net: true });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike>) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  const port = 45873;
  const listener = readI32le(await call(OP.LISTEN, listenPayload("127.0.0.1", port)));
  try {
    const pending = call(OP.ACCEPT, i32le(listener));
    const client = await Deno.connect({ hostname: "127.0.0.1", port });
    const accepted = await pending;
    // A handle, then the peer's address — the shape `Socket` decodes.
    assertEquals(readI32le(accepted) >= 1, true, "a handle for the accepted socket");
    assertEquals(unstr(accepted.subarray(4)), "127.0.0.1", "the peer, from the host");
    client.close();
  } finally {
    await call(OP.CLOSE_SOCKET, i32le(listener));
  }
});

Deno.test("...and a socket this program dialled has no peer to report", async () => {
  // `connect` and `listen` answer with the handle alone: the peer of an outgoing socket is the address
  // the caller passed, and repeating it back would be a second copy of the caller's own argument.
  const server = Deno.listen({ hostname: "127.0.0.1", port: 45874 });
  const accepting = server.accept().then((c) => c.close());
  const w = denoWorld({ net: true });
  const payload = (port: number, host: string) => {
    const h = str(host);
    const out = new Uint8Array(4 + h.length);
    out.set(i32le(port), 0);
    out.set(h, 4);
    return out;
  };
  try {
    const out = await w[OP.CONNECT](payload(45874, "127.0.0.1")) as Uint8Array;
    assertEquals(readI32le(out) >= 1, true, "a handle");
    assertEquals(unstr(out.subarray(4)), "", "no peer for an outgoing socket");
    await w[OP.CLOSE_SOCKET](i32le(readI32le(out)));
  } finally {
    await accepting;
    server.close();
  }
});
