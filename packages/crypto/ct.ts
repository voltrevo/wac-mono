// Regenerate the side-channel table in README.md.
//
//   deno run -A packages/crypto/ct.ts
//
// Every routine is run with several structured secrets and the same public input, and
// the ordered trace of branches and memory indices is compared. The table this prints
// is what belongs in the README — published figures that cannot be regenerated go stale
// silently, which is what `issues/open/0007` is about, and this file exists so that does
// not happen to these ones.
//
// `test/constanttime.test.ts` asserts the *conclusions* — what is uniform, and where the
// known leaks are. This prints the numbers behind them.

import { allDivergentSites, ctModule, type CtModule, traceOf } from "../../harness/ctTrace.ts";

const bytes = (m: CtModule, b: number[]): unknown => {
  const a = m.exports.$bind$arr_u8_new(b.length);
  b.forEach((v, i) => m.exports.$bind$arr_u8_set(a, i, v));
  return a;
};

const KEYS16 = [
  Array(16).fill(0x00),
  Array(16).fill(0xFF),
  Array.from({ length: 16 }, (_, i) => (i * 37) & 255),
  [0x80, ...Array(15).fill(0)],
];
const KEYS32 = KEYS16.map((k) => [...k, ...k]);
const BLOCK = Array.from({ length: 16 }, (_, i) => i);

type Case = { name: string; entry: string; keys: number[][]; run: (m: CtModule, k: number[]) => void };

const CASES: Case[] = [
  { name: "sha256", entry: "packages/crypto/src/sha256.wac", keys: KEYS16,
    run: (m, k) => { m.exports.sha256(bytes(m, k)); } },
  { name: "chachaBlock", entry: "packages/crypto/src/chacha20.wac", keys: KEYS32,
    run: (m, k) => { m.exports.chachaBlock(bytes(m, k), 1, bytes(m, Array(12).fill(1))); } },
  { name: "poly1305", entry: "packages/crypto/src/poly1305.wac", keys: KEYS32,
    run: (m, k) => { m.exports.poly1305(bytes(m, k), bytes(m, BLOCK)); } },
  // Two scalars only: 1.6M events per run, and the point is made without four of them.
  { name: "x25519Base", entry: "packages/crypto/src/x25519.wac", keys: KEYS32.slice(0, 2),
    run: (m, k) => { m.exports.x25519Base(bytes(m, k)); } },
  { name: "ghash", entry: "packages/crypto/src/ghash.wac", keys: KEYS16,
    run: (m, k) => { m.exports.ghash(bytes(m, k), bytes(m, BLOCK)); } },
  { name: "aesExpandKey", entry: "packages/crypto/src/aes.wac", keys: KEYS16,
    run: (m, k) => { m.exports.aesExpandKey(bytes(m, k)); } },
  { name: "aesEncrypt", entry: "packages/crypto/src/aes.wac", keys: KEYS16,
    run: (m, k) => { m.exports.aesEncrypt(bytes(m, k), bytes(m, BLOCK)); } },
  // One round and two passwords: a single bcrypt hash is already 129 key expansions, so the
  // event count dwarfs everything above and a third password would say nothing more.
  //
  // Included even though the answer is known in advance — bcrypt indexes its S-boxes with state
  // derived from the password, by design — because "we did not measure it" and "it is fine" look
  // identical in a table that omits the row.
  { name: "bcryptPbkdf", entry: "packages/crypto/src/bcryptpbkdf.wac", keys: KEYS16.slice(0, 2),
    run: (m, k) => { m.exports.bcryptPbkdf(bytes(m, k), bytes(m, BLOCK), 32, 1); } },
];

console.log("| routine | events per run | result |");
console.log("|---|---:|---|");

for (const c of CASES) {
  const m = await ctModule(c.entry);
  const base = traceOf(m, () => c.run(m, c.keys[0]));
  if (base.events.length === 0) throw new Error(`${c.name}: no events — did the call happen?`);
  // A routine can be too expensive to trace at all. `TRACE_SLOTS` is 2^22 events and lives in the
  // compiler, so it is not ours to raise; a KDF is *designed* to cost more than that and no
  // parameter brings it under. Say so in the table rather than dropping the row, because an
  // omitted routine and a clean one look identical to a reader. See wac issue 0059.
  if (base.truncated) {
    console.log(`| \`${c.name}\` | >4,194,304 | **not measured** — trace exceeds the compiler's ` +
                `event buffer, which a KDF's cost is meant to |`);
    continue;
  }

  const sites = new Map<string, string>();
  let stopped = false;
  for (let i = 1; i < c.keys.length; i++) {
    const r = allDivergentSites(m, base, traceOf(m, () => c.run(m, c.keys[i])));
    stopped ||= r.stoppedAtPathSplit;
    for (const d of r.sites) sites.set(`${d.file}:${d.line}`, d.kind);
  }
  const n = base.events.length.toLocaleString("en-US");
  if (sites.size === 0) {
    console.log(`| \`${c.name}\` | ${n} | uniform |`);
    continue;
  }
  // Two different claims: an index leak is located exactly, a path split only says
  // where one run stood when they stopped agreeing.
  const idx = [...sites.entries()].filter(([, k]) => k === "index")
    .map(([at]) => `\`${at.replace("packages/crypto/src/", "")}\``);
  const parts: string[] = [];
  if (idx.length > 0) parts.push(`secret-dependent index at ${idx.join(", ")}`);
  if (stopped) parts.push("control flow diverges; not examined past that");
  console.log(`| \`${c.name}\` | ${n} | **leaks** — ${parts.join("; ")} |`);
}
