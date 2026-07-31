// Branch coverage for url.
//
// The exercises are the ones the tests run — the hand-written cases and the same assembled-
// fragment generator — because coverage measured against a different workload describes that
// workload rather than the tests.
//
//   deno task coverage:url
//   deno task coverage:url --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/url/test/probe.wac");
const parse = run.mod.parse as (b: Uint8Array) => Uint8Array;
const parseWithBase = run.mod.parseWithBase as (b: Uint8Array, base: Uint8Array) => Uint8Array;

const one = (input: string, base?: string): void => {
  if (base === undefined) parse(enc.encode(input));
  else parseWithBase(enc.encode(input), enc.encode(base));
};

/** Every hand-written case, grouped as the tests group them. */
for (
  const s of [
    "http://example.com/", "https://example.com:8443/a/b?c=d#e", "http://user:pw@example.com/",
    "http://:pw@example.com/", "http://user@example.com/", "http://example.com",
    "http://example.com?q", "http://example.com#f", "http://example.com/?#",
    "ws://h/", "wss://h/", "ftp://h/", "HTTP://example.com/", "HtTpS://Example.COM/",
    "http://example.com:80/", "https://example.com:443/", "ftp://example.com:21/",
    "ws://example.com:80/", "wss://example.com:443/", "http://example.com:0/",
    "http://example.com:65535/", "foo://example.com/", "foo:/path", "foo:path", "foo:",
    "mailto:a@b.c", "data:text/plain,hello", "javascript:alert(1)", "a+b-c.d://h/",
    "http://h:65536/", "http://h:99999999/", "http://h:abc/", "http://h:/", "http://h:-1/",
    "http://h/a/b/../c", "http://h/a/b/./c", "http://h/../../..", "http://h/a/..",
    "http://h/a/../", "http://h/.", "http://h/./", "http://h//a//b//", "http://h/a/%2e/b",
    "http://h/a/%2E%2e/b", "http://h/a/.%2e/b", "http://h\\a\\b", "http://h/a\\b",
    "foo://h/a\\b", "foo://h/a/../b",
    'http://h/ "<>`{}', "http://h/?\" <>#", "http://h/?a'b", "foo://h/?a'b", "http://h/#\" <>`",
    "http://h/%41%42", "http://h/%zz", "http://h/%", "http://h/%a", "http://user na:me@h/",
    "http://h/a?b#c d", "http://h/\u0001\u001f", "http://h/caf\u00e9", "http://h/?caf\u00e9",
    "http://h/#caf\u00e9", "http://h/\u65e5\u672c", "http://h/\ud83d\ude00",
    "http://127.0.0.1/", "http://127.1/", "http://127.0.1/", "http://2130706433/",
    "http://0x7f.1/", "http://0x7f000001/", "http://0177.0.0.1/", "http://0300.0250.0.1/",
    "http://1.2.3.4./", "http://0/", "http://0x/", "http://256.1.1.1/", "http://1.2.3.4.5/",
    "http://999999999999/", "http://0x100000000/", "http://1.2.3.09/", "http://1.2.3.0x/",
    "http://[::1]/", "http://[::]/", "http://[1:2:3:4:5:6:7:8]/", "http://[1::8]/",
    "http://[::ffff:127.0.0.1]/", "http://[0:0:0:0:0:0:0:1]/", "http://[2001:db8::1]:8080/",
    "http://[1:2:3:4:5:6:7:8:9]/", "http://[1::2::3]/", "http://[::1", "http://[]/",
    "http://[:]/", "http://[1:2:3:4:5:6:7]/", "http://[::ffff:999.1.1.1]/",
    "http://EXAMPLE.COM/", "http://h%65llo/", "http:///", "http://:80/", "http://a b/",
    "http://a#b/", "http://a<b/", "http://a|b/", "http://a%2fb/", "foo://a b/", "foo://a%20b/",
    "http://.../", "http://a..b/", "http://caf\u00e9.com/", "http://xn--caf-dma.com/",
    "file:///a/b", "file://localhost/a", "file://LOCALHOST/a", "file://host/a", "file:///",
    "file://", "file:", "file:/a", "file:a", "file:///c:/x", "file:///c|/x", "file://c:/x",
    "file:///C:/", "file:///c:", "file:////a", "file:///a/../b", "file://\\\\a",
    "  http://h/  ", "\thttp://h/", "ht\ntp://h/", "http://h/a\tb", "http://h/a\rb",
    "\u0000http://h/", "", "   ", "http", "://h/", "http:", "1http://h/", "http://",
    "http://:@/", "//h/", "/a/b", "a/b",
    // The edges the main groups miss, kept in step with the test of the same name.
    "foo:/.//x", "foo:/..//x", "web+demo:/.//not-a-host/",
    "http://1.2.3.4.5.6/", "http://1.2.3.256/", "http://1.2.65536/", "http://1.16777216/",
    "http://[::ffff:1.2.3]/", "http://[::ffff:1.2.3.4.5]/", "http://[::ffff:.1.2.3]/",
    "http://[::ffff:1.2.3.]/", "http://[1:2:3:4:5:6:1.2.3.4]/", "http://[1:2:3:4:5:6:7:1.2.3.4]/",
    "foo://h?q", "foo://h#f", "foo://h",
  ]
) one(s);

/** File bases, where a Windows drive letter is reached through resolution rather than written. */
for (const base of ["file:///c:/a/b", "file:///c:", "file://h/c:/x"]) {
  for (const ref of ["..", "/x", "x", "../..", "d:/y", "/d:/y"]) one(ref, base);
}

/** Relative resolution against each base shape, which is most of the state machine. */
for (
  const base of [
    "http://example.com/a/b/c?q#f", "http://example.com/", "https://user:pw@host:8080/p/q",
    "file:///a/b/c", "foo://host/p", "foo:opaque", "foo:opaque?q",
  ]
) {
  for (
    const ref of [
      "", "d", "/d", "//other.com/d", "../d", "../../d", "../../../d", "./d", "?q2", "#f2",
      "?", "#", "http://absolute.example/x", "//h", "\\d", "a:b", ".", "..", "#a#b",
    ]
  ) one(ref, base);
}

/**
 * The same generator the fuzzer uses, so the report covers what the fuzzer actually reaches.
 *
 * Kept in step with `test/fuzz.test.ts` by hand, which is the standing hazard of a second
 * workload: if the two drift, this measures something the tests do not run.
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

let x = 0x1234abcd | 0;
const next = (): number => {
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return x;
};
const pick = <T>(xs: T[]): T => xs[next() % xs.length];

for (let i = 0; i < 4000; i++) {
  const input = next() % 4 === 0
    ? pick(PATHS) + pick(QUERIES) + pick(FRAGMENTS)
    : pick(SCHEMES) + pick(SEPS) + pick(USERINFO) + pick(HOSTS) + pick(PORTS) +
      pick(PATHS) + pick(QUERIES) + pick(FRAGMENTS);
  one(input, pick(BASES));
}

/**
 * The wac-written tests are a second entry point.
 *
 * The encode sets and the host serializer are reachable from wac but not through `parse`, since
 * nothing the host can send exercises `SET_COMPONENT` or an IPv6 host built by hand.
 */
const testRun = await instrument("packages/url/test/wac/url_test.wac");
for (const [name, fn] of Object.entries(testRun.mod)) {
  if (!name.startsWith("test") || typeof fn !== "function") continue;
  const failure = (fn as () => string)();
  if (failure !== "") throw new Error(`${name} failed during coverage: ${failure}`);
}

report([run, testRun], "packages/url/", { verbose });
