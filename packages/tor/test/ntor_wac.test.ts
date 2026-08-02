// Registers the wac-side ntor tests, and supplies tor's own implementation as the oracle.
//
// `test-ntor-cl server1` is the relay half of the handshake as the C implementation
// computes it — the strongest check available for this file, because everything else in it
// is a relation between our own outputs and could not notice them being consistently
// wrong.
//
// The binary is built by `tools/tor.sh` and is not committed. When it is missing the
// oracle returns nothing, the test says so and fails rather than passing quietly: a
// differential that silently stops running is worse than one that was never written,
// because the suite still reports green. Set TOR_SKIP_INTEROP=1 to opt out deliberately.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const TOR_NTOR = Deno.env.get("TOR_NTOR_CL") ??
  "/tmp/tor-build/torproject-tor-c8d2b17/src/test/test-ntor-cl";

const have = (() => {
  try {
    return Deno.statSync(TOR_NTOR).isFile;
  } catch {
    return false;
  }
})();

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.trim().match(/../g)!.map(h => parseInt(h, 16)));

/** tor's relay half: `server1 b nodeID msg N` prints the reply then the keys, in hex. */
function server1(b: Uint8Array, id: Uint8Array, msg: Uint8Array, keyLen: number): Uint8Array {
  if (!have) return new Uint8Array(0);
  const out = new Deno.Command(TOR_NTOR, {
    args: ["server1", hex(b), hex(id), hex(msg), String(keyLen)],
  }).outputSync();
  const text = new TextDecoder().decode(out.stdout).trim();
  if (out.code !== 0 || text.length === 0) return new Uint8Array(0);
  const lines = text.split("\n").filter((l) => l.length > 0);
  return new Uint8Array([...unhex(lines[0]), ...unhex(lines[1])]);
}

if (!have && !Deno.env.get("TOR_SKIP_INTEROP")) {
  Deno.test("ntor: tor's implementation is available as an oracle", () => {
    throw new Error(
      `${TOR_NTOR} is missing, so the only differential in this file cannot run.\n` +
      `  Build it with tools/tor.sh, or set TOR_SKIP_INTEROP=1 to accept the gap.`);
  });
}

await wacTestRun("packages/tor/test/wac/ntor_test.wac", "ntor", [server1]);
