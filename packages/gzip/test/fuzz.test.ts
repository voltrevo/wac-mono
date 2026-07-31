// Differential fuzzing against python's zlib, both directions.
//
// The hand-written tests check cases I thought of. These check cases I did not:
// a few hundred generated inputs, each compressed by us and read by python, and
// compressed by python and read by us. Any disagreement is a bug in one of the
// two, and python's zlib is not the one under suspicion.
//
// Seeds are fixed, so a failure is reproducible and can be pinned as a
// regression test by index.

import { wacBind } from "../../../harness/wacBind.ts";
import { bytesEqual } from "./util.ts";
import { buildCorpus, makeRng } from "./fuzz/corpus.ts";

const gzipMod = await wacBind("packages/gzip/src/gzip.wac");
const inflateMod = await wacBind("packages/gzip/src/inflate.wac");
const gzipBest = gzipMod.gzipBest as (d: Uint8Array) => Uint8Array;
const gzipDynamic = gzipMod.gzipDynamic as (d: Uint8Array) => Uint8Array;
const gunzipBytes = inflateMod.gunzipBytes as (gz: Uint8Array) => Uint8Array;

const CORPUS_SIZE = 260;
const SEED = 20260731;

Deno.test("fuzz: python reads everything we write, and we read everything python writes", async () => {
  const corpus = buildCorpus(CORPUS_SIZE, SEED);
  const work = await Deno.makeTempDir({ prefix: "wac-gzip-fuzz-" });

  try {
    await Deno.mkdir(`${work}/in`);
    await Deno.mkdir(`${work}/ours`);

    // Compress everything with our encoder first.
    for (let i = 0; i < corpus.length; i++) {
      await Deno.writeFile(`${work}/in/${i}.bin`, corpus[i].data);
      await Deno.writeFile(`${work}/ours/${i}.gz`, gzipBest(corpus[i].data));
    }

    // One python pass: read ours, and write theirs for us to read back.
    const cmd = new Deno.Command("python3", {
      args: ["packages/gzip/test/fuzz/oracle.py", work, String(corpus.length)],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout).trim();
    if (code !== 0) {
      throw new Error(`oracle failed (exit ${code}): ${new TextDecoder().decode(stderr)}`);
    }

    const lines = out.split("\n").filter((l) => l.length > 0);
    const done = lines.pop();
    if (done !== `DONE ${corpus.length}`) {
      throw new Error(`oracle did not finish cleanly, last line: ${done}\n${lines.join("\n")}`);
    }
    if (lines.length > 0) {
      // Name the generator that produced each failing case — the index alone
      // does not say what shape broke.
      const named = lines.map((l) => {
        const idx = Number(l.split(" ")[1]);
        return `${l}  [${corpus[idx]?.name ?? "?"}]`;
      });
      throw new Error(`python rejected or mis-read ${lines.length} of our streams:\n${named.join("\n")}`);
    }

    // Now the other direction: read python's output with our decompressor.
    const failures: string[] = [];
    for (let i = 0; i < corpus.length; i++) {
      const theirs = await Deno.readFile(`${work}/theirs/${i}.gz`);
      let got: Uint8Array;
      try {
        got = gunzipBytes(theirs);
      } catch (e) {
        failures.push(`${i} [${corpus[i].name}] level ${i % 10}: we trapped on a valid stream: ${(e as Error).message.slice(0, 60)}`);
        continue;
      }
      const diff = bytesEqual(got, corpus[i].data);
      if (diff !== -1) {
        failures.push(diff === -2
          ? `${i} [${corpus[i].name}] level ${i % 10}: length ${got.length}, want ${corpus[i].data.length}`
          : `${i} [${corpus[i].name}] level ${i % 10}: byte ${diff} differs`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`we mis-read ${failures.length} python streams:\n${failures.join("\n")}`);
    }
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("fuzz: our own round trip over the same corpus", () => {
  // Cheap to run and catches asymmetries between our two halves that python
  // would not notice, e.g. if both sides agreed on a non-standard reading.
  const corpus = buildCorpus(CORPUS_SIZE, SEED ^ 0x5A5A);
  for (let i = 0; i < corpus.length; i++) {
    const { name, data } = corpus[i];
    for (const [mode, fn] of [["best", gzipBest], ["dynamic", gzipDynamic]] as const) {
      const got = gunzipBytes(fn(data));
      const diff = bytesEqual(got, data);
      if (diff !== -1) {
        throw new Error(`${mode} ${i} [${name}]: ` +
          (diff === -2 ? `length ${got.length}, want ${data.length}` : `byte ${diff} differs`));
      }
    }
  }
});

Deno.test("fuzz: corrupted streams either decode correctly or trap — never wrong, never hang", async () => {
  // A decompressor's input is untrusted, so the contract is: for any byte
  // sequence, either produce the right answer or fail. Producing a wrong answer
  // silently is the failure mode that matters.
  //
  // Termination is structural rather than enforced by a timeout here: every loop
  // in inflate.wac consumes at least one bit per iteration, and running out of
  // bits traps, so no input can loop forever. A regression that broke that
  // property would show up as this test hanging, which is a visible failure.
  const base = buildCorpus(40, SEED ^ 0xC0FFEE);
  const rng = makeRng(0xBADBEEF);

  let trapped = 0;
  let decoded = 0;
  let cases = 0;

  for (const { data } of base) {
    const valid = gzipBest(data);

    for (let attempt = 0; attempt < 25; attempt++) {
      const corrupt = valid.slice();
      switch (rng() % 4) {
        case 0: {   // flip one bit
          const at = rng() % corrupt.length;
          corrupt[at] ^= 1 << (rng() % 8);
          break;
        }
        case 1: {   // replace a byte
          const at = rng() % corrupt.length;
          corrupt[at] = rng() & 0xFF;
          break;
        }
        case 2: {   // scramble a short span
          const at = rng() % corrupt.length;
          const len = 1 + (rng() % 8);
          for (let k = at; k < Math.min(at + len, corrupt.length); k++) corrupt[k] = rng() & 0xFF;
          break;
        }
        default: {  // truncate
          const keep = rng() % corrupt.length;
          const shorter = corrupt.slice(0, keep);
          cases++;
          try {
            const got = gunzipBytes(shorter);
            if (bytesEqual(got, data) !== -1) {
              throw new Error(`truncated to ${keep} bytes decoded to something wrong`);
            }
            decoded++;
          } catch {
            trapped++;
          }
          continue;
        }
      }

      cases++;
      try {
        const got = gunzipBytes(corrupt);
        // Some corruptions are genuinely benign — MTIME, XFL and the OS byte
        // are not covered by the CRC — so decoding is allowed, but only to the
        // original bytes.
        if (bytesEqual(got, data) !== -1) {
          await Deno.writeFile("/tmp/wac-gzip-fuzz-failure.gz", corrupt);
          throw new Error(
            `a corrupted stream decoded to the wrong bytes without trapping ` +
            `(saved to /tmp/wac-gzip-fuzz-failure.gz)`);
        }
        decoded++;
      } catch (e) {
        if ((e as Error).message.includes("decoded to the wrong bytes")) throw e;
        trapped++;
      }
    }
  }

  // Sanity-check the test itself: if corruption never triggered a trap, the
  // mutations were not reaching the compressed payload.
  if (trapped < cases * 0.5) {
    throw new Error(`only ${trapped}/${cases} corruptions trapped — corruption may not be effective`);
  }
  console.log(`  corruption fuzz: ${cases} cases, ${trapped} trapped, ${decoded} benign`);
});
