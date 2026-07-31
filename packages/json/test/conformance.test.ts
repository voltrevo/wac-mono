// JSONTestSuite: the standard parser conformance corpus.
//
// The mutation fuzz in invalid.test.ts compares against JSON.parse, which makes it
// a test of agreement rather than of conformance — and it only ever mutates ASCII,
// so nothing it generates can exercise UTF-8 validity. This corpus is the other
// thing: 318 documents with the correct answer encoded in the filename, including
// the cases real parsers get wrong.
//
// `i_` documents are implementation-defined; RFC 8259 permits either answer. They
// are still run, because a parser is required to terminate with an answer on them
// rather than trap or hang, and the behaviour is reported so a change to it is
// visible in the diff.

import { json, ERR } from "./util.ts";

// A plain path, not a URL: one document is named `n_structure_trailing_#.json`
// and `new URL` would read the `#` as a fragment separator.
const DIR = new URL(".", import.meta.url).pathname + "jsontestsuite/";

type Case = { name: string; bytes: Uint8Array; expect: "accept" | "reject" | "either" };

function load(): Case[] {
  const cases: Case[] = [];
  for (const entry of Deno.readDirSync(DIR)) {
    if (!entry.name.endsWith(".json")) continue;
    const bytes = Deno.readFileSync(DIR + entry.name);
    const prefix = entry.name.slice(0, 2);
    const expect = prefix === "y_" ? "accept" : prefix === "n_" ? "reject" : "either";
    cases.push({ name: entry.name, bytes, expect });
  }
  cases.sort((a, b) => a.name.localeCompare(b.name));
  return cases;
}

const CASES = load();

Deno.test("JSONTestSuite: the corpus is present and complete", () => {
  // A silently empty corpus would make every test below pass.
  if (CASES.length !== 318) {
    throw new Error(`expected 318 documents, found ${CASES.length}`);
  }
  const counts = { accept: 0, reject: 0, either: 0 };
  for (const c of CASES) counts[c.expect]++;
  if (counts.accept !== 95 || counts.reject !== 188 || counts.either !== 35) {
    throw new Error(`unexpected split: ${JSON.stringify(counts)}`);
  }
});

Deno.test("JSONTestSuite: every y_ document is accepted", async () => {
  const m = await json();
  const failures: string[] = [];
  for (const c of CASES) {
    if (c.expect !== "accept") continue;
    const err = m.errorCode(c.bytes);
    if (err !== ERR.NONE) failures.push(`${c.name}: rejected with code ${err}`);
  }
  if (failures.length) {
    throw new Error(`${failures.length} valid documents rejected:\n  ${failures.join("\n  ")}`);
  }
});

Deno.test("JSONTestSuite: every n_ document is rejected", async () => {
  const m = await json();
  const failures: string[] = [];
  for (const c of CASES) {
    if (c.expect !== "reject") continue;
    if (m.errorCode(c.bytes) === ERR.NONE) failures.push(c.name);
  }
  if (failures.length) {
    throw new Error(`${failures.length} invalid documents accepted:\n  ${failures.join("\n  ")}`);
  }
});

Deno.test("JSONTestSuite: accepted documents re-serialize to the same tree", async () => {
  // Accepting is only half of it — the value has to be right. Compared as parsed
  // trees rather than as text, since numbers are emitted from their source span
  // and JS reorders integer-like object keys.
  const m = await json();
  const dec = new TextDecoder();
  const failures: string[] = [];
  for (const c of CASES) {
    if (c.expect !== "accept") continue;
    const out = m.canonicalize(c.bytes);
    if (out[0] !== ERR.NONE) continue;      // covered by the test above
    const text = dec.decode(out.subarray(1));
    let ours: unknown, theirs: unknown;
    try {
      ours = JSON.parse(text);
    } catch (e) {
      failures.push(`${c.name}: emitted unparseable JSON (${(e as Error).message})`);
      continue;
    }
    try {
      theirs = JSON.parse(dec.decode(c.bytes));
    } catch {
      continue;                              // host disagrees; not this test's business
    }
    if (!deepEqual(ours, theirs)) {
      failures.push(`${c.name}: tree differs — ${text}`);
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} trees differ:\n  ${failures.slice(0, 15).join("\n  ")}`);
  }
});

Deno.test("JSONTestSuite: implementation-defined documents terminate with an answer", async () => {
  // The requirement here is only that nothing traps, hangs or reports nonsense.
  // The split is printed so that a change in behaviour shows up as a diff.
  const m = await json();
  let accepted = 0;
  const rejected = new Map<number, number>();
  for (const c of CASES) {
    if (c.expect !== "either") continue;
    const err = m.errorCode(c.bytes);
    if (err === ERR.NONE) accepted++;
    else rejected.set(err, (rejected.get(err) ?? 0) + 1);
  }
  const codes = [...rejected.entries()].sort((a, b) => a[0] - b[0])
    .map(([code, n]) => `${code}×${n}`).join(", ");
  console.log(`  i_: ${accepted} accepted, ${35 - accepted} rejected (${codes})`);
});

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(k =>
      Object.hasOwn(b as object, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
