// Shrink a failing divmod case to the smallest operands that still disagree with BigInt.
//
// Kept because the first real bug in this package was a division digit that only a
// specific limb pattern reached, and reasoning about the code did not find it — the
// minimal case did, in one step.
//
//   deno run -A packages/bignum/tools/shrink.ts <dividend> <divisor>

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bignum/test/probe.wac") as unknown as {
  opDiv(a: Uint8Array, b: Uint8Array): Uint8Array;
  opRem(a: Uint8Array, b: Uint8Array): Uint8Array;
};
const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (v: bigint): Uint8Array => enc.encode(v.toString());

const bad = (x: bigint, y: bigint): boolean => {
  if (y === 0n) return false;
  try {
    const q = dec.decode(mod.opDiv(b(x), b(y)));
    const r = dec.decode(mod.opRem(b(x), b(y)));
    return q !== (x / y).toString() || r !== (x % y).toString();
  } catch {
    return true;
  }
};

let a = BigInt(Deno.args[0] ?? "0xffffffff00000000ffffffff00000000ffffffff00000000ffffffff00000000");
let d = BigInt(Deno.args[1] ?? "0xfffffffffffffffffffffffe");
if (!bad(a, d)) {
  console.log("that pair already agrees with BigInt");
  Deno.exit(1);
}

/** Drop whole limbs off each operand while the disagreement survives. */
let changed = true;
while (changed) {
  changed = false;
  for (const shift of [32n * 4n, 32n, 1n]) {
    while (true) {
      const na = a >> shift;
      if (na > 0n && bad(na, d)) { a = na; changed = true; } else break;
    }
    while (true) {
      const nd = d >> shift;
      if (nd > 0n && bad(a, nd)) { d = nd; changed = true; } else break;
    }
  }
  // Then try clearing low limbs to zero, which usually simplifies the pattern.
  for (let i = 0n; i < 8n; i++) {
    const mask = ~(0xffffffffn << (32n * i));
    const na = a & mask ? a & ~(0xffffffffn << (32n * i)) : a;
    if (na !== a && na > 0n && bad(na, d)) { a = na; changed = true; }
  }
}

console.log(`dividend 0x${a.toString(16)}  limbs ${limbs(a).join(" ")}`);
console.log(`divisor  0x${d.toString(16)}  limbs ${limbs(d).join(" ")}`);
console.log(`got  q ${dec.decode(mod.opDiv(b(a), b(d)))}`);
console.log(`want q ${a / d}`);
console.log(`got  r ${dec.decode(mod.opRem(b(a), b(d)))}`);
console.log(`want r ${a % d}`);

function limbs(x: bigint): string[] {
  const out: string[] = [];
  let v = x;
  while (v > 0n) {
    out.unshift("0x" + (v & 0xffffffffn).toString(16).padStart(8, "0"));
    v >>= 32n;
  }
  return out.length > 0 ? out : ["0x00000000"];
}
