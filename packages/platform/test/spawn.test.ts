// Spawning a wac program from a wac program.
//
// The design claim under test is that **a child is a handle**: `send` is its standard input,
// `recv` is its output, `closeFeed` ends its input without stopping it, `exitCode` waits, and
// `waitAny` works across a child and a socket together because neither knows what the other
// is. If any of that needed a child-shaped special case, the design would be wrong.

import { buildApp } from "../build.ts";
import { WORKER_MARKER } from "../host/children.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

Deno.test("a wac program runs another wac program as a worker", async () => {
  const runner = await Deno.makeTempFile({ prefix: "wac-runner-" });
  const child = await Deno.makeTempFile({ prefix: "wac-child-", suffix: ".worker.js" });
  try {
    await buildApp("packages/platform/example/runner.wac", runner, { read: true });
    // `--worker` emits the worker bundle alone — the half that expects a SharedArrayBuffer by
    // postMessage. That is what `spawn` takes, and it is how a wac program becomes a child.
    await buildApp("packages/platform/example/wc.wac", child, {}, "deno", true);

    // No shebang and not executable: a worker bundle is not a program of its own, and giving
    // it one would invite someone to run it and get silence.
    const head = (await Deno.readTextFile(child)).slice(0, 2);
    assertEquals(head === "#!", false, "a worker bundle must not look runnable");

    const r = new Deno.Command(runner, {
      args: [child, "one two three"],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();

    assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
    // The child counted what the parent sent it, and its output came back through the handle
    // rather than to the terminal — which is the whole of the plumbing being right.
    assertEquals(
      new TextDecoder().decode(r.stdout).trim(),
      "1 3 14",
      new TextDecoder().decode(r.stdout),
    );
  } finally {
    await Deno.remove(runner);
    await Deno.remove(child);
  }
});

Deno.test("a source that is not a program is a failed child, not a dead parent — 0021", async () => {
  // Not a shell test. `packages/sh` was where this was found, but the parent here is platform's
  // own example: a worker whose source does not parse throws while loading, and that error is not
  // contained by default — it reached the parent, which died with Deno's own message on stderr
  // before it could call the child failed. wac-mono issue 0021.
  const runner = await Deno.makeTempFile({ prefix: "wac-runner-" });
  const notAProgram = await Deno.makeTempFile({ prefix: "wac-bad-", suffix: ".worker.js" });
  try {
    await buildApp("packages/platform/example/runner.wac", runner, { read: true });
    await Deno.writeTextFile(notAProgram, "this is not javascript {{{\n");

    const r = new Deno.Command(runner, {
      args: [notAProgram, "anything"],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    const err = new TextDecoder().decode(r.stderr);

    // 1, because that is what `runner.wac` returns for a child it could not start. The point is
    // that the *program* decided it: before this, the process died with 1 and nothing of its own.
    assertEquals(r.code, 1, err);
    assertEquals(err.includes("runner: "), true, `the program reported it, not the runtime: ${err}`);
    // The reason is now the *marker's* rather than a `SyntaxError`, and it arrives without starting a
    // worker at all: a bundle says on its first line that it is one, so "this is not a program" is a
    // fact about the file rather than something inferred from how it failed. 0033.
    assertEquals(
      err.includes("not a wac worker bundle"),
      true,
      `with a reason that names the gap: ${err}`,
    );
    // The line that used to be there, and is the parent dying rather than reporting.
    assertEquals(err.includes("Unhandled error in child worker"), false, err);

    // And *one* account of one failure now, where there used to be two. The worker's own isolate
    // printed its uncaught error as well — which no parent could prevent, since `preventDefault` stops
    // the propagation and not the child's own report — but no worker is started for a source that does
    // not carry the marker, so there is nothing to have printed it. If that line ever comes back, a
    // file that is not a bundle is reaching the runtime again.
    assertEquals(err.includes("Uncaught (in worker"), false, err);
  } finally {
    await Deno.remove(runner);
    await Deno.remove(notAProgram);
  }
});

Deno.test("a program runs itself, with no file to read and nothing to find", async () => {
  // `spawnSelf` is what makes a *browser tab* able to run programs at all — there is no directory of
  // bundles there — and it is the same capability everywhere, so this checks it where it is easiest
  // to see. The child is this program with different arguments, which is what a multi-call binary is.
  const twin = await Deno.makeTempFile({ prefix: "wac-twin-" });
  const nodeTwin = await Deno.makeTempFile({ prefix: "wac-twin-node-" });
  try {
    await buildApp("packages/platform/example/twin.wac", twin, {});
    const r = new Deno.Command(twin, { stdout: "piped", stderr: "piped" }).outputSync();
    const err = new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 0, err);
    assertEquals(
      new TextDecoder().decode(r.stdout),
      "parent: about to run myself\nSHOUT: HELLO TWIN\nparent: the child exited 0\n",
      err,
    );
    // No grant of any kind: the program was built with none, and running itself needs none.
    assertEquals((await Deno.readTextFile(twin)).split("\n")[0], "#!/usr/bin/env -S deno run", "no flags");

    // And the same source, the same behaviour, on Node — where the worker is made a different way.
    await buildApp("packages/platform/example/twin.wac", nodeTwin, {}, "node");
    const n = new Deno.Command("node", { args: [nodeTwin], stdout: "piped", stderr: "piped" })
      .outputSync();
    assertEquals(n.code, 0, new TextDecoder().decode(n.stderr));
    assertEquals(
      new TextDecoder().decode(n.stdout),
      new TextDecoder().decode(r.stdout),
      "byte for byte what Deno said",
    );
  } finally {
    await Deno.remove(twin);
    await Deno.remove(nodeTwin);
  }
});

Deno.test("Node spawns the same way, from the same code", async () => {
  // The point is not that Node can spawn — it is that it spawns through the *same* `spawnChild`.
  // Only how a worker is made differs there (a source string with `eval`, rather than a module from
  // a blob URL), which is why that is an argument rather than a third copy of the queues, the load
  // notice and the grace period.
  const runner = await Deno.makeTempFile({ prefix: "wac-node-runner-" });
  const child = await Deno.makeTempFile({ prefix: "wac-node-child-", suffix: ".worker.js" });
  try {
    await buildApp("packages/platform/example/runner.wac", runner, { read: true }, "node");
    await buildApp("packages/platform/example/wc.wac", child, {}, "node", true);

    const r = new Deno.Command("node", {
      args: [runner, child, "one two three"],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    const err = new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 0, err);
    // `wc` of "one two three\n" — one line, three words, fourteen bytes — counted by a child
    // worker whose output came back through its handle.
    assertEquals(new TextDecoder().decode(r.stdout).trim(), "1 3 14", err);

    // And a source that is not a program is a failed child here too, with a reason and no crash.
    const notAProgram = await Deno.makeTempFile({ prefix: "wac-node-bad-" });
    try {
      await Deno.writeTextFile(notAProgram, "this is not javascript {{{\n");
      const bad = new Deno.Command("node", {
        args: [runner, notAProgram, "anything"],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      const badErr = new TextDecoder().decode(bad.stderr);
      assertEquals(bad.code, 1, badErr);
      assertEquals(badErr.includes("runner: "), true, badErr);
    } finally {
      await Deno.remove(notAProgram);
    }
  } finally {
    await Deno.remove(runner);
    await Deno.remove(child);
  }
});

Deno.test("a child is granted nothing, even by a parent that has it", async () => {
  // The property that makes `spawn` worth having over process spawn: what the child may do
  // is the *parent's* choice, not the operating system's. `--allow-run=/bin/sh` cannot
  // express this at any granularity, because the child there inherits the OS's authority.
  //
  // Compared against the same program run directly, so the difference is the only variable.
  // It is not a sandbox against arbitrary JavaScript — see the note in platform.wac — but for
  // a wac child the language makes it hold, because wac cannot reach past what it was handed.
  const runner = await Deno.makeTempFile({ prefix: "wac-grant-" });
  const direct = await Deno.makeTempFile({ prefix: "wac-probe-" });
  const child = await Deno.makeTempFile({ prefix: "wac-probe-c-", suffix: ".worker.js" });
  try {
    await buildApp("packages/platform/example/runner.wac", runner, { read: true });
    await buildApp("packages/platform/example/probe.wac", direct, { read: true, net: true });
    await buildApp("packages/platform/example/probe.wac", child, { read: true, net: true }, "deno", true);

    // Directly, with both grants: the read works. The connection fails because nothing is
    // listening on port 1, which the probe reports as `failed` rather than `denied` — the
    // distinction being the point of reporting the host's message at all.
    const alone = new Deno.Command(direct, { stdout: "piped", stderr: "piped" }).outputSync();
    assertEquals(alone.code, 0, new TextDecoder().decode(alone.stderr));
    assertEquals(new TextDecoder().decode(alone.stdout).trim(), "read=ok net=failed");

    // The same program, as a child of a parent that *does* have the filesystem. Its own
    // build grants are irrelevant: the world it is given decides, and it is given nothing.
    const spawned = new Deno.Command(runner, {
      args: [child, ""],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(spawned.code, 0, new TextDecoder().decode(spawned.stderr));
    assertEquals(
      new TextDecoder().decode(spawned.stdout).trim(),
      "read=denied net=denied",
      new TextDecoder().decode(spawned.stdout),
    );
  } finally {
    for (const f of [runner, direct, child]) await Deno.remove(f);
  }
});

Deno.test("a parent hands a child a subset of its own grants, and cannot exceed them", async () => {
  // The middle of the range, which is the useful part: a child granted nothing is safe and
  // cannot do the job, and a child granted everything is process spawn with extra steps.
  //
  // Four measurements against one program, because the interesting claim is comparative. The
  // last is the one that matters: a parent asking for a capability it does not have gets a
  // child without it, rather than an error or — the thing that would be a hole — the
  // capability. That the request is *allowed* to exceed is deliberate, so a parent forwarding a
  // request it received does not have to vet it first.
  const readOnly = await Deno.makeTempFile({ prefix: "wac-parent-r-" });
  const readNet = await Deno.makeTempFile({ prefix: "wac-parent-rn-" });
  const child = await Deno.makeTempFile({ prefix: "wac-probe-", suffix: ".worker.js" });
  try {
    await buildApp("packages/platform/example/runner.wac", readOnly, { read: true });
    await buildApp("packages/platform/example/runner.wac", readNet, { read: true, net: true });
    await buildApp("packages/platform/example/probe.wac", child, {}, "deno", true);

    const ask = (parent: string, grants: string): string => {
      const r = new Deno.Command(parent, {
        args: [child, "", grants],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
      return new TextDecoder().decode(r.stdout).trim();
    };

    // Grants are opt-in, not inherited: a parent with both, passing nothing, hands over nothing.
    assertEquals(ask(readNet, ""), "read=denied net=denied");
    // A subset, from a parent that has it. `failed` rather than `ok` for the network because
    // nothing is listening on port 1 — which is the probe distinguishing "denied" from "tried".
    assertEquals(ask(readOnly, "read"), "read=ok net=denied");
    assertEquals(ask(readNet, "read,net"), "read=ok net=failed");
    // The ceiling. Same request as the line above, from a parent without the network.
    assertEquals(ask(readOnly, "read,net"), "read=ok net=denied");
  } finally {
    for (const f of [readOnly, readNet, child]) await Deno.remove(f);
  }
});

Deno.test({
  name: "a bundle that parses and never speaks the protocol is a failed child, not a hang — 0033",
  // Five seconds of waiting by design: the grace is what this is about. Nothing else in the suite
  // waits, and the number is in `children.ts` beside the reasoning for it.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Two shapes of the same wedge, and only the second one needed a timer. A file that is not a
    // bundle is refused from its first line — that is the marker, and the case above covers it. This
    // one *claims* to be a bundle and then sits there, which is what 0021's notes predicted would
    // still hang after 0021 was fixed, and it did: `recv` waited for a child that was never going to
    // answer, for ever, with no way to interrupt it.
    const runner = await Deno.makeTempFile({ prefix: "wac-mute-runner-" });
    const mute = await Deno.makeTempFile({ prefix: "wac-mute-", suffix: ".worker.js" });
    try {
      await buildApp("packages/platform/example/runner.wac", runner, { read: true });
      // The marker, and then nothing. Valid JavaScript, evaluates cleanly, says nothing.
      await Deno.writeTextFile(mute, `${WORKER_MARKER}\n// and not another word\n`);

      const started = Date.now();
      const r = new Deno.Command(runner, {
        args: [mute, "anything"],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      const took = Date.now() - started;
      const err = new TextDecoder().decode(r.stderr);

      assertEquals(r.code, 1, `it should fail, and say so: ${err}`);
      assertEquals(err.includes("did not report ready"), true, `naming the gap: ${err}`);
      // Bounded, which is the whole difference: it used to be unbounded, and "hangs" and "is slow"
      // look identical from outside. Generous on the upper side because this machine is shared.
      assertEquals(took < 60_000, true, `${took} ms — the grace did not end it`);
    } finally {
      await Deno.remove(runner);
      await Deno.remove(mute);
    }
  },
});
