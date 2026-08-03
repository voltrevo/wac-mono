// Concurrent reads must not share a destination buffer.
//
// While exactly one host call could be outstanding, every chunked read in the Deno world
// wrote into one shared 64KB buffer and that was safe. With a ring of slots two reads hand
// the kernel the same memory: the second write lands on top of the first, and whichever
// resolves later returns a length spanning both.
//
// It surfaced once in `nc` — the peer received `"peer speaks first\nnd"`, its own greeting
// with the tail of the client's message behind it — and then passed eight runs.
//
// **This drives the world's handlers directly rather than a built program.** A first
// attempt went through `example/whichever.wac` with two peers answering at once, and it
// passed even with the bug deliberately put back: nothing about running a wac program
// guarantees the two reads are ever pending *simultaneously*, which is what the race needs.
// `Promise.all` over the two handlers guarantees exactly that.

import { denoWorld } from "../host/deno.ts";
import { i32le, readI32le, str } from "../host/call.ts";
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

/** A listener that writes `body` once someone connects, then holds the connection. */
function speaker(body: string): { port: number; close: () => void; done: Promise<void> } {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  let conn: Deno.Conn | null = null;
  const done = (async () => {
    try {
      conn = await l.accept();
      await conn.write(new TextEncoder().encode(body));
      await new Promise((r) => setTimeout(r, 1500));
    } catch { /* closed under us */ }
  })();
  return {
    port,
    close: () => {
      try { conn?.close(); } catch { /* already */ }
      try { l.close(); } catch { /* already */ }
    },
    done,
  };
}

Deno.test("two concurrent recvs each get their own bytes", async () => {
  // Distinct characters and distinct lengths, so an overlay shows up as the wrong text *or*
  // the wrong length rather than as something that still looks plausible.
  const a = speaker("A".repeat(120));
  const b = speaker("B".repeat(300));
  const w = denoWorld({ net: true });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike>) =>
    await w[op](payload as Uint8Array) as Uint8Array;
  const headed = (port: number, host: string) => {
    const h = str(host);
    const out = new Uint8Array(4 + h.length);
    out.set(i32le(port), 0);
    out.set(h, 4);
    return out;
  };

  try {
    const ha = readI32le(await call(OP.CONNECT, headed(a.port, "127.0.0.1")));
    const hb = readI32le(await call(OP.CONNECT, headed(b.port, "127.0.0.1")));

    // Both in flight before either resolves. This is the whole point of the test.
    const [ra, rb] = await Promise.all([
      call(OP.RECV, i32le(ha)),
      call(OP.RECV, i32le(hb)),
    ]);
    const sa = new TextDecoder().decode(ra);
    const sb = new TextDecoder().decode(rb);

    assertEquals(/^A+$/.test(sa), true, `socket A's bytes were overlaid: ${sa.slice(0, 80)}`);
    assertEquals(/^B+$/.test(sb), true, `socket B's bytes were overlaid: ${sb.slice(0, 80)}`);
    assertEquals(sa.length, 120, `socket A returned ${sa.length} bytes, not 120`);
    assertEquals(sb.length, 300, `socket B returned ${sb.length} bytes, not 300`);

    await call(OP.CLOSE_SOCKET, i32le(ha));
    await call(OP.CLOSE_SOCKET, i32le(hb));
  } finally {
    a.close();
    b.close();
    await Promise.allSettled([a.done, b.done]);
  }
});

Deno.test("a recv and a chunked file read do not collide either", async () => {
  // The same buffer served `readChunk` and `recv`, so the collision is not only
  // socket-to-socket: a program streaming a file while talking to a peer hits it too.
  const file = await Deno.makeTempFile({ prefix: "wac-alias-" });
  const peer = speaker("P".repeat(500));
  const w = denoWorld({ net: true, fs: { read: true } });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  try {
    await Deno.writeTextFile(file, "F".repeat(9000));
    const h = str("127.0.0.1");
    const dial = new Uint8Array(4 + h.length);
    dial.set(i32le(peer.port), 0);
    dial.set(h, 4);
    const hp = readI32le(await call(OP.CONNECT, dial));
    await call(OP.OPEN_INPUT, str(file));

    const [fromFile, fromPeer] = await Promise.all([
      call(OP.READ_CHUNK),
      call(OP.RECV, i32le(hp)),
    ]);
    const sf = new TextDecoder().decode(fromFile);
    const sp = new TextDecoder().decode(fromPeer);

    assertEquals(/^F+$/.test(sf), true, `the file read was overlaid: ${sf.slice(0, 80)}`);
    assertEquals(/^P+$/.test(sp), true, `the socket read was overlaid: ${sp.slice(0, 80)}`);
    assertEquals(sf.length, 9000, `the file read returned ${sf.length} bytes, not 9000`);
    assertEquals(sp.length, 500, `the socket read returned ${sp.length} bytes, not 500`);

    await call(OP.CLOSE_SOCKET, i32le(hp));
  } finally {
    peer.close();
    await Promise.allSettled([peer.done]);
    await Deno.remove(file);
  }
});
