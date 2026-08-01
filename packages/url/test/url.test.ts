// URL parsing, judged against Node's URL.
//
// The oracle is exact and total: for any input it either produces a URL whose nine components
// are all readable, or throws. So every case here is a comparison, and there is nothing to
// hand-write and nothing to argue about.
//
// Node rather than Deno's own `new URL`, because the two disagree — and neither is right
// everywhere. Node is right on the file-URL cases and Deno on one relative-resolution case, each
// against the standard's own text. Those five inputs are held in DIVERGENCES below with the rule
// that decides them, and excluded from the bulk comparisons; everything else is judged against
// Node, which is the closer of the two.
//
// Components are compared individually, not just the href. A parser can put the right bytes in
// the wrong field — a password read as a host, a query folded into the path — and still produce
// an identical href, so href-only agreement would hide a whole class of bug.
//
// IDNA is not implemented (see the package README), so cases whose host is non-ASCII are
// expected to diverge. They are asserted as *known* divergences rather than skipped: if the gap
// ever closes, or widens, this notices.

import { wacBind } from "../../../harness/wacBind.ts";
import { type Case, denoOracle, oracle, type Parsed } from "./oracle.ts";

const mod = await wacBind("packages/url/test/probe.wac") as unknown as {
  parse(input: Uint8Array): Uint8Array;
  parseWithBase(input: Uint8Array, base: Uint8Array): Uint8Array;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Split the NUL-separated record the probe returns. */
function wac(input: string, base?: string): Parsed {
  const out = base === undefined
    ? mod.parse(enc.encode(input))
    : mod.parseWithBase(enc.encode(input), enc.encode(base));
  const parts = dec.decode(out).split("\0");
  if (parts[0] !== "1") return { ok: false };
  return {
    ok: true,
    href: parts[1],
    protocol: parts[2] + ":",
    username: parts[3],
    password: parts[4],
    hostname: parts[5],
    port: parts[6],
    pathname: parts[7],
    search: parts[8],
    hash: parts[9],
  };
}

const FIELDS = [
  "href",
  "protocol",
  "username",
  "password",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;

/** The first field on which wac and the oracle disagree, or null. */
function disagreement(c: Case, got: Parsed, want: Parsed): string | null {
  const where = c.base === undefined
    ? JSON.stringify(c.input)
    : `${JSON.stringify(c.input)} against ${JSON.stringify(c.base)}`;
  if (got.ok !== want.ok) {
    return `${where}: wac ${got.ok ? "accepted" : "rejected"}, oracle ${want.ok ? "accepted" : "rejected"}`;
  }
  if (!want.ok) return null;
  for (const f of FIELDS) {
    if (got[f] !== want[f]) {
      return `${where}: ${f} was ${JSON.stringify(got[f])}, oracle says ${JSON.stringify(want[f])}`;
    }
  }
  return null;
}

/**
 * Inputs where the two runtimes disagree, with the answer the standard gives.
 *
 * Excluded from the bulk comparisons and asserted separately, because comparing them against
 * either runtime would assert something untrue. `wanted` is derived from the standard's text,
 * cited in `why`, not from whichever runtime happens to agree.
 */
const DIVERGENCES: Array<{ c: Case; wanted: string; why: string }> = [
  {
    c: { input: "file:///c|/x" },
    wanted: "file:///c:/x",
    why: "path state: scheme is file, path is empty and buffer is a Windows drive letter, so the second code point becomes ':'",
  },
  {
    c: { input: "file:////a" },
    wanted: "file:////a",
    why: "file host state consumes the third slash as an empty host; the fourth starts an empty first segment",
  },
  {
    c: { input: "file://\\\\a" },
    wanted: "file:////a",
    why: "a backslash is a slash for a special scheme, so this is file:////a",
  },
  {
    c: { input: "\\d", base: "foo://host/p" },
    wanted: "foo://host/\\d",
    why: "a backslash is only a segment separator when the scheme is special, and it is not in the path percent-encode set",
  },
  {
    c: { input: "..", base: "foo://host/p" },
    wanted: "foo://host/",
    why: "path state, double-dot: shorten, then append the empty string because c is not '/' — so the path is [\"\"], which serializes as '/'",
  },
];

const DIVERGENT = new Set(DIVERGENCES.map(d => `${d.c.input}\u0000${d.c.base ?? ""}`));

async function checkAll(rawInputs: string[], base?: string): Promise<void> {
  const inputs = rawInputs.filter(i => !DIVERGENT.has(`${i}\u0000${base ?? ""}`));
  const cases: Case[] = inputs.map(input => ({ input, base }));
  const want = await oracle(cases);
  const bad: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const d = disagreement(cases[i], wac(cases[i].input, cases[i].base), want[i]);
    if (d !== null) bad.push(d);
  }
  if (bad.length > 0) {
    throw new Error(`${bad.length}/${inputs.length} disagreed:\n  ${bad.slice(0, 15).join("\n  ")}`);
  }
}

Deno.test("absolute URLs with every component", async () => {
  await checkAll([
    "http://example.com/",
    "https://example.com:8443/a/b?c=d#e",
    "http://user@example.com/",
    "http://user:pw@example.com/",
    "http://:pw@example.com/",
    "http://example.com",
    "http://example.com?q",
    "http://example.com#f",
    "http://example.com/?#",
    "ws://h/", "wss://h/", "ftp://h/",
  ]);
});

Deno.test("scheme handling: case, default ports, unknown schemes", async () => {
  await checkAll([
    "HTTP://example.com/",
    "HtTpS://Example.COM/",
    "http://example.com:80/",
    "https://example.com:443/",
    "ftp://example.com:21/",
    "ws://example.com:80/",
    "wss://example.com:443/",
    "http://example.com:8080/",
    "http://example.com:0/",
    "http://example.com:65535/",
    // Non-special schemes take neither the slash handling nor a default port.
    "foo://example.com/",
    "foo:/path",
    "foo:path",
    "foo:",
    "mailto:a@b.c",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "a+b-c.d://h/",
  ]);
});

Deno.test("ports that are not ports", async () => {
  await checkAll([
    "http://h:65536/",
    "http://h:99999999/",
    "http://h:abc/",
    "http://h:/",
    "http://h:-1/",
    "http://h: 80/",
  ]);
});

Deno.test("path normalisation: dots, empty segments, backslashes", async () => {
  await checkAll([
    "http://h/a/b/../c",
    "http://h/a/b/./c",
    "http://h/../../..",
    "http://h/a/..",
    "http://h/a/../",
    "http://h/.",
    "http://h/./",
    "http://h//a//b//",
    "http://h/a/%2e/b",
    "http://h/a/%2E%2e/b",
    "http://h/a/.%2e/b",
    "http://h\\a\\b",
    "http://h/a\\b",
    // A backslash is only a slash for a special scheme.
    "foo://h/a\\b",
    "foo://h/a/../b",
  ]);
});

Deno.test("percent-encoding by component", async () => {
  await checkAll([
    'http://h/ "<>`{}',
    "http://h/?\" <>#",
    "http://h/?a'b",
    "foo://h/?a'b",
    "http://h/#\" <>`",
    "http://h/%41%42",
    "http://h/%zz",
    "http://h/%",
    "http://h/%a",
    "http://user na:me@h/",
    "http://h/a?b#c d",
    "http://h/\u0001\u001f",
    // Multi-byte UTF-8 in each component that allows it.
    "http://h/caf\u00e9",
    "http://h/?caf\u00e9",
    "http://h/#caf\u00e9",
    "http://h/\u65e5\u672c",
    "http://h/\ud83d\ude00",
  ]);
});

Deno.test("hosts: IPv4 in all its spellings", async () => {
  await checkAll([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://127.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0300.0250.0.1/",
    "http://1.2.3.4./",
    "http://0/",
    "http://0x/",
    "http://256.1.1.1/",
    "http://1.2.3.4.5/",
    "http://999999999999/",
    "http://0x100000000/",
    "http://1.2.3.09/",
    "http://1.2.3.0x/",
  ]);
});

Deno.test("hosts: IPv6", async () => {
  await checkAll([
    "http://[::1]/",
    "http://[::]/",
    "http://[1:2:3:4:5:6:7:8]/",
    "http://[1::8]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[2001:db8::1]:8080/",
    "http://[1:2:3:4:5:6:7:8:9]/",
    "http://[1::2::3]/",
    "http://[::1",
    "http://[]/",
    "http://[:]/",
    "http://[1:2:3:4:5:6:7]/",
    "http://[::ffff:999.1.1.1]/",
  ]);
});

Deno.test("hosts: names, empty, and forbidden bytes", async () => {
  await checkAll([
    "http://example.com/",
    "http://EXAMPLE.COM/",
    "http://sub.domain.example.com/",
    "http://h%65llo/",
    "http:///",
    "http://:80/",
    "http://a b/",
    "http://a#b/",
    "http://a<b/",
    "http://a|b/",
    "http://a%2fb/",
    "foo://a b/",
    "foo://a%20b/",
    "http://.../",
    "http://a..b/",
  ]);
});

Deno.test("file URLs", async () => {
  await checkAll([
    "file:///a/b",
    "file://localhost/a",
    "file://LOCALHOST/a",
    "file://host/a",
    "file:///",
    "file://",
    "file:",
    "file:/a",
    "file:a",
    "file:///c:/x",
    "file:///c|/x",
    "file://c:/x",
    "file:///C:/",
    "file:///c:",
    "file:////a",
    "file:///a/../b",
    "file://\\\\a",
  ]);
});

Deno.test("relative resolution against a base", async () => {
  const bases = [
    "http://example.com/a/b/c?q#f",
    "http://example.com/",
    "https://user:pw@host:8080/p/q",
    "file:///a/b/c",
    "foo://host/p",
    "foo:opaque",
  ];
  const refs = [
    "",
    "d",
    "/d",
    "//other.com/d",
    "../d",
    "../../d",
    "../../../d",
    "./d",
    "?q2",
    "#f2",
    "?",
    "#",
    "http://absolute.example/x",
    "//h",
    "\\d",
    "a:b",
    ".",
    "..",
  ];
  for (const base of bases) await checkAll(refs, base);
});

Deno.test("edges the main groups miss", async () => {
  // Added from a coverage report: each of these is the only input in the suite that reaches some
  // branch. Written as differential cases like everything else, so they pin behaviour and not
  // merely execution.
  await checkAll([
    // A path with no host that starts with an empty segment, which the serializer has to protect
    // with `/.` or it would re-parse as an authority.
    "foo:/.//x",
    "foo:/..//x",
    "web+demo:/.//not-a-host/",
    // IPv4 with too many parts, and a last part past its own range.
    "http://1.2.3.4.5.6/",
    "http://1.2.3.256/",
    "http://1.2.65536/",
    "http://1.16777216/",
    // IPv6 dotted-quad forms that stop short or run long.
    "http://[::ffff:1.2.3]/",
    "http://[::ffff:1.2.3.4.5]/",
    "http://[::ffff:.1.2.3]/",
    "http://[::ffff:1.2.3.]/",
    "http://[1:2:3:4:5:6:1.2.3.4]/",
    "http://[1:2:3:4:5:6:7:1.2.3.4]/",
    // Non-special path start, where the first byte is neither a slash nor a terminator.
    "foo://h?q",
    "foo://h#f",
    "foo://h",
    // Windows drive letters reached through a base rather than written out.
    "..",
    "/x",
    "x",
  ]);
  for (const base of ["file:///c:/a/b", "file:///c:", "file://h/c:/x"]) {
    await checkAll(["..", "/x", "x", "../..", "d:/y", "/d:/y"], base);
  }
});

Deno.test("whitespace and control bytes are stripped, not rejected", async () => {
  await checkAll([
    "  http://h/  ",
    "\thttp://h/",
    "ht\ntp://h/",
    "http://h/a\tb",
    "http://h/a\rb",
    "\u0000http://h/",
    "http://h/ ",
  ]);
});

Deno.test("inputs that must be rejected", async () => {
  await checkAll([
    "",
    "   ",
    "http",
    "://h/",
    "http:",
    "1http://h/",
    "http://",
    "http://:@/",
    "//h/",
    "/a/b",
    "a/b",
  ]);
});

/**
 * IDNA is the one known gap, and this pins its exact shape.
 *
 * A non-ASCII domain should be mapped through UTS-46 ToASCII, which needs Unicode tables. It is
 * rejected instead. Asserted rather than skipped so that the day it is implemented, or the day
 * something else starts rejecting these for a different reason, the test says so.
 */
Deno.test("known divergence: a non-ASCII domain is rejected rather than mapped", async () => {
  const cases = ["http://caf\u00e9.com/", "http://\u65e5\u672c.jp/"];
  const want = await oracle(cases.map(input => ({ input })));
  const unexpected: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    if (wac(cases[i]).ok) {
      unexpected.push(`${cases[i]}: wac accepted a non-ASCII domain, so IDNA may have landed`);
    }
    if (!want[i].ok) {
      unexpected.push(`${cases[i]}: the oracle rejected it too, so this is no longer a divergence`);
    }
  }
  // An already-punycoded domain is ASCII, so it needs no mapping and must agree.
  await checkAll(["http://xn--caf-dma.com/"]);
  if (unexpected.length > 0) throw new Error(unexpected.join("\n  "));
});

/**
 * Relative references against a base whose path is opaque.
 *
 * The standard is unambiguous and short, from the no-scheme state:
 *
 *   > If base is null, or base has an opaque path and c is not U+0023 (#), validation error,
 *   > return failure.
 *
 * So exactly one thing resolves against `foo:opaque` — a reference beginning with `#`, which
 * replaces the fragment and keeps everything else. Everything else is a failure.
 *
 * Asserted here directly rather than against a runtime, because Node gets this wrong: it accepts
 * `/a#f` as `foo:/a#f` and, worse, `a#f` as `foo:opaque/a#f`, which appends to an opaque path.
 * Deno rejects them all, correctly. This family is 193 of the 244 cases per 4000 that the fuzzer
 * has to discard for lack of agreement, so it is worth pinning rather than only skipping.
 */
Deno.test("a reference resolves against an opaque path only if it starts with #", () => {
  const base = "foo:opaque";
  const bad: string[] = [];

  for (const input of ["/a", "a", "?q", "//h/x", "/a#f", "a#f", "?q#f", "", "."]) {
    if (wac(input, base).ok) {
      bad.push(`${JSON.stringify(input)} was accepted against ${base}, and should not be`);
    }
  }

  for (const [input, wanted] of [["#f", "foo:opaque#f"], ["#", "foo:opaque#"], ["#a#b", "foo:opaque#a#b"]]) {
    const got = wac(input, base);
    if (got.href !== wanted) {
      bad.push(`${JSON.stringify(input)}: was ${JSON.stringify(got.href)}, want ${JSON.stringify(wanted)}`);
    }
  }

  // A query on the base survives the fragment-only resolution.
  const withQuery = wac("#f", "foo:opaque?q");
  if (withQuery.href !== "foo:opaque?q#f") {
    bad.push(`base query lost: got ${JSON.stringify(withQuery.href)}`);
  }

  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

/**
 * The cases where the runtimes disagree, judged against the standard rather than against either.
 *
 * Two claims, and both matter:
 *
 * 1. wac produces what the standard's text says, quoted per case.
 * 2. the runtimes still disagree in the way recorded. If one of them is fixed and now matches,
 *    this fails and the entry should be deleted — which is the point of asserting it rather than
 *    writing it down in a comment that would rot.
 *
 * Node is right on four of these and Deno on the fifth. That is the reason the bulk of this file
 * uses Node and excludes these five, rather than trusting either runtime completely.
 */
Deno.test("runtime divergences, judged against the standard", async () => {
  const node = await oracle(DIVERGENCES.map(d => d.c));
  const wrong: string[] = [];
  const settled: string[] = [];

  for (let i = 0; i < DIVERGENCES.length; i++) {
    const { c, wanted, why } = DIVERGENCES[i];
    const label = c.base === undefined
      ? JSON.stringify(c.input)
      : `${JSON.stringify(c.input)} against ${JSON.stringify(c.base)}`;

    const got = wac(c.input, c.base);
    if (got.href !== wanted) {
      wrong.push(`${label}: wac gave ${JSON.stringify(got.href)}, the standard says ${JSON.stringify(wanted)}\n      because ${why}`);
    }

    const deno = denoOracle(c);
    if (deno.href === node[i].href) {
      settled.push(`${label}: both runtimes now say ${JSON.stringify(node[i].href)} — drop this entry`);
    }
  }

  if (wrong.length > 0) throw new Error(`not what the standard says:\n  ${wrong.join("\n  ")}`);
  if (settled.length > 0) throw new Error(`no longer divergent:\n  ${settled.join("\n  ")}`);
});
