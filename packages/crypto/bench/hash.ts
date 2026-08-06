// Throughput for the four hashes, in MB/s, against `node:crypto` where it has the same function.
//
//     deno task bench:hash
//
// A number with no baseline says nothing, so SHA-256 and SHA-512 are reported beside Node's — which is
// OpenSSL, i.e. hand-written assembly with SHA extensions where the CPU has them. The useful reading is
// the ratio and how it moves, not the absolute figure: wac has no SIMD here and is not going to catch it.
//
// keccak256 has no baseline at all, because nothing on a normal machine implements it — see
// `packages/crypto/README.md`. SHA3-256 does, and is the closest thing to one.
//
// The message is built and hashed inside wasm. Handing 36 MB across bindgen would measure the boundary: it
// copies an array with one exported call per element. wac has no mutable module-level state, so the probe
// cannot build the input once and keep it — it builds per call, and **the build is timed separately and
// subtracted**, because a PRNG byte at a time over 36 MB costs about as much as hashing it. Without that
// subtraction every hash here looked 2-3x slower than it is, which is the trap in benchmarking through a
// boundary you cannot allocate across.

import { createCipheriv, createHash } from "node:crypto";
import { wacBind } from "../../../harness/wacBind.ts";

const probe = await wacBind("packages/crypto/test/wac/bench_probe.wac") as Record<string, unknown>;
const build = probe.benchBuild as (n: number) => Uint8Array;
const fns: [string, (n: number) => Uint8Array][] = [
  ["sha256", probe.benchSha256 as (n: number) => Uint8Array],
  ["sha512", probe.benchSha512 as (n: number) => Uint8Array],
  ["keccak256", probe.benchKeccak as (n: number) => Uint8Array],
  ["sha3-256", probe.benchSha3 as (n: number) => Uint8Array],
  ["chacha20", probe.benchChacha as (n: number) => Uint8Array],
];

const MB = 1024 * 1024;
const sizes = Deno.args.includes("--quick") ? [4] : [1, 8, 36];

/** The same message the probe builds, so the host baseline hashes the same bytes. */
function message(n: number): Uint8Array {
  const m = new Uint8Array(n);
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7FFFFFFF;
    m[i] = (x >> 16) & 0xff;
  }
  return m;
}

const best = (f: () => void, runs = 3) => {
  let ms = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    ms = Math.min(ms, performance.now() - t);
  }
  return ms;
};

for (const [name, fn] of fns) {
  fn(1024); // warm
  for (const mb of sizes) {
    const n = mb * MB;
    const buildMs = best(() => build(n));
    const ms = Math.max(0.001, best(() => fn(n)) - buildMs);
    const host = name === "keccak256" ? null : name === "sha3-256" ? "sha3-256" : name;
    let baseline = "";
    if (name === "chacha20") {
      // Node has no bare `chacha20`, only the AEAD — so the baseline includes Poly1305 over the same
      // bytes, which makes it *slower* than the cipher alone. It is a floor on OpenSSL, not its speed.
      const bytes = message(n);
      const key = new Uint8Array(32).map((_, i) => i);
      const hostMs = best(() => {
        const c = createCipheriv("chacha20-poly1305", key, new Uint8Array(12), { authTagLength: 16 });
        c.update(bytes);
        c.final();
      });
      baseline = `   node ${(mb / (hostMs / 1000)).toFixed(0)} MB/s  (${(ms / hostMs).toFixed(1)}x slower, +poly1305)`;
    } else if (host !== null) {
      const bytes = message(n);
      const hostMs = best(() => { createHash(host).update(bytes).digest(); });
      baseline = `   node ${(mb / (hostMs / 1000)).toFixed(0)} MB/s  (${(ms / hostMs).toFixed(1)}x slower)`;
    }
    console.log(`${name.padEnd(10)} ${String(mb).padStart(3)} MB  ${ms.toFixed(1).padStart(7)} ms  ` +
      `${(mb / (ms / 1000)).toFixed(0).padStart(4)} MB/s${baseline}`);
  }
}
