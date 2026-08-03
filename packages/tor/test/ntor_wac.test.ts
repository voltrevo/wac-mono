// Registers the wac-side ntor tests, and supplies tor's own implementation as the oracle.
//
// `test-ntor-cl server1` is the relay half of the handshake as the C implementation computes
// it — the strongest check available for this file, because everything else in it is a
// relation between our own outputs and could not notice them being consistently wrong.
//
// ## Why the answers are committed
//
// This used to shell out to the binary and *fail* when it was missing, on the reasoning that
// a differential which silently stops running is worse than one never written. The reasoning
// was right and the implementation was wrong: the binary lived in `/tmp`, so when the
// container was recreated the fixture vanished and this package turned the shared suite red
// for three agents who had not touched it.
//
// "Fail forever" is not the fix for "might silently stop running" — *durable* is. tor's
// answers are recorded in `data/ntor_vectors.json` and committed, so the differential runs
// on every machine with no binary and no network. When the binary *is* present its live
// answer is used instead, so the check also sees changes in tor.
//
// A recorded answer is not weaker than a live one here, which is worth spelling out. Each
// vector is a complete (reply, keys) pair that tor produced, and the assertion is that our
// client derives *those keys* from *that reply*. That is the same assertion either way; the
// vector is not an expected output of our code, it is an input from tor's.
//
// Note the relay's ephemeral key is random, so tor answers differently every run. There is
// deliberately no recorded-versus-live comparison: it would fail every time and mean
// nothing.
//
// Regenerate with `TOR_NTOR_REGEN=1 deno test -A packages/tor/test/ntor_wac.test.ts` after
// building the binary with `tools/tor.sh`.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

/**
 * Where the binary lives if it has been built.
 *
 * Under `$HOME` rather than `/tmp`: three agents share this filesystem and `/tmp` does not
 * survive the container being recreated, which is exactly how the old default failed.
 */
const TOR_NTOR = Deno.env.get("TOR_NTOR_CL") ??
  `${Deno.env.get("HOME")}/tor-build/torproject-tor-c8d2b17/src/test/test-ntor-cl`;

const VECTORS = new URL("./data/ntor_vectors.json", import.meta.url);
const REGEN = Deno.env.get("TOR_NTOR_REGEN") === "1";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.trim().match(/../g)!.map((h) => parseInt(h, 16)));

const haveBinary = (() => {
  try {
    return Deno.statSync(TOR_NTOR).isFile;
  } catch {
    return false;
  }
})();

type Vector = { b: string; id: string; msg: string; keyLen: number; out: string };

const recorded: Vector[] = await (async () => {
  try {
    return JSON.parse(await Deno.readTextFile(VECTORS)) as Vector[];
  } catch {
    return [];
  }
})();

const keyOf = (b: string, id: string, msg: string, keyLen: number) =>
  `${b}|${id}|${msg}|${keyLen}`;
const byKey = new Map(recorded.map((v) => [keyOf(v.b, v.id, v.msg, v.keyLen), v.out]));
const produced: Vector[] = [];

/** tor's relay half: `server1 b nodeID msg N` prints the reply then the keys, in hex. */
function runBinary(b: string, id: string, msg: string, keyLen: number): string {
  const out = new Deno.Command(TOR_NTOR, {
    args: ["server1", b, id, msg, String(keyLen)],
  }).outputSync();
  const text = new TextDecoder().decode(out.stdout).trim();
  if (out.code !== 0 || text.length === 0) {
    throw new Error(`${TOR_NTOR} server1 failed with code ${out.code}`);
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines[0] + lines[1];
}

/**
 * The oracle the wac test calls: tor's live answer when the binary is here, the recorded one
 * otherwise.
 *
 * The two are not compared. tor picks a fresh ephemeral key for every handshake, so its
 * reply differs on every run and a recorded-versus-live check would fail constantly while
 * detecting nothing. What actually checks our code is the wac assertion downstream: derive
 * keys from whichever reply arrived, and require them to equal the keys tor derived
 * alongside it.
 */
function server1(bRaw: Uint8Array, idRaw: Uint8Array, msgRaw: Uint8Array, keyLen: number) {
  const [b, id, msg] = [hex(bRaw), hex(idRaw), hex(msgRaw)];
  const k = keyOf(b, id, msg, keyLen);
  const known = byKey.get(k);

  if (haveBinary) {
    const live = runBinary(b, id, msg, keyLen);
    produced.push({ b, id, msg, keyLen, out: live });
    return unhex(live);
  }

  if (known === undefined) {
    throw new Error(
      `no recorded answer for ${k} and no tor binary at ${TOR_NTOR}.\n` +
      `  A new case needs its vector recorded: build with tools/tor.sh, then\n` +
      `  TOR_NTOR_REGEN=1 deno test -A packages/tor/test/ntor_wac.test.ts`,
    );
  }
  return unhex(known);
}

await wacTestRun("packages/tor/test/wac/ntor_test.wac", "ntor", [server1]);

Deno.test("ntor: the differential ran against something", () => {
  // The check the old hard-fail was reaching for, kept but made durable. It fails when there
  // is neither a vector nor a binary, and not merely when the binary is absent.
  if (recorded.length === 0 && !haveBinary) {
    throw new Error(
      "no ntor vectors are committed and no tor binary is present, so the only " +
      "differential in this file checked nothing",
    );
  }
});

if (REGEN) {
  Deno.test("ntor: vectors written", async () => {
    if (!haveBinary) throw new Error(`cannot regenerate without ${TOR_NTOR}`);
    await Deno.writeTextFile(VECTORS, JSON.stringify(produced, null, 2) + "\n");
    console.log(`wrote ${produced.length} vectors to ${VECTORS.pathname}`);
  });
}
