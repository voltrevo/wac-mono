// `box`, end to end: every applet compared against the utility it imitates.
//
// Differential rather than expectation-based, deliberately. Each of these is checked
// against the real tool rather than against my idea of it, which is how `nl` numbering
// blank lines and `rev` reversing bytes instead of characters were both found — two bugs
// that a hand-written expectation would have enshrined instead.
//
// The suite lives with the package rather than with `platform` because `box` is a
// consumer of the world, not a part of it.

import { buildApp, type Grants } from "../../platform/build.ts";

const BOX = "packages/box/src/box.wac";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    const detail = msg === undefined ? "" : ` \u2014 ${msg}`;
    throw new Error(
      `assertEquals failed${detail}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}


/** Build once, then run with the given stdin and arguments. */
async function runFilter(
  entry: string,
  args: string[],
  stdin: Uint8Array,
  grants: Grants = {},
): Promise<{ code: number; out: Uint8Array; err: string }> {
  const built = await Deno.makeTempFile({ prefix: "wac-filter-" });
  try {
    await buildApp(entry, built, grants);
    const child = new Deno.Command(built, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(stdin);
    await w.close();
    const r = await child.output();
    return { code: r.code, out: r.stdout, err: new TextDecoder().decode(r.stderr) };
  } finally {
    await Deno.remove(built);
  }
}

/**
 * `assertEquals` above is `!==`, so two byte arrays are never equal to it. This says where
 * they diverge, which for a compressor is the only useful thing to be told.
 */
function assertSameBytes(got: Uint8Array, want: Uint8Array, msg: string): void {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) {
      throw new Error(
        `${msg}\n  first difference at byte ${i}: got ${got[i]}, want ${want[i]}` +
          ` (lengths ${got.length} and ${want.length})`,
      );
    }
  }
}



async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("box's applets agree with the system tools they imitate", async () => {
  // The widest test of the world so far, and a differential one: every applet here is
  // compared against the real utility rather than against my idea of it. `sha256sum` and
  // `base64` go through this repo's own crypto and codec packages, so this is also the
  // first application to compose several packages at once.
  const built = await Deno.makeTempFile({ prefix: "wac-box-" });
  const input = "alpha beta\ngamma\ndelta epsilon zeta\n";
  const fixture = await Deno.makeTempFile({ prefix: "wac-box-in-" });
  try {
    await buildApp(BOX, built, { read: true });
    await Deno.writeTextFile(fixture, input);

    const box = (args: string[]) => {
      const r = new Deno.Command(built, { args, stdout: "piped", stderr: "piped" }).outputSync();
      return { code: r.code, out: new TextDecoder().decode(r.stdout) };
    };
    const sys = (cmd: string, args: string[]) => {
      const r = new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).outputSync();
      return new TextDecoder().decode(r.stdout);
    };

    // Byte-for-byte against the real thing, where the real thing exists here.
    for (const [applet, cmd] of [["cat", "cat"], ["rev", "rev"], ["nl", "nl"], ["base64", "base64"]]) {
      assertEquals(box([applet, fixture]).out, sys(cmd, [fixture]), `${applet} differs`);
    }
    assertEquals(
      box(["sha256sum", fixture]).out.split(" ")[0],
      sys("sha256sum", [fixture]).split(" ")[0],
      "sha256sum differs",
    );

    // `wc` prints its columns without padding, so compare the numbers rather than the text.
    assertEquals(
      box(["wc", fixture]).out.trim().split(/\s+/).slice(0, 3).join(" "),
      sys("wc", [fixture]).trim().split(/\s+/).slice(0, 3).join(" "),
      "wc counts differ",
    );

    // Flags, which every applet gets from one shared parser.
    for (const [args, cmd] of [
      [["sort"], ["sort"]], [["sort", "-r"], ["sort", "-r"]], [["sort", "-u"], ["sort", "-u"]],
      [["tac"], ["tac"]],
    ] as [string[], string[]][]) {
      assertEquals(
        box([...args, fixture]).out,
        sys(cmd[0], [...cmd.slice(1), fixture]),
        `${args.join(" ")} differs`,
      );
    }
    // `-n`, against a fixture that has numbers in it. The words fixture above cannot catch a
    // missing `-n`: every line counts as zero, so ignoring the flag and honouring it agree.
    // Ignoring it is exactly what this did until `seq 1 20 | sort -n` answered 1, 10, 11.
    const numbers = await Deno.makeTempFile({ prefix: "wac-box-num-" });
    await Deno.writeTextFile(numbers, ["10", "9", "100", "-5", "9", "0", "1000", "07"].join("\n") + "\n");
    for (const flags of [["-n"], ["-n", "-r"], ["-n", "-u"]]) {
      assertEquals(
        box(["sort", ...flags, numbers]).out,
        sys("sort", [...flags, numbers]),
        `sort ${flags.join(" ")} differs`,
      );
    }
    await Deno.remove(numbers);

    // Paths, against GNU's own answers. Every case here is a trailing slash, because that is the
    // whole of both applets and `basename a/b/` used to answer with what follows the final slash:
    // nothing. GitHub wac-mono#10.
    for (const path of ["a/b/", "a/b", "/", "//", "a//", "a", "/a", "a//b//", "/usr/lib/"]) {
      for (const applet of ["basename", "dirname"]) {
        assertEquals(
          box([applet, path]).out,
          sys(applet, [path]),
          `${applet} ${JSON.stringify(path)}`,
        );
      }
    }

    // A numeric option that was asked for, versus one that was never given. `Args.num` used to say
    // zero for both, so `head -0` printed the default ten. GitHub wac-mono#8.
    for (const args of [["head", "-0"], ["head", "-n", "0"], ["tail", "-0"], ["tail", "-n", "0"]]) {
      assertEquals(box([...args, fixture]).out, "", `${args.join(" ")} prints nothing`);
      assertEquals(sys(args[0], [...args.slice(1), fixture]), "", `and so does the real one`);
    }

    // `-n` is a value for `head` and `tail` and a boolean everywhere else. It used to be a value
    // everywhere, so a numeric operand vanished into it: `grep -n 123` searched for its filename
    // and stopped numbering. GitHub wac-mono#5.
    const numeric = await Deno.makeTempFile({ prefix: "wac-box-num2-" });
    await Deno.writeTextFile(numeric, "123\nabc\n");
    assertEquals(box(["grep", "-n", "123", numeric]).out, sys("grep", ["-n", "123", numeric]), "grep -n <number>");
    assertEquals(box(["sort", "-n", numeric]).out, sys("sort", ["-n", numeric]), "sort -n <file>");
    await Deno.remove(numeric);

    // The ends of the range, where the counter used to wrap and print for ever, and where the
    // formatter used to answer with a bare "-". GitHub wac-mono#7 and #6.
    assertEquals(box(["seq", "2147483647", "2147483647"]).out, "2147483647\n", "seq at i32 max");
    assertEquals(box(["seq", "--", "-2147483648", "-2147483648"]).out, "-2147483648\n", "seq at i32 min");
    assertEquals(box(["seq", "1", "5"]).out, sys("seq", ["1", "5"]), "seq still counts");
    assertEquals(box(["seq", "10", "-3", "1"]).out, sys("seq", ["10", "-3", "1"]), "seq counts down");

    // A component, not a path: `/` has to become `%2F` or the output cannot be pasted into a URL.
    // Checked against fixed answers rather than a system tool, since there is not a portable one.
    // GitHub wac-mono#9.
    const datum = await Deno.makeTempFile({ prefix: "wac-box-url-" });
    for (const [given, want] of [
      ["a/b", "a%2Fb"],
      ["a b&c=d", "a%20b%26c%3Dd"],
      ["%20", "%2520"],
      ["plain-text_1.2~", "plain-text_1.2~"],
    ]) {
      await Deno.writeTextFile(datum, given);
      assertEquals(box(["urlencode", datum]).out.trim(), want, `urlencode ${JSON.stringify(given)}`);
    }
    await Deno.remove(datum);

    // A missing final newline is a difference. `splitLines` drops the terminator, so files that
    // differ only there produced identical line lists and `diff` exited 0 — the worst answer a diff
    // can give, because the caller's next step is to trust it. GitHub wac-mono#22.
    const withNl = await Deno.makeTempFile({ prefix: "wac-box-nl1-" });
    const noNl = await Deno.makeTempFile({ prefix: "wac-box-nl2-" });
    await Deno.writeTextFile(withNl, "x\ny\n");
    await Deno.writeTextFile(noNl, "x\ny");
    const near = box(["diff", withNl, noNl]);
    assertEquals(near.code, 1, "files differing only in a final newline are different");
    assertEquals(near.out.includes("No newline at end of file"), true, near.out);
    // The real one agrees about the status, which is the part a script reads.
    const sysDiff = new Deno.Command("diff", { args: [withNl, noNl], stdout: "null", stderr: "null" })
      .outputSync();
    assertEquals(sysDiff.code, 1, "and so does GNU diff");
    assertEquals(box(["diff", withNl, withNl]).code, 0, "identical files are still identical");
    await Deno.remove(withNl);
    await Deno.remove(noNl);

    // `-f` ignores what is already gone, not everything that fails. `remove` answered `bool`, so
    // "no such file" and "permission denied" arrived identically and `-f` had to swallow both: it
    // said nothing, exited 0, and left the file there. GitHub wac-mono#17.
    const guarded = await Deno.makeTempDir({ prefix: "wac-box-rmf-" });
    await Deno.mkdir(`${guarded}/sub`);
    await Deno.writeTextFile(`${guarded}/sub/kept`, "x");
    await Deno.chmod(`${guarded}/sub`, 0o500);          // may not be unlinked from
    const stubborn = box(["rm", "-f", `${guarded}/sub/kept`]);
    await Deno.chmod(`${guarded}/sub`, 0o700);
    assertEquals(stubborn.code, 1, "rm -f reports a file it could not remove");
    assertEquals(await exists(`${guarded}/sub/kept`), true, "and the file is indeed still there");
    // While a file that was never there is still silent, as it is in GNU.
    const absent = box(["rm", "-f", `${guarded}/nothing-here`]);
    assertEquals(absent.code, 0, "rm -f on a missing file succeeds");
    await Deno.remove(guarded, { recursive: true });

    // `--` ends the options, so an operand may begin with a dash. Without it `cat -- -x` treated
    // both as flags, found no operand, read empty standard input and exited 0. GitHub wac-mono#11.
    const dashDir = await Deno.makeTempDir({ prefix: "wac-box-dash-" });
    await Deno.writeTextFile(`${dashDir}/-x`, "contents\n");
    assertEquals(box(["cat", "--", `${dashDir}/-x`]).out, "contents\n", "cat -- -x");
    await Deno.remove(dashDir, { recursive: true });

    // A numeric sort key outside i32. It used to wrap: `4294967296` and `0` compared equal, so
    // `-nu` dropped one of them. GitHub wac-mono#12.
    const wide = await Deno.makeTempFile({ prefix: "wac-box-wide-" });
    await Deno.writeTextFile(wide, "4294967296\n1\n2147483648\n-1\n");
    assertEquals(box(["sort", "-n", wide]).out, sys("sort", ["-n", wide]), "sort -n past i32");
    await Deno.writeTextFile(wide, "4294967296\n0\n");
    assertEquals(box(["sort", "-nu", wide]).out, sys("sort", ["-nu", wide]), "sort -nu past i32");
    await Deno.remove(wide);

    // `split`'s suffixes past `zz`. GNU reserves a leading `z` as the marker that the suffix has
    // grown, so two letters run `aa`..`yz` and the next name is `zaaa` — this used to leave the
    // alphabet entirely and emit `z676`, which sorts nowhere near where it was written.
    // GitHub wac-mono#14.
    const seven = await Deno.makeTempFile({ prefix: "wac-box-many-" });
    await Deno.writeTextFile(seven, Array.from({ length: 700 }, (_, i) => String(i)).join("\n") + "\n");
    const ours = await Deno.makeTempDir({ prefix: "wac-box-split-a-" });
    const theirs = await Deno.makeTempDir({ prefix: "wac-box-split-b-" });
    // Its own binary: `built` above is granted read only, and `split` has to open its pieces for
    // writing. Without this it wrote nothing, and the comparison was "" against 700 names.
    const writer = await Deno.makeTempFile({ prefix: "wac-box-splitw-" });
    await buildApp(BOX, writer, { read: true, write: true });
    new Deno.Command(writer, { args: ["split", "-1", seven], cwd: ours, stdout: "null" }).outputSync();
    new Deno.Command("split", { args: ["-l", "1", seven], cwd: theirs, stdout: "null" }).outputSync();
    const names = (dir: string) => [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(names(ours).join(" "), names(theirs).join(" "), "every split suffix, all 700");
    await Deno.remove(seven);
    await Deno.remove(writer);
    await Deno.remove(ours, { recursive: true });
    await Deno.remove(theirs, { recursive: true });

    // A pattern that exhausts the backtracking budget is not a match. It used to be counted as one,
    // because only NO_MATCH was checked. GitHub wac-mono#26.
    const patho = await Deno.makeTempFile({ prefix: "wac-box-patho-" });
    await Deno.writeTextFile(patho, "a".repeat(30) + "\n");
    const gave = box(["grep", "(a|a)*b", patho]);
    assertEquals(gave.code, 2, `budget exhaustion should exit 2, got ${gave.code}`);
    assertEquals(gave.out, "", "and should print no matches");
    await Deno.remove(patho);

    // A name that does not fit a ustar header is refused, which is what tar.wac has always claimed.
    // There was no check, so the header writer copied the first 100 bytes and archived the entry
    // under a different name. GitHub wac-mono#23.
    const deep = await Deno.makeTempDir({ prefix: "wac-box-tar-" });
    const longDir = `${deep}/${"d".repeat(40)}`;
    await Deno.mkdir(longDir);
    await Deno.writeTextFile(`${longDir}/${"f".repeat(70)}`, "x");
    const tarred = new Deno.Command(built, {
      args: ["tar", "."],
      cwd: deep,
      stdout: "null",
      stderr: "piped",
    }).outputSync();
    assertEquals(tarred.code, 1, "an unarchivable name is a failure");
    assertEquals(
      new TextDecoder().decode(tarred.stderr).includes("longer than the 100 bytes"),
      true,
      "and says why",
    );
    await Deno.remove(deep, { recursive: true });

    // An unreadable directory is not an empty one. `find` printed a partial listing and exited 0,
    // and `du` undercounted the total and exited 0 — a wrong number that looks like an answer.
    // GitHub wac-mono#20.
    const unreadable = await Deno.makeTempDir({ prefix: "wac-box-unread-" });
    await Deno.mkdir(`${unreadable}/shut`);
    await Deno.writeTextFile(`${unreadable}/shut/inside`, "x");
    await Deno.chmod(`${unreadable}/shut`, 0o000);
    const found = box(["find", unreadable]);
    const counted = box(["du", unreadable]);
    await Deno.chmod(`${unreadable}/shut`, 0o755);
    await Deno.remove(unreadable, { recursive: true });
    assertEquals(found.code, 1, "find over an unreadable subtree fails");
    assertEquals(counted.code, 1, "and so does du");

    // A read that fails is not an end of input. `readChunk` answers with bytes and cannot say
    // "broken", so every filter treated a half-read as a whole one and exited 0 — the failure mode
    // where the program is the last thing suspected. `inputError` is the reason, asked once when the
    // chunks stop. A directory is the portable way to get an open that succeeds and a read that does
    // not. GitHub wac-mono#18.
    for (const applet of ["cat", "wc", "hex", "crc32", "sha256sum", "strings"]) {
      const r = box([applet, "/tmp"]);
      assertEquals(r.code, 1, `${applet} of a directory should fail, got ${r.code}`);
    }
    // And the real ones agree that it is a failure.
    assertEquals(
      new Deno.Command("cat", { args: ["/tmp"], stdout: "null", stderr: "null" }).outputSync().code,
      1,
      "GNU cat agrees",
    );

    assertEquals(box(["head", "-3", fixture]).out, sys("head", ["-3", fixture]), "head -N");
    assertEquals(box(["tail", "-n", "2", fixture]).out, sys("tail", ["-n", "2", fixture]), "tail -n N");
    assertEquals(box(["wc", "-l", fixture]).out.trim(), sys("wc", ["-l", fixture]).trim().split(/\s+/)[0]);
    assertEquals(
      box(["sha512sum", fixture]).out.split(" ")[0],
      sys("sha512sum", [fixture]).split(" ")[0],
      "sha512sum differs",
    );
    assertEquals(box(["base32", fixture]).out, sys("base32", [fixture]), "base32 differs");

    // grep, which brings the regex package in. Every flag against the real thing.
    for (const args of [["grep", "an"], ["grep", "-i", "AN"], ["grep", "-v", "an"],
                        ["grep", "-n", "an"], ["grep", "-c", "an"]]) {
      assertEquals(
        box([...args, fixture]).out,
        sys("grep", [...args.slice(1), fixture]),
        `${args.join(" ")} differs`,
      );
    }
    assertEquals(box(["grep", "zzznope", fixture]).code, 1, "no match exits 1, as grep does");
    assertEquals(box(["grep", "[", fixture]).code, 2, "a bad pattern is a usage error");

    assertEquals(box(["basename", "a/b/c.txt"]).out.trim(), "c.txt");
    assertEquals(box(["dirname", "a/b/c.txt"]).out.trim(), "a/b");
    assertEquals(box(["echo", "hello", "wac"]).out.trim(), "hello wac");
    assertEquals(box(["seq", "3"]).out.trim().split("\n").join(","), "1,2,3");
    assertEquals(box(["true"]).code, 0);
    assertEquals(box(["false"]).code, 1);
    assertEquals(box(["nope"]).code, 2, "an unknown applet is a usage error");

    // The first applets that recurse, against the real tools over a nested tree.
    assertEquals(
      box(["find", "packages/platform/src"]).out.trim().split("\n").sort().join("\n"),
      sys("find", ["packages/platform/src"]).trim().split("\n").sort().join("\n"),
      "find differs",
    );
    assertEquals(
      box(["du", "packages/platform/src"]).out.split("\t")[0],
      sys("du", ["-sb", "packages/platform/src"]).split("\t")[0],
      "du differs from du -sb",
    );

    // head and tail against a file with more lines than they take.
    const many = await Deno.makeTempFile();
    try {
      await Deno.writeTextFile(many, Array.from({ length: 15 }, (_, i) => i + 1).join("\n") + "\n");
      assertEquals(box(["head", many]).out, sys("head", ["-10", many]), "head differs");
      assertEquals(box(["tail", many]).out, sys("tail", ["-10", many]), "tail differs");
    } finally {
      await Deno.remove(many);
    }
  } finally {
    await Deno.remove(built);
    await Deno.remove(fixture);
  }
});

Deno.test("box works as a filter, and its applets need only what they use", async () => {
  const input = new TextEncoder().encode("one two\nthree\n");
  // No grants at all: reading standard input is not a capability, so a pipeline works
  // even where the filesystem was withheld.
  const piped = await runFilter(BOX, ["wc"], input);
  assertEquals(piped.code, 0, piped.err);
  assertEquals(new TextDecoder().decode(piped.out).trim(), "2 3 14");

  const hashed = await runFilter(BOX, ["sha256sum"], input);
  assertEquals(new TextDecoder().decode(hashed.out).trim().endsWith("  -"), true, "stdin is '-'");

  // But a file still needs the grant, and says so.
  const denied = await runFilter(BOX, ["cat", "README.md"], new Uint8Array());
  assertEquals(denied.code, 1);
  assertEquals(denied.err.includes("not granted"), true, denied.err);
});

Deno.test("cp streams, and leaves nothing behind either way", async () => {
  // `cp` read the whole file and wrote the whole file, so copying anything larger than
  // memory was impossible and copying anything over a megabyte failed outright. It now
  // pumps chunks into a temporary name and renames, which needs `openOutput` — without a
  // streaming *sink* the read half alone would not have helped.
  const built = await Deno.makeTempFile({ prefix: "wac-cp-" });
  const dir = await Deno.makeTempDir({ prefix: "wac-cp-d-" });
  try {
    await buildApp(BOX, built, { read: true, write: true });
    const cp = (src: string, dst: string) =>
      new Deno.Command(built, { args: ["cp", src, dst], stderr: "piped" }).outputSync();

    // Several times the 64K chunk and the 1MB bridge buffer, and not a multiple of either.
    const size = 5_000_003;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >> 13)) & 0xFF;
    const src = `${dir}/src`;
    await Deno.writeFile(src, data);

    const r = cp(src, `${dir}/dst`);
    assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
    assertSameBytes(await Deno.readFile(`${dir}/dst`), data, "5MB copy");

    // Over an existing file, and the rename must not leave the old contents.
    await Deno.writeTextFile(`${dir}/dst`, "stale");
    assertEquals(cp(src, `${dir}/dst`).code, 0);
    assertSameBytes(await Deno.readFile(`${dir}/dst`), data, "copy over an existing file");

    // A failure must not leave a temporary file lying next to the target.
    assertEquals(cp(`${dir}/absent`, `${dir}/never`).code, 1, "a missing source fails");
    const left: string[] = [];
    for await (const e of Deno.readDir(dir)) left.push(e.name);
    assertEquals(left.sort().join(","), "dst,src", `temporary files survived: ${left}`);

    // And `write` goes back to standard output afterwards, which is what closes the file.
    const out = new Deno.Command(built, {
      args: ["cat", src],
      stdout: "piped",
    }).outputSync();
    assertSameBytes(out.stdout, data, "cat still writes to stdout after a cp");
  } finally {
    await Deno.remove(built);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("box's write-path applets: cp and tee", async () => {
  // The first applets in `box` that write. `cp` needs no capability the world did not
  // already have — it is `readFile` and `writeFile` — and `tee` is the first with two
  // destinations at once.
  const built = await Deno.makeTempFile({ prefix: "wac-box-w-" });
  const dst = await Deno.makeTempFile({ prefix: "wac-box-dst-" });
  try {
    await buildApp(BOX, built, { read: true, write: true });
    const src = "packages/box/src/box.wac";

    const cp = new Deno.Command(built, { args: ["cp", src, dst], stderr: "piped" }).outputSync();
    assertEquals(cp.code, 0, new TextDecoder().decode(cp.stderr));
    assertEquals(await Deno.readTextFile(dst), await Deno.readTextFile(src), "cp copied it");

    const child = new Deno.Command(built, {
      args: ["tee", dst],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode("through\n"));
    await w.close();
    const r = await child.output();
    assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
    assertEquals(new TextDecoder().decode(r.stdout), "through\n", "tee wrote to stdout");
    assertEquals(await Deno.readTextFile(dst), "through\n", "and to the file");
  } finally {
    await Deno.remove(built);
    await Deno.remove(dst);
  }
});

Deno.test("box's applets compose in a pipeline", async () => {
  // Three wac programs in a row, which is the thing a file-to-file tool could never do.
  const built = await Deno.makeTempFile({ prefix: "wac-box-p-" });
  try {
    await buildApp(BOX, built, { read: true });
    const run = (args: string[], input: string) => {
      const child = new Deno.Command(built, {
        args, stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(new TextEncoder().encode(input)).then(() => w.close());
      return child.output().then((r) => new TextDecoder().decode(r.stdout));
    };
    const sorted = await run(["sort", "-u"], "b\na\nb\nc\na\n");
    assertEquals(sorted, "a\nb\nc\n");
    assertEquals(await run(["wc", "-l"], sorted), "3\n");
    assertEquals(await run(["tac"], sorted), "c\nb\na\n");
  } finally {
    await Deno.remove(built);
  }
});

Deno.test("box's text applets agree with the system tools they imitate", async () => {
  // The second differential batch: `cut`, `tr`, `fold` and `strings`. Everything is checked
  // against the real tool rather than against my idea of it, as the first batch is.
  const built = await Deno.makeTempFile({ prefix: "wac-box-t-" });
  const fixture = await Deno.makeTempFile({ prefix: "wac-box-tin-" });
  try {
    await buildApp(BOX, built, { read: true });
    await Deno.writeTextFile(fixture, "a,b,c\nd,e,f\nnodelim\n,leading,\n");

    const box = (args: string[], input = "") => {
      const child = new Deno.Command(built, {
        args, stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(new TextEncoder().encode(input)).then(() => w.close());
      return child.output().then((o) => new TextDecoder().decode(o.stdout));
    };
    const sys = (cmd: string, args: string[], input = "") => {
      const child = new Deno.Command(cmd, {
        args, stdin: "piped", stdout: "piped", stderr: "null",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(new TextEncoder().encode(input)).then(() => w.close());
      return child.output().then((o) => new TextDecoder().decode(o.stdout));
    };

    // cut: a field, a chosen delimiter, and a line that has none — which `cut` passes
    // through whole, on the reasoning that a line with no fields is one field.
    for (const f of ["1", "2", "3", "9"]) {
      assertEquals(
        await box(["cut", "-d,", `-f${f}`, fixture]),
        await sys("cut", ["-d,", `-f${f}`, fixture]),
        `cut -f${f} differs`,
      );
    }
    assertEquals(
      await box(["cut", "-f2", fixture]),
      await sys("cut", ["-f2", fixture]),
      "cut with the default tab delimiter differs",
    );
    // A flag's value must be attached. The separated spelling would be indistinguishable
    // from a filename once parsed, so it is refused rather than silently misread.
    const bare = new Deno.Command(built, {
      args: ["cut", "-d", ",", "-f", "2", fixture],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(bare.code, 2, "a detached flag value should be a usage error");
    assertEquals(
      new TextDecoder().decode(bare.stderr).includes("-f<n>"),
      true,
      "and should say how to spell it",
    );

    const text = await Deno.readTextFile("README.md");
    for (const sets of [["a-z", "A-Z"], ["aeiou", "."], ["abc", "x"], ["A-Za-z", "N-ZA-Mn-za-m"]]) {
      assertEquals(
        await box(["tr", ...sets], text),
        await sys("tr", sets, text),
        `tr ${sets.join(" ")} differs`,
      );
    }

    for (const w of ["10", "20", "80"]) {
      assertEquals(
        await box(["fold", `-${w}`, fixture]),
        await sys("fold", [`-w${w}`, fixture]),
        `fold -${w} differs`,
      );
    }

    // `strings` on a binary: the one applet whose input is deliberately not text.
    for (const n of ["4", "8"]) {
      assertEquals(
        await box(["strings", `-${n}`, "/bin/true"]),
        await sys("strings", [`-n${n}`, "/bin/true"]),
        `strings -${n} differs`,
      );
    }
  } finally {
    await Deno.remove(built);
    await Deno.remove(fixture);
  }
});

Deno.test("box's package-backed applets: gzip, gunzip, crc32, date, urlencode", async () => {
  // These are the point of `box`: each is a few lines over a package written in this repo
  // for TypeScript bindings, reused unchanged as the inside of a program. The compression
  // ones are checked against the system `gzip` in *both* directions, so neither side can be
  // wrong in a way the other cancels out.
  const built = await Deno.makeTempFile({ prefix: "wac-box-g-" });
  try {
    await buildApp(BOX, built, { read: true });
    const raw = await Deno.readFile("README.md");

    const run = (args: string[], input: Uint8Array) => {
      const child = new Deno.Command(built, {
        args, stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(input).then(() => w.close());
      return child.output();
    };
    const sysRun = (cmd: string, args: string[], input: Uint8Array) => {
      const child = new Deno.Command(cmd, {
        args, stdin: "piped", stdout: "piped", stderr: "null",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(input).then(() => w.close());
      return child.output();
    };

    const squeezed = (await run(["gzip"], raw)).stdout;
    assertEquals(squeezed.length < raw.length, true, "gzip did not compress");
    assertSameBytes((await run(["gunzip"], squeezed)).stdout, raw, "box could not read its own gzip");
    assertSameBytes(
      (await sysRun("gunzip", [], squeezed)).stdout,
      raw,
      "the system gzip could not read box's",
    );
    assertSameBytes(
      (await run(["gunzip"], (await sysRun("gzip", ["-c"], raw)).stdout)).stdout,
      raw,
      "box could not read the system gzip's",
    );

    // crc32 against the checksum gzip itself carries, computed independently here.
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    let crc = 0xFFFFFFFF;
    for (const b of raw) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    const expect = ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, "0");
    assertEquals(new TextDecoder().decode((await run(["crc32"], raw)).stdout).trim(), `${expect}  -`);

    // `date` is the clock capability with a package on top; it must be RFC 3339 and now.
    const now = new TextDecoder().decode((await run(["date"], new Uint8Array())).stdout).trim();
    const parsed = Date.parse(now);
    assertEquals(Number.isNaN(parsed), false, `not a date: ${now}`);
    assertEquals(Math.abs(parsed - Date.now()) < 60_000, true, `not now: ${now}`);

    // Percent-encoding round-trips, including bytes that are not ASCII at all.
    const enc = new TextEncoder();
    for (const s of ["a b/c?d=e&f#g", "ünïcode ✓", "plain", "%already%20encoded"]) {
      const encoded = (await run(["urlencode"], enc.encode(s + "\n"))).stdout;
      assertEquals(
        new TextDecoder().decode(encoded).includes(" "),
        false,
        "a space survived encoding",
      );
      assertEquals(
        new TextDecoder().decode((await run(["urldecode"], encoded)).stdout),
        s + "\n",
        `${s} did not round-trip`,
      );
    }
  } finally {
    await Deno.remove(built);
  }
});

Deno.test("box's mutation tier: mkdir, rm, rmdir, mv, touch", async () => {
  // `writeFile` was the only mutation the world had, which meant an application could
  // create a file but never remove or move one — so it could not write safely either.
  // These three ops are what `cp` needs to write beside its target and rename into place.
  const built = await Deno.makeTempFile({ prefix: "wac-box-m-" });
  const root = await Deno.makeTempDir({ prefix: "wac-box-fs-" });
  try {
    await buildApp(BOX, built, { read: true, write: true });
    const box = (args: string[]) => {
      const r = new Deno.Command(built, { args, stdout: "piped", stderr: "piped" }).outputSync();
      return { code: r.code, err: new TextDecoder().decode(r.stderr) };
    };
    const exists = async (p: string) => {
      try {
        await Deno.stat(p);
        return true;
      } catch {
        return false;
      }
    };

    const deep = `${root}/a/b/c`;
    assertEquals(box(["mkdir", "-p", deep]).code, 0);
    assertEquals(await exists(deep), true, "mkdir -p made the parents");
    // Without -p a missing parent is an error, which is the difference between them.
    assertEquals(box(["mkdir", `${root}/x/y`]).code, 1, "mkdir without -p needs the parent");

    assertEquals(box(["touch", `${deep}/f`]).code, 0);
    assertEquals((await Deno.stat(`${deep}/f`)).size, 0, "touch made it empty");
    await Deno.writeTextFile(`${deep}/f`, "kept");
    assertEquals(box(["touch", `${deep}/f`]).code, 0);
    assertEquals(await Deno.readTextFile(`${deep}/f`), "kept", "touch left an existing file alone");

    assertEquals(box(["mv", `${deep}/f`, `${root}/moved`]).code, 0);
    assertEquals(await exists(`${deep}/f`), false, "mv left nothing behind");
    assertEquals(await Deno.readTextFile(`${root}/moved`), "kept", "mv kept the contents");

    // `rmdir` is never recursive; that distinction is the reason it is its own command.
    await Deno.writeTextFile(`${deep}/g`, "x");
    assertEquals(box(["rmdir", deep]).code, 1, "rmdir refuses a non-empty directory");
    assertEquals(box(["rm", `${deep}/g`]).code, 0);
    assertEquals(box(["rmdir", deep]).code, 0, "and takes an empty one");

    // Absence is an error unless you say it is not, as `rm -f` says.
    assertEquals(box(["rm", `${root}/never`]).code, 1);
    assertEquals(box(["rm", "-f", `${root}/never`]).code, 0);
    assertEquals(box(["rm", `${root}/a`]).code, 1, "rm needs -r for a directory");
    assertEquals(box(["rm", "-r", `${root}/a`]).code, 0);
    assertEquals(await exists(`${root}/a`), false);

    // The point of the tier: `cp` writes beside its target and renames, so the destination
    // is never seen half-written and no temporary name survives a successful copy.
    assertEquals(box(["cp", "README.md", `${root}/copy`]).code, 0);
    assertEquals(
      await Deno.readTextFile(`${root}/copy`),
      await Deno.readTextFile("README.md"),
      "cp copied it",
    );
    const left: string[] = [];
    for await (const e of Deno.readDir(root)) left.push(e.name);
    assertEquals(left.sort().join(","), "copy,moved", `a temporary file survived: ${left}`);

    // And without the write grant none of it happens, whatever the arguments say.
    const readOnly = await Deno.makeTempFile({ prefix: "wac-box-ro-" });
    try {
      await buildApp(BOX, readOnly, { read: true });
      const r = new Deno.Command(readOnly, {
        args: ["mkdir", `${root}/denied`],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      assertEquals(r.code, 1, "mkdir without the grant should fail");
      assertEquals(await exists(`${root}/denied`), false, "and should make nothing");
    } finally {
      await Deno.remove(readOnly);
    }
  } finally {
    await Deno.remove(built);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bin/: one applet alone states only the grants it needs", async () => {
  // The README has been claiming that a multicall binary costs you the permission story
  // and that built separately each applet would state its own. This measures it rather
  // than asserting it: `wc` and `sha256sum` come out with an empty shebang, and a `wc`
  // built that way cannot open a file even when told to.
  const cases: Array<{ name: string; grants: Grants; shebang: string }> = [
    { name: "wc", grants: {}, shebang: "#!/usr/bin/env -S deno run" },
    { name: "sha256sum", grants: {}, shebang: "#!/usr/bin/env -S deno run" },
    { name: "grep", grants: { read: true }, shebang: "#!/usr/bin/env -S deno run --allow-read" },
    {
      name: "cp",
      grants: { read: true, write: true },
      shebang: "#!/usr/bin/env -S deno run --allow-read --allow-write",
    },
  ];
  const built: string[] = [];
  try {
    for (const c of cases) {
      const out = await Deno.makeTempFile({ prefix: `wac-bin-${c.name}-` });
      built.push(out);
      await buildApp(`packages/box/src/bin/${c.name}.wac`, out, c.grants);
      const first = (await Deno.readTextFile(out)).split("\n")[0];
      assertEquals(first, c.shebang, `${c.name}'s shebang`);
    }

    const [wc, sha, grep, cp] = built;
    const pipe = (path: string, args: string[], input: string) => {
      const child = new Deno.Command(path, {
        args, stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(new TextEncoder().encode(input)).then(() => w.close());
      return child.output();
    };
    const dec = new TextDecoder();

    // The applet is the same code, so it must behave the same with no `box` in front.
    const text = "alpha beta\ngamma\n";
    assertEquals(dec.decode((await pipe(wc, [], text)).stdout).trim(), "2 3 17");
    assertEquals(dec.decode((await pipe(wc, ["-l"], text)).stdout).trim(), "2", "flags still parse");
    assertEquals(
      dec.decode((await pipe(sha, [], text)).stdout).trim().endsWith("  -"),
      true,
      "stdin is still '-'",
    );
    assertEquals(dec.decode((await pipe(grep, ["-c", "beta"], text)).stdout).trim(), "1");

    // And a program with no grants cannot be talked into a read, whatever it is passed.
    const denied = await pipe(wc, ["README.md"], "");
    assertEquals(denied.code, 1);
    assertEquals(dec.decode(denied.stderr).includes("not granted"), true);
    // It names itself, not `box` — the entry point in `bin/` passes the name, because a
    // program in this model is never handed its own argv[0].
    assertEquals(dec.decode(denied.stderr).startsWith("wc: "), true, dec.decode(denied.stderr));

    // The one with grants does the real thing.
    const dst = await Deno.makeTempFile({ prefix: "wac-bin-dst-" });
    try {
      const r = new Deno.Command(cp, { args: ["README.md", dst], stderr: "piped" }).outputSync();
      assertEquals(r.code, 0, dec.decode(r.stderr));
      assertEquals(await Deno.readTextFile(dst), await Deno.readTextFile("README.md"));
    } finally {
      await Deno.remove(dst);
    }

    // The size of what you gave up: `box` carries every applet and every grant.
    const alone = (await Deno.stat(wc)).size;
    const all = await Deno.makeTempFile({ prefix: "wac-bin-box-" });
    built.push(all);
    await buildApp(BOX, all, { read: true, write: true });
    assertEquals(alone * 2 < (await Deno.stat(all)).size, true, "box should be much larger");
  } finally {
    for (const b of built) await Deno.remove(b);
  }
});
Deno.test("streaming applets hold a chunk, not the input", async () => {
  // The point of `openInput`/`readChunk`. Correctness first — a streaming rewrite is easy
  // to get subtly wrong at a chunk boundary, and every case here is one that a
  // whole-input loop would have got right for free:
  //
  //   wc       a word split across two reads is one word, not two
  //   strings  a run split across two reads is one run, not two short ones
  //   crc32    the checksum is order-dependent across every chunk
  //   tr, hex  per byte, so only the framing can go wrong
  const built = await Deno.makeTempFile({ prefix: "wac-stream-" });
  const fixture = await Deno.makeTempFile({ prefix: "wac-stream-in-" });
  try {
    await buildApp(BOX, built, { read: true });
    // Deliberately larger than one 64K chunk and not a multiple of it, so boundaries land
    // in the middle of words and runs rather than tidily between them.
    const CHUNK = 1 << 16;
    const parts: string[] = [];
    for (let i = 0; i < 5000; i++) parts.push(`word${i} alpha beta gamma delta epsilon\n`);
    const text = parts.join("");
    assertEquals(text.length > 3 * CHUNK, true, "the fixture must span several chunks");
    await Deno.writeTextFile(fixture, text);

    const box = (args: string[]) => {
      const r = new Deno.Command(built, { args, stdout: "piped", stderr: "piped" }).outputSync();
      return { code: r.code, out: new TextDecoder().decode(r.stdout) };
    };
    const sys = (cmd: string, args: string[]) =>
      new TextDecoder().decode(
        new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).outputSync().stdout,
      );

    // The real `wc` pads its columns; the numbers are what is under test.
    const cols = (s: string) => s.trim().split(/\s+/).slice(0, 3).join(" ");
    assertEquals(cols(box(["wc", fixture]).out), cols(sys("wc", [fixture])), "wc across chunks");
    assertEquals(box(["tr", "a-z", "A-Z", fixture]).out, text.toUpperCase(), "tr across chunks");

    // A run that spans several chunks must come out as one string, not several.
    const spanning = await Deno.makeTempFile({ prefix: "wac-stream-span-" });
    try {
      const run = new Uint8Array(200_000 + 2);
      run[0] = 0;
      run.fill(65, 1, 200_001);
      run[200_001] = 0;
      await Deno.writeFile(spanning, run);
      assertEquals(
        box(["strings", spanning]).out,
        sys("strings", ["-n4", spanning]),
        "a 200K run spanning three chunks is one string",
      );
    } finally {
      await Deno.remove(spanning);
    }

    assertEquals(box(["strings", fixture]).out, sys("strings", ["-n4", fixture]), "strings");
    assertEquals(box(["hex", fixture]).out.length, text.length * 2 + 1, "hex is 2 chars a byte");
    assertEquals(
      box(["crc32", fixture]).out.split(" ")[0],
      (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
          let c = i;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
          table[i] = c >>> 0;
        }
        let crc = 0xFFFFFFFF;
        for (const b of new TextEncoder().encode(text)) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
        return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, "0");
      })(),
      "crc32 across chunks",
    );

    // The reason the message shape matters: a denied read must still say why, which a
    // bool-returning `openInput` could not.
    const noGrant = await Deno.makeTempFile({ prefix: "wac-stream-ro-" });
    try {
      await buildApp(BOX, noGrant, {});
      const r = new Deno.Command(noGrant, {
        args: ["cat", fixture], stdout: "piped", stderr: "piped",
      }).outputSync();
      assertEquals(r.code, 1);
      assertEquals(
        new TextDecoder().decode(r.stderr).includes("not granted"),
        true,
        new TextDecoder().decode(r.stderr),
      );
    } finally {
      await Deno.remove(noGrant);
    }
  } finally {
    await Deno.remove(built);
    await Deno.remove(fixture);
  }
});

Deno.test("line-oriented applets stream too, and stay faithful at the edges", async () => {
  // `tail` was written off as unstreamable, wrongly: it has to *reach* the end but only
  // has to *hold* N lines. `head` is better still — it stops reading once it has them.
  //
  // Converting them turned up two bugs that predate this and that the old fixture could
  // not see, because it had no blank lines and no text outside ASCII: `nl` numbered blank
  // lines, and `rev` reversed bytes rather than characters, so an em dash came back as
  // three replacement characters.
  const built = await Deno.makeTempFile({ prefix: "wac-lines-" });
  const fixture = await Deno.makeTempFile({ prefix: "wac-lines-in-" });
  const nonl = await Deno.makeTempFile({ prefix: "wac-lines-nonl-" });
  const oneline = await Deno.makeTempFile({ prefix: "wac-lines-one-" });
  try {
    await buildApp(BOX, built, { read: true });

    // Spans several 64K chunks, with blank lines, repeats and non-ASCII in it.
    const rows: string[] = [];
    for (let i = 0; i < 4000; i++) {
      rows.push(`line ${i} — ünïcode`);
      if (i % 7 === 0) rows.push("");
      if (i % 11 === 0) rows.push("repeated");
      if (i % 11 === 0) rows.push("repeated");
    }
    await Deno.writeTextFile(fixture, rows.join("\n") + "\n");
    await Deno.writeTextFile(nonl, "alpha\nbravo");
    // One line and no newline at all: the shape that made the first line reader quadratic.
    await Deno.writeTextFile(oneline, "x".repeat(500_000));

    const box = (args: string[], file: string) =>
      new TextDecoder().decode(
        new Deno.Command(built, { args: [...args, file], stdout: "piped", stderr: "null" })
          .outputSync().stdout,
      );
    const sys = (cmd: string, args: string[], file: string) =>
      new TextDecoder().decode(
        new Deno.Command(cmd, { args: [...args, file], stdout: "piped", stderr: "null" })
          .outputSync().stdout,
      );

    for (const [mine, real] of [
      [["head"], ["head"]],
      [["head", "-3"], ["head", "-3"]],
      [["tail"], ["tail"]],
      [["tail", "-3"], ["tail", "-3"]],
      [["tail", "-1"], ["tail", "-1"]],
      [["nl"], ["nl"]],
      [["rev"], ["rev"]],
      [["uniq"], ["uniq"]],
      [["uniq", "-c"], ["uniq", "-c"]],
    ] as const) {
      assertEquals(box([...mine], fixture), sys(real[0], real.slice(1), fixture), `${mine.join(" ")}`);
      // A file with no final newline: `head`, `tail` and `rev` preserve that and `nl` and
      // `uniq` add one. Not uniform, so each is checked rather than assumed.
      assertEquals(box([...mine], nonl), sys(real[0], real.slice(1), nonl), `${mine.join(" ")} unterminated`);
    }

    // `tail -N` asks for more lines than exist, and for exactly one.
    assertEquals(box(["tail", "-100000"], fixture), sys("tail", ["-100000"], fixture), "tail past the start");

    // Half a megabyte with no newline in it: one line, and it must not take quadratic time.
    // The first reader appended with `concat` and rescanned from the start after every
    // refill; on a 300MB version of this it had not finished after two minutes.
    const started = performance.now();
    assertEquals(box(["tail", "-1"], oneline).length, 500_000, "one very long line");
    assertEquals(
      performance.now() - started < 15_000,
      true,
      "a single long line should be linear, not quadratic",
    );
  } finally {
    for (const f of [built, fixture, nonl, oneline]) await Deno.remove(f);
  }
});


/**
 * A port nobody is using, taken by binding one and letting go.
 *
 * A fixed number would collide with whatever else is on the machine, and these tests run
 * in parallel with each other.
 */
function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const n = (l.addr as Deno.NetAddr).port;
  l.close();
  return n;
}

/**
 * Wait until the server says it is listening, by reading the line it prints.
 *
 * Deliberately not by connecting. `serve -o` handles exactly one connection, so a probe
 * that dials the port *is* that connection — the first version of this test did that and
 * then hung waiting for a server that had already served the probe and exited.
 *
 * Returns the stderr it consumed, so a caller can still assert on it afterwards.
 */
async function waitForListening(server: Deno.ChildProcess, port: number): Promise<string> {
  const reader = server.stderr.getReader();
  const dec = new TextDecoder();
  let seen = "";
  while (!seen.includes(`listening on port ${port}`)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the server exited before listening: ${seen}`);
    seen += dec.decode(value, { stream: true });
  }
  reader.releaseLock();
  return seen;
}

Deno.test("box's network applets: a wac server and a wac client, over real TCP", async () => {
  // The first applets that are not filters. `packages/server`'s `serve(input, now)` is a
  // pure state machine — bytes in, a response and a consumed count out — so the socket
  // loop is thirty lines and nothing in that package knows a socket exists.
  //
  // A free port is taken by binding one and letting go; a fixed number would collide with
  // whatever else is on this machine, and these tests run in parallel with each other.
  const built = await Deno.makeTempFile({ prefix: "wac-net-" });
  try {
    await buildApp(BOX, built, { net: true });
    const port = freePort();

    // `-o` serves one connection and exits. Not `-1`: a leading digit is how this argument
    // parser spells a number, so `serve -8080 -1` set the port to 1 — which is how the
    // first run of this ended up listening on port 1.
    const server = new Deno.Command(built, {
      args: ["serve", `-${port}`, "-o"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const listening = await waitForListening(server, port);
    assertEquals(
      listening.includes(`listening on port ${port}`),
      true,
      "it says where it is listening",
    );
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });

    await conn.write(new TextEncoder().encode(
      `GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    ));
    const parts: Uint8Array[] = [];
    const buf = new Uint8Array(4096);
    for (;;) {
      const n = await conn.read(buf);
      if (n === null) break;
      parts.push(buf.slice(0, n));
    }
    conn.close();
    const reply = new TextDecoder().decode(
      new Uint8Array(parts.flatMap((p) => Array.from(p))),
    );
    assertEquals(reply.startsWith("HTTP/1.1 200 OK\r\n"), true, reply.slice(0, 80));
    assertEquals(reply.includes("wac http server"), true, reply.slice(0, 200));

    server.stdout.cancel();
    assertEquals((await server.status).code, 0, "the server exited cleanly");

    // And the client half against the server half: two wac programs, one socket, no
    // TypeScript in between. Started together — `serve` blocks in `accept` until `get`
    // arrives, which is the whole point of a synchronous capability world.
    const port2 = freePort();
    const server2 = new Deno.Command(built, {
      args: ["serve", `-${port2}`, "-o"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    await waitForListening(server2, port2);
    const client = new Deno.Command(built, {
      args: ["get", "127.0.0.1", "/", `-${port2}`, "-i"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const got = await client;
    const body = new TextDecoder().decode(got.stdout);
    assertEquals(got.code, 0, new TextDecoder().decode(got.stderr));
    assertEquals(body.includes("HTTP 200"), true, body.slice(0, 120));
    assertEquals(body.trimEnd().endsWith("wac http server"), true, body.slice(0, 200));
    server2.stdout.cancel();
    assertEquals((await server2.status).code, 0, "the second server exited cleanly");

    // Without the grant, nothing — whatever the arguments say.
    const noNet = await Deno.makeTempFile({ prefix: "wac-nonet-" });
    try {
      await buildApp(BOX, noNet, {});
      const denied = new Deno.Command(noNet, {
        args: ["get", "127.0.0.1", "/", `-${port}`],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      assertEquals(denied.code, 1);
      assertEquals(
        new TextDecoder().decode(denied.stderr).includes("not granted"),
        true,
        new TextDecoder().decode(denied.stderr),
      );
    } finally {
      await Deno.remove(noNet);
    }
  } finally {
    await Deno.remove(built);
  }
});

Deno.test("box's newest batch: sponge, zstd, json, stat, uuid, shuf, paste, yes", async () => {
  const built = await Deno.makeTempFile({ prefix: "wac-b3-" });
  const dir = await Deno.makeTempDir({ prefix: "wac-b3-d-" });
  try {
    await buildApp(BOX, built, { read: true, write: true });
    const run = (args: string[]) => {
      const r = new Deno.Command(built, { args, stdout: "piped", stderr: "piped" }).outputSync();
      return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
    };
    const pipe = async (args: string[], input: Uint8Array) => {
      const c = new Deno.Command(built, { args, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
      const w = c.stdin.getWriter();
      w.write(input).then(() => w.close());
      return await c.output();
    };
    const enc = new TextEncoder();

    // ── sponge: the applet that only exists because of the atomic write ──
    // `box sort f | box sponge f` works where `sort f > f` cannot, because the shell
    // truncates `f` before `sort` has read a byte of it. That is the whole point.
    const target = `${dir}/inplace`;
    const original = "delta\nalpha\ncharlie\nbravo\n";
    await Deno.writeTextFile(target, original);
    const sorter = new Deno.Command(built, { args: ["sort", target], stdout: "piped" }).outputSync();
    const soak = await pipe(["sponge", target], sorter.stdout);
    assertEquals(soak.code, 0, new TextDecoder().decode(soak.stderr));
    assertEquals(await Deno.readTextFile(target), "alpha\nbravo\ncharlie\ndelta\n", "sorted in place");
    // And no temporary file survived it.
    const left: string[] = [];
    for await (const e of Deno.readDir(dir)) left.push(e.name);
    assertEquals(left.join(","), "inplace", `left behind: ${left}`);

    // ── zstd: the largest package here, round-tripped ──
    const raw = await Deno.readFile("README.md");
    const squeezed = (await pipe(["zstd"], raw)).stdout;
    assertEquals(squeezed.length < raw.length, true, "zstd did not compress");
    assertSameBytes((await pipe(["unzstd"], squeezed)).stdout, raw, "zstd round trip");

    // ── json: canonical output, and a real parse error ──
    const canon = await pipe(["json", "-c"], enc.encode(`{"b":1,"a":[2, 3 ],"c":"x"}`));
    assertEquals(new TextDecoder().decode(canon.stdout).trim(), `{"b":1,"a":[2,3],"c":"x"}`);
    // Two spellings of the same document canonicalise identically, which is the property
    // that makes this worth having on a pipe rather than a pretty-printer.
    const spaced = await pipe(["json", "-c"], enc.encode(`{ "b" : 1 , "a" : [ 2 , 3 ] , "c" : "x" }`));
    assertEquals(new TextDecoder().decode(spaced.stdout), new TextDecoder().decode(canon.stdout));
    // Without -c it is a validator: silent and exit 0, so it composes in a test.
    const valid = await pipe(["json"], enc.encode(`[1,2,3]`));
    assertEquals(valid.code, 0);
    assertEquals(valid.stdout.length, 0, "a validator says nothing");
    const bad = await pipe(["json"], enc.encode(`{"a":}`));
    assertEquals(bad.code, 1);
    assertEquals(new TextDecoder().decode(bad.stderr).includes("invalid JSON at byte"), true);

    // ── stat: the capability nothing surfaced ──
    await Deno.writeTextFile(`${dir}/sized`, "12345");
    const st = run(["stat", `${dir}/sized`, dir]);
    assertEquals(st.code, 0, st.err);
    const rows = st.out.trim().split("\n");
    assertEquals(rows[0].includes(" file 5 "), true, rows[0]);
    assertEquals(rows[1].includes(" directory "), true, rows[1]);
    // The mtime is RFC 3339 and recent, which is `datetime` doing the work.
    const when = Date.parse(rows[0].split(" ").pop()!);
    assertEquals(Math.abs(when - Date.now()) < 120_000, true, rows[0]);
    assertEquals(run(["stat", `${dir}/absent`]).code, 1, "a missing path is an error");

    // ── uuid: version 4, and different every time ──
    const ids = run(["uuid", "-20"]).out.trim().split("\n");
    assertEquals(ids.length, 20);
    for (const id of ids) {
      assertEquals(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
        true,
        `not a v4 uuid: ${id}`,
      );
    }
    assertEquals(new Set(ids).size, 20, "twenty draws should be twenty values");

    // ── shuf: a permutation, not a sample ──
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
    await Deno.writeTextFile(`${dir}/lines`, lines.join("\n") + "\n");
    const shuffled = run(["shuf", `${dir}/lines`]).out.trim().split("\n");
    assertEquals(shuffled.length, 200);
    assertEquals(shuffled.slice().sort().join(","), lines.slice().sort().join(","), "same lines");
    assertEquals(shuffled.join(",") !== lines.join(","), true, "and in some other order");
    assertEquals(run(["shuf", "-5", `${dir}/lines`]).out.trim().split("\n").length, 5);

    // ── paste, against the real one ──
    await Deno.writeTextFile(`${dir}/p1`, "a\nb\n");
    await Deno.writeTextFile(`${dir}/p2`, "1\n2\n3\n");
    const sys = new Deno.Command("paste", {
      args: [`${dir}/p1`, `${dir}/p2`], stdout: "piped", stderr: "null",
    }).outputSync();
    assertEquals(run(["paste", `${dir}/p1`, `${dir}/p2`]).out, new TextDecoder().decode(sys.stdout));

    // ── yes: the only applet that never ends on its own ──
    // It stops because `write` reports the closed pipe. Without that answer it would spin,
    // which is why `write` returns a bool at all.
    const yes = new Deno.Command(built, { args: ["yes", "wac"], stdout: "piped", stderr: "null" }).spawn();
    const reader = yes.stdout.getReader();
    const first = await reader.read();
    assertEquals(new TextDecoder().decode(first.value).startsWith("wac\nwac\n"), true);
    await reader.cancel();
    const status = await yes.status;
    assertEquals(status.success || status.signal !== null, true, "yes stopped when the pipe closed");
  } finally {
    await Deno.remove(built);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("httpd serves a directory, and refuses to leave it", async () => {
  // The first applet that composes the network *and* the filesystem. The path check is the
  // part worth testing hardest: a request target is the one input here that is supposed to
  // be hostile, and `..` is refused outright rather than resolved, because resolving is
  // where traversal bugs live.
  const built = await Deno.makeTempFile({ prefix: "wac-httpd-" });
  const root = await Deno.makeTempDir({ prefix: "wac-httpd-www-" });
  try {
    await buildApp(BOX, built, { read: true, net: true });
    await Deno.writeTextFile(`${root}/index.html`, "<h1>hi</h1>\n");
    await Deno.writeTextFile(`${root}/notes.txt`, "plain\n");
    await Deno.mkdir(`${root}/sub`);
    await Deno.writeTextFile(`${root}/sub/index.html`, "deep\n");
    // The file the traversal case is trying to reach, one level above the root.
    await Deno.writeTextFile(`${root}/../wac-httpd-secret.txt`, "should not be served\n");

    const request = async (target: string) => {
      const port = freePort();
      const server = new Deno.Command(built, {
        args: ["httpd", `-${port}`, root, "-o"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await waitForListening(server, port);
      // Cancel both pipes before waiting on the child. Deno will not resolve `status`
      // while a piped stream is unread, so cancelling *after* it is a deadlock — which is
      // how the first version of this test hung rather than failed.
      server.stdout.cancel();
      server.stderr.cancel();
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      await conn.write(new TextEncoder().encode(
        `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      ));
      const parts: number[] = [];
      const buf = new Uint8Array(4096);
      for (;;) {
        const n = await conn.read(buf);
        if (n === null) break;
        parts.push(...buf.slice(0, n));
      }
      conn.close();
      await server.status;
      return new TextDecoder().decode(new Uint8Array(parts));
    };

    const index = await request("/");
    assertEquals(index.startsWith("HTTP/1.1 200 OK\r\n"), true, index.slice(0, 60));
    // From the *resolved* path, not the target: `/` becomes `index.html`, and typing that
    // as application/octet-stream would make a browser download the page instead.
    assertEquals(index.includes("Content-Type: text/html"), true, index.slice(0, 200));
    assertEquals(index.trimEnd().endsWith("<h1>hi</h1>"), true);

    const txt = await request("/notes.txt");
    assertEquals(txt.includes("Content-Type: text/plain"), true, txt.slice(0, 200));

    // A directory resolves to its index, with or without the trailing slash.
    assertEquals((await request("/sub/")).trimEnd().endsWith("deep"), true);
    assertEquals((await request("/sub")).trimEnd().endsWith("deep"), true);

    // The query is not part of the path.
    assertEquals((await request("/notes.txt?v=2")).trimEnd().endsWith("plain"), true);

    assertEquals((await request("/nope")).startsWith("HTTP/1.1 404 "), true);
    assertEquals((await request("/../wac-httpd-secret.txt")).startsWith("HTTP/1.1 403 "), true);
    assertEquals((await request("/sub/../../wac-httpd-secret.txt")).startsWith("HTTP/1.1 403 "), true);
    // A relative target never reaches the path check: `packages/http` rejects an
    // origin-form target without a leading slash as malformed, which is 400 rather than
    // 403. Asserted as 400 because that is what happens, not because it is what I guessed.
    assertEquals((await request("notes.txt")).startsWith("HTTP/1.1 400 "), true);
    assertEquals((await request("/a\\b")).startsWith("HTTP/1.1 403 "), true);

    const post = await (async () => {
      const port = freePort();
      const server = new Deno.Command(built, {
        args: ["httpd", `-${port}`, root, "-o"], stdout: "piped", stderr: "piped",
      }).spawn();
      await waitForListening(server, port);
      server.stdout.cancel();
      server.stderr.cancel();
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      await conn.write(new TextEncoder().encode(
        `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      ));
      const buf = new Uint8Array(256);
      const n = await conn.read(buf);
      conn.close();
      await server.status;
      return new TextDecoder().decode(buf.slice(0, n ?? 0));
    })();
    assertEquals(post.startsWith("HTTP/1.1 405 "), true, post.slice(0, 60));
  } finally {
    await Deno.remove(built);
    await Deno.remove(root, { recursive: true });
    try { await Deno.remove(`${root}/../wac-httpd-secret.txt`); } catch { /* gone with the dir */ }
  }
});

Deno.test("split writes many files, and wget writes one", async () => {
  // `split` is the first applet to open more than one output — everything else opens a
  // file, writes it and closes it. `wget` is `get` with the output pointed at a file, and
  // is three lines different from it: `openOutput` moves where `cli.write` goes, so the
  // fetch does not know.
  const built = await Deno.makeTempFile({ prefix: "wac-split-" });
  const dir = await Deno.makeTempDir({ prefix: "wac-split-d-" });
  try {
    await buildApp(BOX, built, { read: true, write: true, net: true });
    const lines = Array.from({ length: 250 }, (_, i) => `${i + 1}`).join("\n") + "\n";
    await Deno.writeTextFile(`${dir}/big.txt`, lines);

    const run = (args: string[], cwd: string) =>
      new Deno.Command(built, { args, cwd, stdout: "piped", stderr: "piped" }).outputSync();
    assertEquals(run(["split", "-100", "big.txt", "part-"], dir).code, 0);

    // Against the real one, piece for piece.
    new Deno.Command("split", { args: ["-l", "100", "big.txt", "real-"], cwd: dir }).outputSync();
    for (const s of ["aa", "ab", "ac"]) {
      assertEquals(
        await Deno.readTextFile(`${dir}/part-${s}`),
        await Deno.readTextFile(`${dir}/real-${s}`),
        `part-${s} differs`,
      );
    }
    // And no fourth piece: an exact boundary must not open a file it never writes to.
    let missing = false;
    try { await Deno.stat(`${dir}/part-ad`); } catch { missing = true; }
    assertEquals(missing, true, "an empty fourth piece was created");

    // wget, against box's own httpd — two wac programs and a file at the end of it.
    const port = freePort();
    const server = new Deno.Command(built, {
      args: ["httpd", `-${port}`, dir, "-o"], stdout: "piped", stderr: "piped",
    }).spawn();
    await waitForListening(server, port);
    server.stdout.cancel();
    server.stderr.cancel();
    const got = run(["wget", "127.0.0.1", "/big.txt", "saved.txt", `-${port}`], dir);
    assertEquals(got.code, 0, new TextDecoder().decode(got.stderr));
    assertEquals(await Deno.readTextFile(`${dir}/saved.txt`), lines, "wget saved the body");
    await server.status;
  } finally {
    await Deno.remove(built);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tar writes an archive GNU tar can read", async () => {
  // The widest applet here: `readDir` and `stat` to walk a tree, `readFile` per entry,
  // `write` to stream it out. Tested against the real format rather than against itself —
  // a round trip with its own reader would pass with a checksum that is wrong in a
  // self-consistent way, which is exactly the mistake ustar's checksum invites.
  const built = await Deno.makeTempFile({ prefix: "wac-tar-" });
  const dir = await Deno.makeTempDir({ prefix: "wac-tar-d-" });
  try {
    await buildApp(BOX, built, { read: true, write: true });
    await Deno.mkdir(`${dir}/src/deep`, { recursive: true });
    // An empty directory only survives if the directory's own entry is written.
    await Deno.mkdir(`${dir}/src/empty`);
    await Deno.writeTextFile(`${dir}/src/a.txt`, "hello\n");
    await Deno.writeTextFile(`${dir}/src/deep/b.txt`, "world\n");
    // Exactly one block, so the padding path has to write nothing rather than a block.
    await Deno.writeFile(`${dir}/src/exact.dat`, new Uint8Array(512).fill(7));
    // And one that is not, so it has to write some.
    await Deno.writeFile(`${dir}/src/ragged.dat`, new Uint8Array(700).fill(9));

    const tar = new Deno.Command(built, {
      args: ["tar", "src"], cwd: dir, stdout: "piped", stderr: "piped",
    }).outputSync();
    assertEquals(tar.code, 0, new TextDecoder().decode(tar.stderr));
    await Deno.writeFile(`${dir}/out.tar`, tar.stdout);
    // Two zero blocks end an archive; without them GNU tar reads the entries and then
    // says "unexpected EOF", which a round trip with itself would not notice.
    assertEquals(tar.stdout.length % 512, 0, "an archive is whole blocks");

    const listed = new Deno.Command("tar", {
      args: ["-tf", "out.tar"], cwd: dir, stdout: "piped", stderr: "piped",
    }).outputSync();
    assertEquals(listed.code, 0, new TextDecoder().decode(listed.stderr));
    const entries = new TextDecoder().decode(listed.stdout).trim().split("\n").sort();
    assertEquals(
      entries.join(","),
      "src/,src/a.txt,src/deep/,src/deep/b.txt,src/empty/,src/exact.dat,src/ragged.dat",
      entries.join(","),
    );

    // Extraction, compared tree to tree. This is the assertion that the checksum, the
    // sizes and the padding are all right at once.
    await Deno.mkdir(`${dir}/ex`);
    const ex = new Deno.Command("tar", {
      args: ["-xf", "out.tar", "-C", "ex"], cwd: dir, stderr: "piped",
    }).outputSync();
    assertEquals(ex.code, 0, new TextDecoder().decode(ex.stderr));
    const diff = new Deno.Command("diff", {
      args: ["-r", "src", "ex/src"], cwd: dir, stdout: "piped", stderr: "piped",
    }).outputSync();
    assertEquals(diff.code, 0, new TextDecoder().decode(diff.stdout));

    // And through box's own compressor, which is the composition worth having.
    const gz = new Deno.Command(built, {
      args: ["gzip"], cwd: dir, stdin: "piped", stdout: "piped",
    }).spawn();
    const w = gz.stdin.getWriter();
    w.write(tar.stdout).then(() => w.close());
    await Deno.writeFile(`${dir}/out.tgz`, (await gz.output()).stdout);
    await Deno.mkdir(`${dir}/ex2`);
    const ex2 = new Deno.Command("tar", {
      args: ["-xzf", "out.tgz", "-C", "ex2"], cwd: dir, stderr: "piped",
    }).outputSync();
    assertEquals(ex2.code, 0, new TextDecoder().decode(ex2.stderr));
    const diff2 = new Deno.Command("diff", {
      args: ["-r", "src", "ex2/src"], cwd: dir, stdout: "piped",
    }).outputSync();
    assertEquals(diff2.code, 0, new TextDecoder().decode(diff2.stdout));

    assertEquals(
      new Deno.Command(built, { args: ["tar", "absent"], cwd: dir, stderr: "piped" })
        .outputSync().code,
      1,
      "a missing path is an error",
    );
  } finally {
    await Deno.remove(built);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("diff agrees with the real one, unified output and exit status", async () => {
  // The one applet here that is an algorithm rather than plumbing, so it gets the widest
  // differential test: every shape below is compared byte for byte against `diff -u`.
  // That is what caught the hunk header for an empty side — a zero-length side starts at
  // line 0, not 1, which is the sort of convention no amount of reasoning produces.
  const built = await Deno.makeTempFile({ prefix: "wac-diff-" });
  const dir = await Deno.makeTempDir({ prefix: "wac-diff-d-" });
  try {
    await buildApp(BOX, built, { read: true });
    const seq = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}`).join("\n") + "\n";

    const cases: Array<{ what: string; a: string; b: string }> = [
      { what: "one change", a: seq(8), b: seq(8).replace("\n3\n", "\nX\n") },
      { what: "two distant hunks", a: seq(30), b: seq(30).replace("\n5\n", "\nfive\n").replace("\n25\n", "\ntwentyfive\n") },
      // Closer than twice the context, so they must merge into one hunk rather than two.
      { what: "two close changes merge", a: seq(30), b: seq(30).replace("\n5\n", "\nfive\n").replace("\n7\n", "\nseven\n") },
      { what: "a deletion", a: seq(30), b: seq(30).replace("\n13\n", "\n") },
      { what: "an insertion", a: seq(30), b: seq(30).replace("\n13\n", "\ninserted\n13\n") },
      { what: "change on the first line", a: seq(30), b: `one\n${seq(30).slice(2)}` },
      { what: "change on the last line", a: seq(30), b: seq(30).replace(/30\n$/, "thirty\n") },
      { what: "truncated", a: seq(30), b: seq(5) },
      { what: "appended", a: seq(30), b: seq(40) },
      { what: "fully reversed", a: seq(20), b: seq(20).trim().split("\n").reverse().join("\n") + "\n" },
      // The three empty cases: the hunk header's line numbers are the whole point.
      { what: "new file is empty", a: seq(30), b: "" },
      { what: "old file is empty", a: "", b: seq(30) },
      { what: "both empty", a: "", b: "" },
      { what: "identical", a: seq(30), b: seq(30) },
    ];

    for (const c of cases) {
      await Deno.writeTextFile(`${dir}/a`, c.a);
      await Deno.writeTextFile(`${dir}/b`, c.b);
      const mine = new Deno.Command(built, {
        args: ["diff", "a", "b"], cwd: dir, stdout: "piped", stderr: "piped",
      }).outputSync();
      const real = new Deno.Command("diff", {
        args: ["-u", "a", "b"], cwd: dir, stdout: "piped", stderr: "null",
      }).outputSync();

      // The `---`/`+++` header carries timestamps in the real one, so compare from the
      // first hunk. Everything after it, including every hunk header, must match.
      const body = (s: string) => s.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++")).join("\n");
      assertEquals(
        body(new TextDecoder().decode(mine.stdout)),
        body(new TextDecoder().decode(real.stdout)),
        c.what,
      );
      // 0 the same, 1 different, 2 trouble — as the real one does.
      assertEquals(mine.code, real.code, `${c.what}: exit status`);
    }

    // A pair too large is refused rather than attempted: the table is quadratic in memory
    // as well as time, and dying on a big file would be worse than saying so.
    await Deno.writeTextFile(`${dir}/big`, seq(5000));
    const refused = new Deno.Command(built, {
      args: ["diff", "big", "a"], cwd: dir, stdout: "piped", stderr: "piped",
    }).outputSync();
    assertEquals(refused.code, 2, "an oversized diff is trouble, not a wrong answer");
    assertEquals(
      new TextDecoder().decode(refused.stderr).includes("quadratic"),
      true,
      "and it says why",
    );
  } finally {
    await Deno.remove(built);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gets: TLS 1.3 in wac, against a real TLS server", async () => {
  // `packages/tls` needed no changes for this. `tlsClientInit`/`tlsClientFeed` are a state
  // machine over byte arrays — the same shape `packages/server` has — and a state machine
  // is what a socket wants. The applet is the driver and nothing else.
  //
  // The server is Deno's own TLS stack with this repo's test certificate, so the handshake
  // is against a real implementation rather than against the same code playing both parts.
  // It runs as a *subprocess*: an in-process `Deno.listenTls` and this test runner do not
  // compose, and chasing that is not what this test is for.
  const built = await Deno.makeTempFile({ prefix: "wac-tls-" });
  const dir = await Deno.makeTempDir({ prefix: "wac-tls-d-" });
  try {
    await buildApp(BOX, built, { read: true, net: true });
    const data = `${Deno.cwd()}/packages/tls/test/data`;
    // The trust store the client is handed: DER, because that is what a certificate is
    // once the PEM armour is off.
    await Deno.writeFile(`${dir}/ca.der`, pemToDer(await Deno.readTextFile(`${data}/ca.pem`)));
    await Deno.writeFile(`${dir}/other.der`, pemToDer(await Deno.readTextFile(`${data}/other_ca.pem`)));

    const body = "hello from a real TLS server\n";
    await Deno.writeTextFile(`${dir}/server.ts`, `
      const cert = await Deno.readTextFile(${JSON.stringify(`${data}/leaf.pem`)});
      const key = await Deno.readTextFile(${JSON.stringify(`${data}/leaf.key`)});
      const l = Deno.listenTls({ hostname: "127.0.0.1", port: Number(Deno.args[0]), cert, key });
      console.error("listening on port " + Deno.args[0]);
      try {
        const conn = await l.accept();
        await conn.read(new Uint8Array(4096));
        await conn.write(new TextEncoder().encode(
          "HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: ${body.length}" +
          "\\r\\nConnection: close\\r\\n\\r\\n${body.trimEnd()}\\n"));
        conn.close();
      } catch { /* the client refused the certificate, which is a case below */ }
      l.close();
    `);

    const startServer = async () => {
      const port = freePort();
      const p = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", `${dir}/server.ts`, `${port}`],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await waitForListening(p, port);
      p.stdout.cancel();
      p.stderr.cancel();
      return { port, p };
    };

    // `localhost` is in the certificate's SAN, and `ca.der` signed it.
    const good = await startServer();
    const ok = await new Deno.Command(built, {
      args: ["gets", "localhost", "/", `${dir}/ca.der`, `-${good.port}`, "-i"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    await good.p.status;
    const out = new TextDecoder().decode(ok.stdout);
    assertEquals(ok.code, 0, new TextDecoder().decode(ok.stderr));
    assertEquals(out.includes("HTTP 200"), true, out.slice(0, 200));
    assertEquals(out.trimEnd().endsWith(body.trimEnd()), true, out.slice(0, 300));

    // The check is the point. A root that did not sign this certificate must fail, and
    // fail *before* any application data — a client that verified after reading the body
    // would pass a test that only looked at the exit code.
    const bad = await startServer();
    const refused = await new Deno.Command(built, {
      args: ["gets", "localhost", "/", `${dir}/other.der`, `-${bad.port}`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    await bad.p.status;
    assertEquals(refused.code, 1, "an untrusted root must not connect");
    assertEquals(refused.stdout.length, 0, "and must produce no body at all");
    assertEquals(
      new TextDecoder().decode(refused.stderr).includes("connection failed"),
      true,
      new TextDecoder().decode(refused.stderr),
    );
  } finally {
    await Deno.remove(built);
    await Deno.remove(dir, { recursive: true });
  }
});

/** The DER inside PEM armour. */
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.split("\n").filter((l) => !l.startsWith("-----")).join("");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

Deno.test("nc relays both directions at once", async () => {
  // The applet that could not be written until `waitAny` existed. A relay has to watch the
  // socket *and* standard input: wait on the socket alone and a client that speaks first is
  // never heard; wait on stdin alone and a server that greets you is never printed. Standard
  // input is handle 0, so both sides are the same primitive — two `recv` in flight and a
  // park on whichever answers.
  //
  // The peer here greets *before* reading, so a relay that serviced stdin first would hang
  // and a relay that serviced the socket first would never send. Only watching both passes.
  const built = await Deno.makeTempFile({ prefix: "wac-nc-" });
  try {
    await buildApp(BOX, built, { net: true });

    const port = freePort();
    const seen: string[] = [];
    const peer = (async () => {
      const l = Deno.listen({ hostname: "127.0.0.1", port });
      try {
        const c = await l.accept();
        await c.write(new TextEncoder().encode("peer speaks first\n"));
        const buf = new Uint8Array(4096);
        const n = await c.read(buf);
        seen.push(new TextDecoder().decode(buf.subarray(0, n ?? 0)).trimEnd());
        c.close();
      } catch { /* the client may have closed first */ }
      try { l.close(); } catch { /* already closed */ }
    })();

    const nc = new Deno.Command(built, {
      args: ["nc", "127.0.0.1", `${port}`],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = nc.stdin.getWriter();
    await w.write(new TextEncoder().encode("client speaks second\n"));
    await w.close();

    const out = await nc.output();
    await peer;
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    // Downstream: the greeting arrived even though stdin had something waiting.
    assertEquals(
      new TextDecoder().decode(out.stdout).trimEnd(),
      "peer speaks first",
      "the peer's greeting did not reach standard output",
    );
    // Upstream: and what stdin held was sent.
    assertEquals(seen.join(""), "client speaks second", "standard input did not reach the peer");
  } finally {
    await Deno.remove(built);
  }
});

Deno.test("nc -l takes one connection", async () => {
  const built = await Deno.makeTempFile({ prefix: "wac-ncl-" });
  try {
    await buildApp(BOX, built, { net: true });
    const port = freePort();
    const server = new Deno.Command(built, {
      args: ["nc", `-${port}`, "-l"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // It prints the same "listening on port" line `serve` and `httpd` do, which is what a
    // caller waits for rather than sleeping.
    await waitForListening(server, port);
    server.stderr.cancel();

    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    await conn.write(new TextEncoder().encode("over the wire\n"));
    conn.close();
    const sw = server.stdin.getWriter();
    await sw.close();

    const out = await server.output();
    assertEquals(
      new TextDecoder().decode(out.stdout).trimEnd(),
      "over the wire",
      "the listener did not relay what it was sent",
    );
  } finally {
    await Deno.remove(built);
  }
});

Deno.test("the README states the applet count the dispatcher actually has", async () => {
  // Prose numbers drift silently. This one said fifty-nine when there were sixty, and
  // forty-two in a paragraph further down, both written by someone who had just counted.
  const dispatch = await Deno.readTextFile("packages/box/src/box.wac");
  const readme = await Deno.readTextFile("packages/box/README.md");
  const actual = [...dispatch.matchAll(/if \(applet == "[a-z0-9-]+"/g)].length;
  const claimed = Number(readme.match(/^(\d+) applets/m)?.[1] ?? 0);
  assertEquals(claimed, actual, `the README says ${claimed} applets, box.wac dispatches ${actual}`);
  // And the aside in the `bin/` section, which drifted independently of the first line.
  assertEquals(
    readme.includes("with sixty entry points"),
    actual === 60,
    "the `bin/` section names the count too, in words",
  );
});

Deno.test("seq matches GNU seq, in all three spellings", async () => {
  // Filed under "a tool named after a real one either matches it or says where it does not".
  // `seq 1 5` used to print `1`: the first argument was taken as a count and the second was
  // dropped, which is the worst shape a divergence can take — a plausible answer, silently. It
  // was found by running the same command in a browser and in a terminal side by side.
  const real = await new Deno.Command("seq", { args: ["--version"], stdout: "null", stderr: "null" })
    .output().then((r) => r.success).catch(() => false);
  if (!real) return;   // no oracle, no test

  const built = await Deno.makeTempFile({ prefix: "wac-seq-" });
  try {
    await buildApp(BOX, built, {});
    const box = (args: string[]) => {
      const r = new Deno.Command(built, { args, stdout: "piped", stderr: "piped" }).outputSync();
      return {
        code: r.code,
        out: new TextDecoder().decode(r.stdout),
        err: new TextDecoder().decode(r.stderr),
      };
    };

    for (
      const args of [
        ["5"],
        ["1", "5"],
        ["3", "7"],
        ["1", "2", "9"],
        ["10", "-3", "1"],   // counting down
        ["5", "1"],          // an empty range: nothing, and not an error
        ["0"],
        ["-3", "3"],
      ]
    ) {
      const sys = new Deno.Command("seq", { args, stdout: "piped", stderr: "piped" }).outputSync();
      const ours = box(["seq", ...args]);
      assertEquals(ours.out, new TextDecoder().decode(sys.stdout), `seq ${args.join(" ")}`);
      assertEquals(ours.code, sys.code, `seq ${args.join(" ")} exit status`);
    }

    // A zero step loops forever if nobody checks, so it is refused rather than attempted.
    const zero = box(["seq", "1", "0", "9"]);
    assertEquals(zero.code, 1);
    assertEquals(zero.err.includes("must not be zero"), true, zero.err);
  } finally {
    await Deno.remove(built);
  }
});
