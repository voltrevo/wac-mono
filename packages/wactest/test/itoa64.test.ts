// Differential test: JS BigInt is the oracle for decimal formatting.
import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);

Deno.test("itoa64/utoa64 agree with BigInt over boundaries and random values", () => {
  const u = mod.u as (n: bigint) => string;
  const i = mod.i as (n: bigint) => string;

  const uCases = [0n, 1n, 9n, 10n, 99n, 100n, 4294967295n, 4294967296n,
    9223372036854775807n, 9223372036854775808n, 18446744073709551615n];
  for (const n of uCases) {
    if (u(n) !== n.toString()) throw new Error(`utoa64(${n}) = ${u(n)}`);
  }
  const iCases = [0n, 1n, -1n, 10n, -10n, 9223372036854775807n, -9223372036854775808n];
  for (const n of iCases) {
    if (i(n) !== n.toString()) throw new Error(`itoa64(${n}) = ${i(n)}`);
  }

  // Random 64-bit patterns, read both ways.
  let s = 12345n;
  for (let k = 0; k < 400; k++) {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
    const asU = s;
    const asI = BigInt.asIntN(64, s);
    if (u(asU) !== asU.toString()) throw new Error(`utoa64(${asU}) = ${u(asU)}`);
    if (i(asI) !== asI.toString()) throw new Error(`itoa64(${asI}) = ${i(asI)}`);
  }
});
