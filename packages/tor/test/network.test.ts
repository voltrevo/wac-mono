// The launcher: does it bring nodes up, notice when one does not, and report the work honestly?
//
// Deliberately **not** a Tor network. `src/network.wac` knows about processes and ready markers, not
// about relays, and testing it against three relays would mean this test fails whenever anything in
// the tor stack does — plus it would bind the fixed ports a signed descriptor advertises, so two
// agents running the suite at once would collide. `packages/platform/example/waiter.wac` exists to be started and
// killed and `example/wc.wac` exits 0 or 1 on demand, which is the whole vocabulary the launcher has.
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
  await Deno.writeTextFile(`${dir}/counted.txt`, "one two three\n");
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
