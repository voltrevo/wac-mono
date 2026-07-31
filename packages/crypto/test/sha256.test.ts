// SHA-256 against the host's own implementation.
//
// WebCrypto is the oracle rather than a fixed vector list: it covers every
// length, and in particular the block-boundary cases where padding is easiest
// to get wrong (55/56/63/64/119/120 bytes). The published NIST vectors are
// checked too, since an oracle that shared a bug would hide it.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const sha256 = mod.sha256 as (m: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");

async function host(m: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", m as BufferSource)));
}

Deno.test("sha256: the published NIST vectors", async () => {
  const vectors: [string, string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
     "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    ["abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
     "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"],
  ];
  for (const [msg, want] of vectors) {
    const got = hex(sha256(new TextEncoder().encode(msg)));
    if (got !== want) throw new Error(`sha256(${JSON.stringify(msg)})\n  got  ${got}\n  want ${want}`);
  }
});

Deno.test("sha256: a million 'a' — the long NIST vector", () => {
  const m = new Uint8Array(1_000_000).fill(0x61);
  const got = hex(sha256(m));
  const want = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
  if (got !== want) throw new Error(`million-a: got ${got}`);
});

Deno.test("sha256: agrees with WebCrypto on every length through two blocks", async () => {
  for (let n = 0; n <= 130; n++) {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = (i * 37 + 11) & 0xFF;
    const got = hex(sha256(m));
    const want = await host(m);
    if (got !== want) throw new Error(`length ${n}: got ${got}, want ${want}`);
  }
});

Deno.test("sha256: agrees with WebCrypto on random inputs", async () => {
  let s = 0x2545F491;
  const rnd = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF; out[i] = (s >>> 13) & 0xFF; }
    return out;
  };
  for (let k = 0; k < 120; k++) {
    const m = rnd((s >>> 7) % 4000);
    const got = hex(sha256(m));
    const want = await host(m);
    if (got !== want) throw new Error(`random ${k} (len ${m.length}): got ${got}`);
  }
});
