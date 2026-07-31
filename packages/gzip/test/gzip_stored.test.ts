// The real test of a gzip writer is whether gzip itself accepts the output.
// These shell out to the system `gunzip`, so a malformed header, a wrong CRC, a
// wrong ISIZE, or bad block framing all fail here rather than being reasoned
// about.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/gzip/src/gzip.wac");
const gzipStored = mod.gzipStored as (data: Uint8Array) => Uint8Array;

/** Decompress with the system gunzip; throws if it rejects the stream. */
async function systemGunzip(gz: Uint8Array): Promise<Uint8Array> {
  const cmd = new Deno.Command("gunzip", {
    args: ["-c"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(gz);
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`gunzip rejected the stream (exit ${code}): ${new TextDecoder().decode(stderr)}`);
  }
  return stdout;
}

async function roundTrip(name: string, input: Uint8Array): Promise<void> {
  const gz = gzipStored(input);
  const out = await systemGunzip(gz);
  if (out.length !== input.length) {
    throw new Error(`${name}: gunzip gave ${out.length} bytes, expected ${input.length}`);
  }
  for (let i = 0; i < input.length; i++) {
    if (out[i] !== input[i]) {
      throw new Error(`${name}: byte ${i} differs — got ${out[i]}, expected ${input[i]}`);
    }
  }
}

Deno.test("gzipStored: header is a well-formed gzip header", () => {
  const gz = gzipStored(new TextEncoder().encode("hello"));
  const want = [0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 255];
  for (let i = 0; i < want.length; i++) {
    if (gz[i] !== want[i]) {
      throw new Error(`header byte ${i}: got ${gz[i]}, expected ${want[i]}`);
    }
  }
});

Deno.test("gzipStored: trailer carries the CRC-32 and ISIZE", () => {
  const input = new TextEncoder().encode("hello world");
  const gz = gzipStored(input);
  const dv = new DataView(gz.buffer, gz.byteOffset, gz.byteLength);
  const crc = dv.getUint32(gz.length - 8, true);
  const isize = dv.getUint32(gz.length - 4, true);
  if (crc !== 222957957) throw new Error(`trailer CRC: got ${crc}, expected 222957957`);
  if (isize !== input.length) throw new Error(`ISIZE: got ${isize}, expected ${input.length}`);
});

Deno.test("gzipStored: gunzip accepts it — round trips", async () => {
  await roundTrip("empty", new Uint8Array(0));
  await roundTrip("one byte", new Uint8Array([0]));
  await roundTrip("hello world", new TextEncoder().encode("hello world"));
  await roundTrip("all 256 byte values", Uint8Array.from({ length: 256 }, (_, i) => i));
});

Deno.test("gzipStored: multi-block input crosses the 65535 boundary", async () => {
  // 65535 is the largest single stored block, so these exercise 1, 2 and 3
  // blocks and the final-block flag landing on the right one.
  for (const n of [65534, 65535, 65536, 131070, 131071]) {
    const input = new Uint8Array(n);
    for (let i = 0; i < n; i++) input[i] = (i * 131 + 17) & 0xFF;
    await roundTrip(`${n} bytes`, input);
  }
});

Deno.test("gzipStored: incompressible and highly repetitive data both survive", async () => {
  const repetitive = new TextEncoder().encode("ab".repeat(5000));
  await roundTrip("repetitive", repetitive);

  // Deterministic pseudo-random bytes — a stored block must not care either way.
  const random = new Uint8Array(20000);
  let s = 12345;
  for (let i = 0; i < random.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    random[i] = (s >>> 16) & 0xFF;
  }
  await roundTrip("pseudo-random", random);
});
