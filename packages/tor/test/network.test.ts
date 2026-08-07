// The launcher: does it bring nodes up, notice when one does not, and report the work honestly?
//
// Deliberately **not** a Tor network. `src/network.wac` knows about processes and ready markers, not
// about relays, and testing it against three relays would mean this test fails whenever anything in
// the tor stack does. `packages/platform/example/waiter.wac` exists to be started and killed and
// `example/wc.wac` exits 0 or 1 on demand, which is the whole vocabulary the launcher has.
//
// It used to also say that a Tor network here would bind the fixed ports a signed descriptor
// advertises, so two agents running the suite would collide. That is no longer true — a relay takes
// `-p 0` and announces the port it got, and the `{name}` cases below are how a later directive reads
// it. The reason this file stays away from relays is now only the first one.
//
// What is checked is the part that made every shell script this replaces untrustworthy:
//
//   - a node is waited *for*, not slept on
//   - a node that never announces itself fails the run, by name, rather than being assumed up
//   - the exit code of the work is the exit code of the run — a network that came up and a fetch that
//     failed must not read as success
//
// The tor network itself is stood up by `packages/tor/README.md`'s recipe rather than by the suite,
// for the port reason above. That is a stated limitation, not an oversight.

import { buildApp } from "../../platform/build.ts";
import "../../../harness/spawnRetry.ts";

function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

function assertContains(haystack: string, needle: string, msg?: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `expected output to contain ${JSON.stringify(needle)}${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got: ${haystack}`,
    );
  }
}

/** One built launcher and its two child bundles, shared by every case here. */
async function fixture(): Promise<{ dir: string; launcher: string }> {
  const dir = await Deno.makeTempDir({ prefix: "wac-network-" });
  const launcher = `${dir}/network`;
  await buildApp("packages/tor/src/network.wac", launcher, { read: true, write: true, net: true });
  await buildApp("packages/platform/example/waiter.wac", `${dir}/waiter.worker.js`, {}, "deno", true);
  await buildApp("packages/platform/example/wc.wac", `${dir}/wc.worker.js`, {}, "deno", true);
  // Two-stage: prints `stages: listening`, waits, then `stages: serving`. The second line cannot
  // already have arrived when the ready marker resolves, which is what makes the `wait` cases below
  // test the waiting rather than the luck.
  await buildApp("packages/platform/example/stages.wac", `${dir}/stages.worker.js`, {}, "deno", true);
  await Deno.writeTextFile(`${dir}/counted.txt`, "one two three\n");
  // Named for what `waiter: running` leaves after the marker `waiter: runn`, which is how the
  // substitution case below gets a value that only exists once the node has spoken.
  await Deno.writeTextFile(`${dir}/ing.txt`, "captured from a ready line\n");
  return { dir, launcher };
}

function run(launcher: string, dir: string, description: string) {
  const r = new Deno.Command(launcher, {
    args: [description],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const dec = new TextDecoder();
  return { code: r.code, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
}

Deno.test("a network comes up, work runs across it, and everything stops", async () => {
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "# two nodes and one piece of work",
        "node alpha | waiter: running | waiter.worker.js",
        "node beta  | waiter: running | waiter.worker.js",
        "run  count |               | wc.worker.js counted.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 0, r.err);
    // Both nodes were seen to announce themselves, by name. "started" is not "up": the first is this
    // program spawning something and the second is that something saying it is ready, and conflating
    // them is precisely the bug the ready marker exists to prevent.
    assertContains(r.err, "alpha is up", "the first node announced itself");
    assertContains(r.err, "beta is up", "the second node announced itself");
    assertContains(r.err, "all 2 nodes are up");
    // The work ran and its output came back through the handle rather than to the terminal.
    assertContains(r.out, "1 3 14", "wc counted the file the description named");
    assertContains(r.err, "network: ok");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a node that never announces itself fails the run, by name", async () => {
  const { dir, launcher } = await fixture();
  try {
    // `alpha` will print "waiter: running" and never this. The timeout is seconds rather than the
    // two-minute default because this case is *expected* to reach it.
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "timeout 4000",
        "node alpha | waiter: running    | waiter.worker.js",
        "node ghost | never printed this | waiter.worker.js",
        "run  count |                    | wc.worker.js counted.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 1, "a network that did not come up is a failed run");
    assertContains(r.err, "ghost never said", "the node that did not come up is named");
    // And the work must not have run. A launcher that pressed on would produce a result from a
    // network that was never up — which is the exact shape of the four scripted runs this replaces.
    assertEquals(r.out.includes("1 3 14"), false, "no work runs across a network that is not up");
    // The one that did come up is not blamed.
    assertEquals(r.err.includes("alpha never said"), false, "a node that is up is not reported down");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the exit code of the work is the exit code of the run", async () => {
  const { dir, launcher } = await fixture();
  try {
    // `wc` on a file that is not there exits 1. Every node comes up, so this separates "the network
    // failed" from "the network was fine and the thing we asked it to do did not work".
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "node alpha | waiter: running | waiter.worker.js",
        "run  count |               | wc.worker.js nosuch.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 1, "the failing work fails the run");
    assertContains(r.err, "all 1 nodes are up", "the network itself was fine");
    assertContains(r.err, "count exited 1");
    assertContains(r.err, "network: failed with 1");

    // The child's two streams stay two. This forwarded both to stdout at first, which put the
    // client's progress in the middle of the document it had just fetched — so redirecting stdout
    // gave a file that had to be cleaned up before anything could read it. With them separate,
    // `network fetch.txt > doc` writes exactly what the work produced.
    assertContains(r.err, "wc: nosuch.txt", "the child's diagnosis reaches the error channel");
    assertEquals(
      r.out.includes("wc: nosuch.txt"),
      false,
      "and not stdout, which belongs to whatever the work produced",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a description with nothing to run is a failure, not a success", async () => {
  const { dir, launcher } = await fixture();
  try {
    // The failure mode this guards: a description whose `run` line was commented out stands the
    // network up, tears it down, and exits 0 — reporting success for having done nothing.
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      ["node alpha | waiter: running | waiter.worker.js", ""].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");
    assertEquals(r.code, 1, "standing a network up is not the same as using it");
    assertContains(r.err, "asks for nothing to be run");

    // And a description with no nodes at all.
    await Deno.writeTextFile(`${dir}/empty.txt`, "run count | | wc.worker.js counted.txt\n");
    const e = run(launcher, dir, "empty.txt");
    assertEquals(e.code, 1, "there is no network to run across");
    assertContains(e.err, "no nodes");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a bundle that is not there is reported against the node that wanted it", async () => {
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "node alpha | waiter: running | waiter.worker.js",
        "node gone  | waiter: running | nosuch.worker.js",
        "run  count |               | wc.worker.js counted.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");
    assertEquals(r.code, 1);
    assertContains(r.err, "gone", "the node is named, not just the file");
    assertEquals(r.out.includes("1 3 14"), false, "no work runs");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a node's ready line supplies an argument to the work that follows", async () => {
  // The point of this, in one sentence: a relay told to bind port 0 is given a port by the operating
  // system, so no description file can name it, but the relay *says* it on the line that makes it
  // ready. Ending the marker before the part that varies makes the rest of that line the node's
  // capture, and `{name}` reaches it. Without this a network can only be stood up on ports agreed in
  // advance, and two agents running the suite collide on them.
  //
  // `waiter` prints `waiter: running`, so a marker of `waiter: runn` captures `ing` — a value that
  // does not appear anywhere in the description and could not have been written into it.
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "node alpha | waiter: runn | waiter.worker.js",
        "run  count |              | wc.worker.js {alpha}.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 0, r.err);
    // `wc` echoes the name it was given, so this is the substituted argument coming back from the
    // child — not just a file that happened to be countable.
    assertContains(r.out, "1 5 27 ing.txt", "wc counted ing.txt, which only {alpha} could have named");
    assertContains(r.err, "network: ok");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a reference to a node that is not in the description fails, by name", async () => {
  // Passing `{relya1}` through as a literal is the failure this program exists to prevent: the client
  // would dial a host called `{relya1}`, fail, and the failure would look like the network rather
  // than like the typo it is.
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "node alpha | waiter: running | waiter.worker.js",
        "run  count |                 | wc.worker.js {alpah}.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 1, "an unresolved reference is a failed run");
    assertContains(r.err, "{alpah} is not a node", "the reference that could not be resolved is named");
    assertEquals(r.err.includes("running count"), false, "and nothing was run with it unresolved");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("braces that are not references are left alone", async () => {
  // A launcher that rewrote every brace could not run a program whose argument is JSON. `{}` is not a
  // name, and `{` with no `}` is not a reference — both reach the child as written.
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(`${dir}/{}.txt`, "literal braces\n");
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "node alpha | waiter: running | waiter.worker.js",
        "run  count |                 | wc.worker.js {}.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 0, r.err);
    assertContains(r.out, "1 2 15", "the file literally called {}.txt was counted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wait holds the next step until a node reaches a later state", async () => {
  // Being up is not one event. A relay listens, and only later finds the documents an authority built
  // from descriptors it could not write until it had bound. `waiter` prints `waiter: running` and then
  // `waiter: still here` a moment afterwards, which is the same two-stage shape: the second line is
  // not available at ready time.
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "node alpha | stages: listening | stages.worker.js",
        "wait alpha | stages: serving   |",
        "run  count |                    | wc.worker.js counted.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 0, r.err);
    assertContains(r.err, "alpha says stages: serving", "the later state was seen, not assumed");
    assertContains(r.out, "1 3 14", "and the work ran after it");
    // Order matters and is the whole point: the wait has to resolve before the run starts.
    const waitedAt = r.err.indexOf("alpha says stages: serving");
    const ranAt = r.err.indexOf("running count");
    assertEquals(waitedAt >= 0 && ranAt > waitedAt, true, "the wait resolved before the work started");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a wait for something a node never says fails the run, by name", async () => {
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "timeout 4000",
        "node alpha | waiter: running | waiter.worker.js",
        "wait alpha | never says this |",
        "run  count |                 | wc.worker.js counted.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 1, "a state never reached is a failed run");
    assertContains(r.err, 'alpha never said "never says this"');
    assertContains(r.err, "what alpha did say", "and what it did say is shown");
    assertEquals(r.err.includes("running count"), false, "the step behind the wait did not run");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a wait naming a node that does not exist fails, by name", async () => {
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "node alpha | waiter: running | waiter.worker.js",
        "wait beta  | waiter: running |",
        "run  count |                 | wc.worker.js counted.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 1);
    assertContains(r.err, "wait names beta, which is not a node");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a wait captures even when the node had already said it", async () => {
  // The capture has to move with the marker on *both* paths, or the same description means different
  // things depending on how fast the node was — a value on a slow machine, an empty string on a quick
  // one. `stages` prints `listening` and then, 300ms later, `serving`; making the second line the
  // ready marker guarantees the first is already in the buffer by the time the wait runs.
  //
  // The two markers capture different things, which is what makes this discriminate: `stages: serving`
  // has nothing after it, so a wait that failed to re-capture would leave the empty string behind and
  // the work would be asked for `.txt`.
  const { dir, launcher } = await fixture();
  try {
    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "node alpha | stages: serving | stages.worker.js",
        "wait alpha | stages: listen  |",
        "run  count |                 | wc.worker.js {alpha}.txt",
        "",
      ].join("\n"),
    );
    const r = run(launcher, dir, "net.txt");

    assertEquals(r.code, 0, r.err);
    assertContains(r.err, 'alpha had already said "stages: listen"', "it did not have to wait");
    assertContains(r.out, "1 5 27 ing.txt", "and the capture moved to the marker it had already seen");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
