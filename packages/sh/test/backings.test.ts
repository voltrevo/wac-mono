// The same scripts on the host's filesystem and on a memory one, required to agree.
//
// wac-mono 0067's "done when", and design/0001's D7: the host filesystem is the reference answer for the
// one in `packages/fs`, so running a script against both and diffing is a VFS test with an oracle rather
// than a set of expectations somebody wrote down. `wacsh` is the host-backed shell and `sealed` is the same
// shell on `Fs.inMemory()` — the only difference between the two programs is which `Fs` they hand the
// shell, which is what makes the comparison meaningful.
//
// **What can be compared.** Only scripts that are self-contained: they create what they read, and they name
// nothing that exists on one side and not the other. `cat /etc/passwd` is not a divergence, it is a
// different world. Anything about *where* the session starts is out too — a sealed session's cwd is `/`
// and a host session's is wherever it was started, so `pwd` differs by construction.
//
// **What this can and cannot see.** The shell normalises a path before either backing does — `d//f`,
// `./d/./f` and `a/b/../b/f` all reach `Fs` already collapsed by `sh.resolve` — so those cases pin the
// shell's normaliser rather than the VFS. What the comparison does see is every decision the *backing*
// makes: what a redirection over a directory answers, what a file used as a directory answers, what `ls` of
// a plain file does, what `rm -r` of a file does, what an empty directory lists as, and every status.
//
// **What cannot be compared yet, and why.** A sealed session does not spawn its applets: a spawned child
// gets a fresh `Fs` and would not see its parent's files. So these run through the in-process path on both
// sides, which means pipelines are compared as pipelines but not as *spawned* pipelines. That hole is
// 0067's next slice and is named there.

import { buildApp } from "../../platform/build.ts";
import "../../../harness/spawnRetry.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const hosted = await Deno.makeTempFile({ prefix: "wac-hosted-" });
const sealed = await Deno.makeTempFile({ prefix: "wac-sealed-" });
globalThis.addEventListener("unload", () => {
  for (const path of [hosted, sealed]) {
    try {
      Deno.removeSync(path);
    } catch {
      // Already gone, or never built.
    }
  }
});
await buildApp("packages/sh/src/sh.wac", hosted, { read: true, write: true, env: true });
await buildApp("packages/sh/src/sealed.wac", sealed, {});

const dec = new TextDecoder();
const ENV = { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };

function run(binary: string, script: string, cwd: string) {
  const r = new Deno.Command(binary, {
    args: ["-c", script],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: ENV,
    clearEnv: true,
  }).outputSync();
  return { code: r.code, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
}

/**
 * Scripts that touch only what they make.
 *
 * Written to exercise the operations `packages/fs` implements — create, read, list, stat, remove, rename,
 * nested directories, truncation, append — because those are the ones where a memory tree can disagree
 * with a real one.
 */
const CASES = [
  // Creating and reading.
  `echo hi > f; cat f`,
  `printf 'a\nb\nc\n' > f; wc -l f`,
  `echo one > f; echo two > f; cat f`,
  `echo one > f; echo two >> f; cat f`,
  `: > empty; wc -c < empty`,
  `echo x > f; cat f; cat f`,
  // Directories.
  `mkdir d; ls`,
  `mkdir d; echo x > d/f; cat d/f`,
  `mkdir -p a/b/c; ls a; ls a/b`,
  `mkdir d; mkdir d; echo status=$?`,
  `mkdir -p d; mkdir -p d; echo status=$?`,
  `mkdir d; ls d; echo status=$?`,
  // Listing, which is where order and hidden entries live.
  `echo b > b; echo a > a; echo c > c; ls`,
  `mkdir d; echo x > d/one; echo y > d/two; ls d`,
  // Removing.
  `echo x > f; rm f; ls; echo status=$?`,
  `rm nothing; echo status=$?`,
  `rm -f nothing; echo status=$?`,
  `mkdir d; rm d; echo status=$?`,
  `mkdir d; echo x > d/f; rm -r d; ls; echo status=$?`,
  // What a path means.
  `mkdir d; cd d; echo x > f; cat f; ls`,
  `mkdir -p a/b; echo x > a/b/f; cat a/b/f`,
  `mkdir d; echo x > d/f; cat ./d/f`,
  `mkdir -p a/b; cd a/b; cat ../../nothing; echo status=$?`,
  // `test`, which is `stat` with a question attached.
  `echo x > f; test -f f && echo isfile`,
  `mkdir d; test -d d && echo isdir`,
  `echo x > f; test -d f || echo notdir`,
  `test -e nothing || echo absent`,
  `echo x > f; test -s f && echo nonempty`,
  `: > empty; test -s empty; echo status=$?`,
  // Reading what is not there, and reading a directory rather than a file.
  `cat nothing; echo status=$?`,
  `mkdir d; cat d; echo status=$?`,
  `wc -l nothing; echo status=$?`,
  // Several files at once, where the shape of the answer is more than one line.
  `echo a > f1; echo bb > f2; wc -c f1 f2`,
  `echo a > f1; echo b > f2; cat f1 f2`,
  `echo a > f1; echo b > f2; cat f1 nothing f2; echo status=$?`,
  // Globs, which are `readDir` with a filter.
  `echo a > a.txt; echo b > b.txt; echo c > c.log; cat *.txt`,
  `echo a > a.txt; ls *.txt`,
  `echo a > a.txt; cat *.nope; echo status=$?`,
  // A pipeline, in process on both sides.
  `printf '3\n1\n2\n' > f; sort f | head -1`,
  `seq 1 20 > f; wc -l < f`,
  // The edges, which is where a tree written by hand disagrees with one the kernel keeps. Each of these
  // was added because it is a decision `packages/fs` had to make and might have made differently.
  `mkdir d; ls d/`,                                  // a trailing slash
  `mkdir d; echo x > d/f; cat d//f`,                  // a doubled separator
  `mkdir d; echo x > d/f; cat ./d/./f`,               // `.` inside a path
  `mkdir -p a/b; echo x > a/b/f; cat a/b/../b/f`,     // `..` in the middle
  `cd /; cd ..; pwd`,                                 // `..` at the root
  `echo x > f; rm -r f; ls; echo status=$?`,           // recursive removal of a plain file
  `mkdir d; echo x > d; echo status=$?`,               // redirecting over a directory
  `echo x > f; cat f/g; echo status=$?`,               // a file used as a directory
  `echo x > f; mkdir f; echo status=$?`,               // a directory where a file is
  `echo x > f; ls f`,                                  // listing a plain file
  `echo x > 'a b'; ls; cat 'a b'`,                     // a space in a name
  `echo x > .hidden; ls; cat .hidden`,                 // a leading dot
  `mkdir -p a/b/c; rm -r a; ls; echo status=$?`,        // removing a tree
  `mkdir d; cd d; cd ..; echo x > f; ls`,              // leaving and coming back
  `echo x > f; test -f ./f && echo isfile`,            // `stat` through a relative path
  `mkdir d; test -d d/ && echo isdir`,                 // `stat` with a trailing slash
];

Deno.test("every filesystem script answers the same on the host and in memory", async () => {
  const differences: string[] = [];
  for (const script of CASES) {
    // A directory each, on the host side, so one case cannot see another's files. The sealed side gets a
    // fresh filesystem per run for free, which is itself the thing being compared.
    const dir = await Deno.makeTempDir({ prefix: "wac-backing-" });
    try {
      const host = run(hosted, script, dir);
      const memory = run(sealed, script, dir);
      if (host.out !== memory.out || host.code !== memory.code) {
        differences.push(
          `script: ${JSON.stringify(script)}\n` +
            `  host:   ${JSON.stringify(host.out)} exit ${host.code}\n` +
            `  memory: ${JSON.stringify(memory.out)} exit ${memory.code}` +
            (memory.err.trim() === "" ? "" : `\n  memory stderr: ${memory.err.trim().split("\n")[0]}`) +
            (host.err.trim() === "" ? "" : `\n  host stderr:   ${host.err.trim().split("\n")[0]}`),
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
  assertEquals(
    differences.join("\n\n"),
    "",
    `${differences.length} of ${CASES.length} scripts differ between the backings:\n\n` +
      differences.join("\n\n"),
  );
});

Deno.test("...and the host side of that comparison agrees with bash", async () => {
  // The point of this one is transitivity. The memory backing is compared against the host backing above;
  // this compares the host backing against GNU. Together they say the memory filesystem answers what bash
  // answers — which is a much stronger claim than "it matches expectations somebody wrote down", and it
  // costs one more run of the same list.
  //
  // The corpus in `differential.test.ts` covers the shell against bash far more broadly. This is here so
  // that *this file's* cases are known to be bash-true, since they are the ones the memory backing is
  // measured against: a case where both of our shells are wrong the same way would otherwise pass here
  // while being a bug on both sides.
  const differences: string[] = [];
  for (const script of CASES) {
    const theirs = await Deno.makeTempDir({ prefix: "wac-bash-" });
    const ours = await Deno.makeTempDir({ prefix: "wac-host-" });
    try {
      const bash = run("bash", script, theirs);
      const host = run(hosted, script, ours);
      if (bash.out !== host.out || bash.code !== host.code) {
        differences.push(
          `script: ${JSON.stringify(script)}\n` +
            `  bash: ${JSON.stringify(bash.out)} exit ${bash.code}\n` +
            `  ours: ${JSON.stringify(host.out)} exit ${host.code}`,
        );
      }
    } finally {
      await Deno.remove(theirs, { recursive: true });
      await Deno.remove(ours, { recursive: true });
    }
  }
  assertEquals(
    differences.join("\n\n"),
    "",
    `${differences.length} of ${CASES.length} scripts differ from bash:\n\n${differences.join("\n\n")}`,
  );
});
