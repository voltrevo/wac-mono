// One fixture per shape the dead-export check has been wrong about.
//
// wac-mono 0009. This check has had **five** false-positive shapes, each found by someone reading a report
// that called live code dead, and each fixed by editing a regex with nothing pinning the fix:
//
//   1. a function passed as a value (`sh.external = boxRun`) rather than called
//   2. an alias (`import { masked as bits }`), where the call site says the alias
//   3. a by-name bridge entry (`entry: "upperCase"`), named only from TypeScript as a string
//   4. a method on a bound module (`mod.scanKeys(8, …)`), which no wac file names
//   5. a bound module's function taken as a value first (`const inflate = mod.inflate as …`)
//
// Two of them came back in a different spelling after being fixed once — 4 was fixed for `.name(` and
// still reported `inflate` dead, because the file wrote `mod.inflate as` with no paren. A regex that
// nobody tests is one edit away from losing any of these, and the cost of losing one is not a red suite:
// it is a report that gets scrolled past, which is how this check dies.
//
// So each shape is a file in a fixture tree, and the assertions are about which names the scan calls dead.
// The fixture is deliberately tiny and self-contained — `scan` takes a root directory precisely so that
// this is possible without a repository to point it at.

import { report, scan } from "./deadexports.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** Write a fixture tree and return its root. */
async function fixture(files: Record<string, string>): Promise<string> {
  const base = await Deno.makeTempDir({ prefix: "wac-dead-" });
  for (const [path, text] of Object.entries(files)) {
    const at = path.lastIndexOf("/");
    await Deno.mkdir(`${base}/${path.slice(0, at)}`, { recursive: true });
    await Deno.writeTextFile(`${base}/${path}`, text);
  }
  return base;
}

/** The names the scan calls dead, sorted, so an assertion reads as a set. */
async function deadNames(files: Record<string, string>): Promise<string> {
  const base = await fixture(files);
  try {
    return (await scan(base)).dead.map((d) => d.name).sort().join(",");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("an export with a wac caller is not dead, and one without is", async () => {
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": [
        "export i32 used() { return 1; }",
        "export i32 unused() { return 2; }",
        "export i32 caller() { return used(); }",
      ].join("\n"),
    }),
    "caller,unused",
    "the caller itself has no caller, which is correct — nothing in this fixture calls it",
  );
});

Deno.test("shape 1: a function passed as a value counts as used", async () => {
  // `boxRun` and `boxNames` were reported dead while a shell in a browser ran sixty programs through
  // them. Passing a function is how every capability in this repo is wired.
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": [
        "export i32 handler() { return 1; }",
        "export i32 alsoHandler() { return 2; }",
        "export void wire(Shell sh) { sh.external = handler; }",
        "export i32 pick(bool b) { return b ? alsoHandler : handler; }",
      ].join("\n"),
    }),
    "pick,wire",
  );
});

Deno.test("shape 2: an alias at the call site counts as a call of the original", async () => {
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": "export i32 masked() { return 1; }",
      "packages/demo/src/other.wac": [
        'import { masked as bits } from "./lib.wac";',
        "export i32 use() { return bits(); }",
      ].join("\n"),
    }),
    "use",
  );
});

Deno.test("shape 3: `entry:` in TypeScript names an export as a string", async () => {
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": "export i32 upperCase() { return 1; }",
      "packages/demo/test/t.test.ts": 'wacTransformStream({ src: "x", entry: "upperCase" });',
    }),
    "",
  );
});

Deno.test("shape 4: a method call on a bound module counts", async () => {
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": "export i32 scanKeys(i32 a) { return a; }",
      "packages/demo/bench/b.ts": "const mod = await wacBind(); mod.scanKeys(8, 10_000);",
    }),
    "",
  );
});

Deno.test("shape 5: a bound module's function taken as a value, with no paren", async () => {
  // The one that survived the fix for shape 4. `packages/gzip/cov.ts` writes
  // `const inflate = inf.mod.inflate as (d: Uint8Array) => Uint8Array` and then calls the local, so
  // `.inflate(` never appears in the file at all.
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": "export u8[] inflate(u8[] d) { return d; }",
      "packages/demo/cov.ts": [
        'import { instrument } from "../../harness/wacCoverage.ts";',
        'const inf = await instrument("packages/demo/src/lib.wac");',
        "const inflate = inf.mod.inflate as (d: Uint8Array) => Uint8Array;",
        "inflate(new Uint8Array([1]));",
      ].join("\n"),
    }),
    "",
  );
});

Deno.test("a same-named TypeScript method in another package is not a caller", async () => {
  // The precision half, and the reason the search is confined by locality rather than run repo-wide:
  // `.write(` and `.done(` are ordinary method names, and matching them everywhere would hide real dead
  // exports behind unrelated TypeScript.
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": "export i32 write(i32 a) { return a; }",
      "packages/elsewhere/test/t.test.ts": "const f = await Deno.open('x'); f.write(new Uint8Array());",
    }),
    "write",
    "a `.write(` in an unrelated package was counted as driving a wac export",
  );
});

Deno.test("a doc comment naming the function it documents is not a use", async () => {
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": [
        "/** `orphan()` returns one. Called by nothing. */",
        "// orphan() is mentioned here too",
        "export i32 orphan() { return 1; }",
      ].join("\n"),
    }),
    "orphan",
    "counting a comment would hide every dead export behind its own documentation",
  );
});

Deno.test("a name inside a string literal is text, not a reference", async () => {
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": [
        "export i32 wrap() { return 1; }",
        'export string css() { return "#wrap { color: red; }"; }',
      ].join("\n"),
    }),
    "css,wrap",
  );
});

Deno.test("a stale import is not a use — it is exactly as dead", async () => {
  assertEquals(
    await deadNames({
      "packages/demo/src/lib.wac": "export i32 gone() { return 1; }",
      "packages/demo/src/other.wac": [
        'import { gone } from "./lib.wac";',
        "export i32 use() { return 2; }",
      ].join("\n"),
    }),
    "gone,use",
  );
});

Deno.test("probes, size entries and client_entry are skipped, not reported", async () => {
  // Their exports exist to be called from TypeScript by definition, so reporting them would be noise
  // in every package at once.
  assertEquals(
    await deadNames({
      "packages/demo/test/wac/probe.wac": "export i32 probeThing() { return 1; }",
      "packages/demo/size/small.wac": "export i32 sizeThing() { return 1; }",
      "packages/demo/src/client_entry.wac": "export i32 entryThing() { return 1; }",
      "packages/demo/src/lib.wac": "export i32 realOne() { return 1; }",
    }),
    "realOne",
  );
});

Deno.test("a file may exempt its own exports, and the reason is printed", async () => {
  // The third answer, for a set whose completeness is the contract — `packages/wacc/src/kinds.wac` mirrors
  // the reference lexer's `TokenKind` order, so an unused member is correct and deleting it would renumber
  // the rest. What matters as much as the exemption is that it is *visible*: an exemption the report
  // swallows is indistinguishable from a check that has stopped working.
  const files = {
    "packages/demo/src/table.wac": [
      "// dead-exports: exempt — mirrors an external enumeration",
      "export i32 kOne() { return 1; }",
      "export i32 kTwo() { return 2; }",
    ].join("\n"),
    "packages/demo/src/lib.wac": "export i32 stillDead() { return 1; }",
  };
  assertEquals(await deadNames(files), "stillDead", "the exemption leaked to another file");

  const base = await fixture(files);
  try {
    const found = await scan(base);
    assertEquals(found.exempt.length, 1);
    assertEquals(found.exempt[0].reason, "mirrors an external enumeration");
    const text = report(found);
    assertEquals(text.includes("1 file(s) exempt by their own note"), true, text);
    assertEquals(text.includes("mirrors an external enumeration"), true, text);
    // Before the verdict, so a reader cannot read "no dead exports" without seeing what was skipped.
    assertEquals(text.indexOf("exempt") < text.indexOf("that no wac code calls"), true, text);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("the report names the file and line, since that is what a reader acts on", async () => {
  const base = await fixture({
    "packages/demo/src/lib.wac": ["", "export i32 orphan() { return 1; }"].join("\n"),
  });
  try {
    const text = report(await scan(base));
    assertEquals(text.includes("packages/demo/src/lib.wac"), true, text);
    assertEquals(text.includes(":2"), true, `the line number is missing: ${text}`);
    assertEquals(text.startsWith("1 exported function(s)"), true, text);
    // And the clean case says how much it looked at, so "no dead exports" cannot be a scan of nothing.
    // Both call each other, so neither is dead — the point is the sentence, which has to say how many
    // exports it looked at. "no dead exports" over a scan of nothing is the failure this wording avoids.
    const empty = await fixture({
      "packages/demo/src/lib.wac": "export i32 a() { return b(); }\nexport i32 b() { return a(); }",
    });
    try {
      assertEquals(report(await scan(empty)).includes("no dead exports across 2 exported functions"), true);
    } finally {
      await Deno.remove(empty, { recursive: true });
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
