// RLP in TypeScript, for the trie oracle beside it.
//
// A second implementation on purpose. `packages/rlp` is the one under test elsewhere and is checked against
// Ethereum's own `RLPTests`; this one exists so the *builder* that produces proofs does not share code with
// the *verifier* that consumes them. Twenty lines, and the fixtures' published roots are what say both are
// right — a trie root is `keccak256(rlp(node))` all the way down, so a wrong RLP here cannot produce a
// matching root.

export type RlpItem = Uint8Array | RlpItem[];

function header(len: number, short: number, long: number): Uint8Array {
  if (len <= 55) return new Uint8Array([short + len]);
  const be: number[] = [];
  for (let x = len; x > 0; x = Math.floor(x / 256)) be.unshift(x & 0xff);
  return new Uint8Array([long + be.length, ...be]);
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    // A single byte below 0x80 is itself; that is the canonical form, not an optimisation.
    if (item.length === 1 && item[0] < 0x80) return item;
    const head = header(item.length, 0x80, 0xb7);
    const out = new Uint8Array(head.length + item.length);
    out.set(head, 0);
    out.set(item, head.length);
    return out;
  }
  const parts = item.map(rlpEncode);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const head = header(total, 0xc0, 0xf7);
  const out = new Uint8Array(head.length + total);
  out.set(head, 0);
  let at = head.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
