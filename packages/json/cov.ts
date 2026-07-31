// Branch coverage for json.
//
// The exercises are deliberately the same ones the test suite runs — the vendored
// JSONTestSuite corpus, the mutation seeds, the number corpora — because coverage
// measured against a *different* workload tells you about that workload, not about
// what the tests actually check.
//
//   deno task coverage:json
//   deno task coverage:json --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/json/src/json.wac");
const canonicalize = run.mod.canonicalize as (b: Uint8Array) => Uint8Array;
const errorCode = run.mod.errorCode as (b: Uint8Array) => number;
const errorPos = run.mod.errorPos as (b: Uint8Array) => number;
const parseNumberValue = run.mod.parseNumberValue as (b: Uint8Array) => number;

/** Every document in the conformance corpus, which is the broadest input set. */
const DIR = "packages/json/test/jsontestsuite/";
for (const entry of Deno.readDirSync(DIR)) {
  if (!entry.name.endsWith(".json")) continue;
  const bytes = Deno.readFileSync(DIR + entry.name);
  canonicalize(bytes);
  errorCode(bytes);
  errorPos(bytes);
}

/** The number paths, which the corpus barely touches. */
for (
  const s of [
    "0", "-0", "1", "1.5", "-2.25", "1e5", "1E-5", "1e+5", "0.1",
    "9007199254740993", "1e308", "1e309", "1e-400", "5e-324",
    "123456789012345678901234567890", "0.1234567890123456789012345",
    "1.7976931348623157e308", "2.2250738585072011e-308", "1e23",
  ]
) {
  parseNumberValue(enc.encode(s));
  canonicalize(enc.encode(s));
}

/**
 * The failure paths of parseNumberValue.
 *
 * Added because coverage found them unexercised *here* while number.test.ts covers
 * them — the standing hazard of this file: it is a second workload written by hand,
 * so it drifts from the suite it is meant to measure.
 */
for (const s of ["", "[", "1 2", "01", "-", "1e", '"1"', "true", "null", "[1]", '{"a":1}']) {
  parseNumberValue(enc.encode(s));
}

/** Escapes and UTF-8, including the paths that reject. */
for (
  const s of [
    '"\\u0041\\n\\t\\r\\b\\f\\/\\\\\\""', '"\\ud83d\\ude00"', '"\\ud83d"', '"\\udc00"',
    '"\\ud83dx"', '"\\u00e9"', '"café 日本 😀"',
    '"\\uZZZZ"', '"\\u12"', '"\\q"', '"unterminated', '"a\tb"',
  ]
) canonicalize(enc.encode(s));

/** Raw byte sequences: control bytes and malformed UTF-8, which no text source gives. */
for (
  const body of [
    [0x81], [0xC3], [0xC3, 0x28], [0xC0, 0x80], [0xED, 0xA0, 0x80],
    [0xF5, 0x80, 0x80, 0x80], [0xF4, 0x90, 0x80, 0x80], [0xE0, 0x80, 0x80],
    [0xC2, 0x80], [0xEF, 0xBF, 0xBF], [0xF4, 0x8F, 0xBF, 0xBF], [0x01],
    // A valid lead with a bad *later* continuation byte, which reaches the loop
    // rather than the first range check.
    [0xE6, 0x97, 0x41], [0xF0, 0x9F, 0x41, 0x80], [0xF0, 0x9F, 0x98, 0x41],
  ]
) errorCode(new Uint8Array([0x22, ...body, 0x22]));

/** Sequences cut off by the end of input, with no closing quote to reject them. */
for (const body of [[0xC3], [0xE6], [0xE6, 0x97], [0xF0], [0xF0, 0x9F, 0x98]]) {
  errorCode(new Uint8Array([0x22, ...body]));
}

/** Depth, both inside and past the limit. */
for (const d of [1, 399, 400, 500]) {
  errorCode(enc.encode("[".repeat(d) + "]".repeat(d)));
}

/** Containers big enough to grow several times, and lookup hits and misses. */
canonicalize(enc.encode(`[${Array.from({ length: 200 }, (_, i) => i).join(",")}]`));
canonicalize(enc.encode(`{${Array.from({ length: 200 }, (_, i) => `"k${i}":${i}`).join(",")}}`));
canonicalize(enc.encode('{"a":1,"a":2}'));

/**
 * The wac-written tests are a second entry point.
 *
 * Much of `value.wac` — the container accessors, the string-typed edge, lookup by key
 * — is reachable only from wac, not from the four exports json.wac offers the host. A
 * report over the public API alone shows those as dead, which is the opposite of the
 * truth: they are tested, just not from here.
 */
const testRun = await instrument("packages/json/test/wac/json_test.wac");
for (const [name, fn] of Object.entries(testRun.mod)) {
  if (!name.startsWith("test") || typeof fn !== "function") continue;
  const failure = (fn as () => string)();
  if (failure !== "") throw new Error(`${name} failed during coverage: ${failure}`);
}

/** The bounds traps, which need one call each from the host to observe. */
const bounds = await instrument("packages/json/test/bounds.wac");
for (const name of ["arrayPastEnd", "arrayNegative", "objectPastEnd", "objectNegative", "arrayOk"]) {
  try { (bounds.mod[name] as () => number)(); } catch { /* the trap is the point */ }
}

const { total, covered } = report([run, testRun, bounds], "packages/json/", { verbose });
if (covered < total) Deno.exit(0); // reporting tool, not a gate
