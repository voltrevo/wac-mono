// TorSocket: the boundary where a circuit's cells meet a socket's buffers.
//
// The two sides disagree about who owns memory. A circuit hands over whole relay cells; a
// socket reader asks for however much fits in the buffer it brought. Everything here is
// about the leftovers, because losing them is silent — the caller gets a short read, which
// is legal, and the missing bytes never come back.

import { TorSocket } from "../host/socket.ts";
import type { Circuit } from "../host/circuit.ts";

function assertEquals<T>(got: T, want: T, msg?: string): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg ?? "assertEquals failed"}\n  got:  ${g}\n  want: ${w}`);
}

/** A circuit that hands back the chunks it was given, then ends the stream. */
function fakeCircuit(chunks: Uint8Array[]): { circuit: Circuit; written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  const queue = [...chunks];
  const circuit = {
    read: (_id: number) => Promise.resolve(queue.shift() ?? null),
    write: (_id: number, data: Uint8Array) => {
      written.push(data);
      return Promise.resolve();
    },
    endStream: (_id: number) => Promise.resolve(),
  } as unknown as Circuit;
  return { circuit, written };
}

const bytes = (...n: number[]) => Uint8Array.from(n);

Deno.test("a read smaller than the cell keeps the remainder for next time", () => {
  const { circuit } = fakeCircuit([bytes(1, 2, 3, 4, 5)]);
  const s = new TorSocket(circuit, 1);
  const p = new Uint8Array(2);
  return (async () => {
    assertEquals(await s.read(p), 2);
    assertEquals([...p], [1, 2], "first two bytes");
    assertEquals(await s.read(p), 2);
    assertEquals([...p], [3, 4], "the next two, not a re-read of the first");
    assertEquals(await s.read(p), 1, "and a short read for the tail");
    assertEquals(p[0], 5);
    assertEquals(await s.read(p), null, "then end of stream");
  })();
});

Deno.test("a read larger than the cell returns what there is, not a wait for more", async () => {
  // A socket read is allowed to return less than asked for, and must: waiting to fill the
  // buffer would deadlock a protocol whose next byte depends on our reply.
  const { circuit } = fakeCircuit([bytes(1, 2), bytes(3, 4, 5)]);
  const s = new TorSocket(circuit, 1);
  const p = new Uint8Array(64);
  assertEquals(await s.read(p), 2, "the first cell only");
  assertEquals(await s.read(p), 3, "then the second");
  assertEquals(await s.read(p), null);
});

Deno.test("every byte survives an awkward read size", async () => {
  // Sizes that share no factor with the chunk lengths, so the boundaries never line up.
  const chunks = [3, 7, 11, 1, 500].map((n, c) =>
    Uint8Array.from({ length: n }, (_, i) => (i + c * 31) & 0xFF)
  );
  const expected = chunks.flatMap((c) => [...c]);
  for (const size of [1, 2, 5, 13, 64, 1024]) {
    const { circuit } = fakeCircuit(chunks.map((c) => c.slice()));
    const s = new TorSocket(circuit, 1);
    const got: number[] = [];
    for (;;) {
      const p = new Uint8Array(size);
      const n = await s.read(p);
      if (n === null) break;
      got.push(...p.subarray(0, n));
    }
    assertEquals(got, expected, `reading ${size} bytes at a time`);
  }
});

Deno.test("end of stream is reported once and stays reported", async () => {
  const { circuit } = fakeCircuit([]);
  const s = new TorSocket(circuit, 1);
  const p = new Uint8Array(8);
  assertEquals(await s.read(p), null);
  assertEquals(await s.read(p), null, "asking again does not block or resurrect the stream");
});

Deno.test("a write reports everything written, because the circuit does not short-write", async () => {
  const { circuit, written } = fakeCircuit([]);
  const s = new TorSocket(circuit, 7);
  const data = new Uint8Array(1500);
  assertEquals(await s.write(data), 1500, "the caller is not asked to loop");
  assertEquals(written.length, 1, "handed to the circuit whole; it splits across cells");
});

Deno.test("closing twice sends one RELAY_END", () => {
  let ends = 0;
  const circuit = {
    endStream: () => {
      ends++;
      return Promise.resolve();
    },
  } as unknown as Circuit;
  const s = new TorSocket(circuit, 1);
  s.close();
  s.close();
  assertEquals(ends, 1, "a second close is a no-op, not a second cell on a dead stream");
});
