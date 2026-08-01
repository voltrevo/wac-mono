// Randomised differential testing against Node's URL.
//
// The hand-written cases in `url.test.ts` cover what I thought to write down. This covers what I
// did not: strings assembled from URL-shaped fragments, so that punctuation lands in combinations
// nobody would choose on purpose — a `@` inside a query, a `:` where a path is expected, three
// slashes where the scheme wanted two.
//
// Seeded, so a failure is reproducible from the seed printed in the message alone.

import { wacBind } from "../../../harness/wacBind.ts";
import { agreed, type Case, type Parsed } from "./oracle.ts";

const mod = await wacBind("packages/url/test/probe.wac") as unknown as {
  parse(input: Uint8Array): Uint8Array;
  parseWithBase(input: Uint8Array, base: Uint8Array): Uint8Array;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function wac(input: string, base?: string): Parsed {
  const out = base === undefined
    ? mod.parse(enc.encode(input))
    : mod.parseWithBase(enc.encode(input), enc.encode(base));
  const p = dec.decode(out).split("\0");
  if (p[0] !== "1") return { ok: false };
  return {
    ok: true,
    href: p[1],
    protocol: p[2] + ":",
    username: p[3],
    password: p[4],
    hostname: p[5],
    port: p[6],
    pathname: p[7],
    search: p[8],
    hash: p[9],
  };
}

const FIELDS = ["href", "protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"] as const;

function makeRng(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

/**
 * Fragments to assemble inputs from.
 *
 * Deliberately not "random characters": a uniformly random string is rejected by both sides
 * almost every time, which tests only the rejection path. Fragments keep the inputs plausible
 * enough to reach the states that matter, while still combining in ways nobody would write.
 */
const SCHEMES = ["http", "https", "file", "ftp", "ws", "wss", "foo", "a+b", "A", ""];
const SEPS = [":", "://", ":/", ":///", "://///", ":\\\\", "", ":/\\"];
const USERINFO = ["", "u@", "u:p@", ":@", "@", "u:@", "%40@", "a b@", "u:p@x@"];
const HOSTS = [
  "h", "example.com", "EXAMPLE.com", "", "127.0.0.1", "0x7f.1", "2130706433", "[::1]", "[::",
  "1.2.3.4.5", "0x", "a b", "a%20b", "a|b", "localhost", "..", "a..b", "-", "%2e",
];
const PORTS = ["", ":80", ":443", ":0", ":65535", ":65536", ":", ":abc", ":-1", ":8080"];
const PATHS = [
  "", "/", "//", "/a", "/a/b", "/a/../b", "/..", "/.", "/a/./b", "\\a", "/a\\b", "/%2e%2e/",
  "/ ", "/\"", "/<>", "/`", "/{}", "/%", "/%zz", "/%41", "/c:/x", "/c|/x", "/\u00e9", "/\u65e5",
];
const QUERIES = ["", "?", "?a", "?a=b", "?a'b", "?a b", "?#", "?%", "?\u00e9"];
const FRAGMENTS = ["", "#", "#f", "#a b", "#\"", "#\u00e9", "#a#b"];

const BASES = [
  undefined,
  "http://example.com/a/b?q#f",
  "file:///a/b",
  "foo://host/p",
  "foo:opaque",
  "https://u:p@h:8080/x/y",
];

function pick<T>(next: () => number, xs: T[]): T {
  return xs[next() % xs.length];
}

function generate(next: () => number): string {
  // Occasionally emit a bare reference rather than something scheme-shaped, because that is
  // what exercises relative resolution.
  if (next() % 4 === 0) {
    return pick(next, PATHS) + pick(next, QUERIES) + pick(next, FRAGMENTS);
  }
  return pick(next, SCHEMES) + pick(next, SEPS) + pick(next, USERINFO) +
    pick(next, HOSTS) + pick(next, PORTS) + pick(next, PATHS) +
    pick(next, QUERIES) + pick(next, FRAGMENTS);
}

/**
 * Compare `count` generated inputs against whatever both runtimes agree on.
 *
 * The skipped count is asserted rather than ignored. If a change to the generators pushed most
 * cases into the disagreement bucket, every remaining comparison could pass while testing almost
 * nothing, and the run would still look green.
 */
async function sweep(seed: number, count: number, maxSkippedFraction = 0.15): Promise<void> {
  const next = makeRng(seed);
  const cases: Case[] = [];
  for (let i = 0; i < count; i++) {
    cases.push({ input: generate(next), base: pick(next, BASES) });
  }
  const { want, skipped } = await agreed(cases);

  const bad: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const w = want[i];
    if (w === null) continue;                       // the runtimes disagree; not evidence
    const c = cases[i];
    const got = wac(c.input, c.base);
    const label = c.base === undefined
      ? JSON.stringify(c.input)
      : `${JSON.stringify(c.input)} against ${JSON.stringify(c.base)}`;
    if (got.ok !== w.ok) {
      bad.push(`${label}: wac ${got.ok ? "accepted" : "rejected"}, both runtimes ${w.ok ? "accepted" : "rejected"}`);
      continue;
    }
    if (!w.ok) continue;
    for (const f of FIELDS) {
      if (got[f] !== w[f]) {
        bad.push(`${label}: ${f} was ${JSON.stringify(got[f])}, both runtimes say ${JSON.stringify(w[f])}`);
        break;
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `seed ${seed}: ${bad.length}/${cases.length - skipped.length} disagreed:\n  ${bad.slice(0, 20).join("\n  ")}`,
    );
  }
  const fraction = skipped.length / cases.length;
  if (fraction > maxSkippedFraction) {
    throw new Error(
      `seed ${seed}: the runtimes disagreed on ${skipped.length}/${cases.length} cases ` +
      `(${(fraction * 100).toFixed(1)}%), above the ${(maxSkippedFraction * 100).toFixed(0)}% ` +
      `this test allows — the oracle has become too thin to mean much. First few:\n  ` +
      skipped.slice(0, 5).map(i => JSON.stringify(cases[i])).join("\n  "),
    );
  }
}

Deno.test("fuzz: assembled URLs agree with Node", async () => {
  await sweep(0x1234abcd, 4000);
});

Deno.test("fuzz: a second seed, in case the first is lucky", async () => {
  await sweep(0x5150cafe, 4000);
});

Deno.test("fuzz: bare references against every base", async () => {
  // Relative resolution specifically, where the base's own shape decides most of the answer.
  const next = makeRng(0x0badf00d);
  const cases: Case[] = [];
  for (let i = 0; i < 2000; i++) {
    cases.push({
      input: pick(next, PATHS) + pick(next, QUERIES) + pick(next, FRAGMENTS),
      base: BASES[1 + (next() % (BASES.length - 1))],
    });
  }
  const { want, skipped } = await agreed(cases);
  const bad: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const w = want[i];
    if (w === null) continue;
    const got = wac(cases[i].input, cases[i].base);
    const label = `${JSON.stringify(cases[i].input)} against ${JSON.stringify(cases[i].base)}`;
    if (got.ok !== w.ok) {
      bad.push(`${label}: wac ${got.ok ? "accepted" : "rejected"}, both runtimes ${w.ok ? "accepted" : "rejected"}`);
    } else if (w.ok && got.href !== w.href) {
      bad.push(`${label}: href was ${JSON.stringify(got.href)}, both runtimes say ${JSON.stringify(w.href)}`);
    }
  }
  if (bad.length > 0) {
    throw new Error(`${bad.length}/${cases.length - skipped.length} disagreed:\n  ${bad.slice(0, 20).join("\n  ")}`);
  }
});
