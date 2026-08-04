// The `sshd` program, tested by OpenSSH's own client.
//
// Every other test in this package points one way: our code against a real server. This one is
// the reverse, and it is worth having for exactly that reason — it exercises paths nothing else
// touches. The server offers algorithm lists a real client negotiates against, *signs* an
// exchange hash rather than verifying one, is the side that answers a key probe, and picks the
// channel number the client then has to use. None of that is reachable from the client side.
//
// A second implementation of my own misconceptions would agree with itself. OpenSSH does not.

import { haveSshd } from "./server.ts";

/**
 * Every binary this file builds, removed on the way out.
 *
 * Each build is a fresh ~700 KiB executable and there is no suite teardown to remove it, so `/tmp`
 * accumulated five hundred of them and a parallel run eventually died with "No space left on device"
 * in a package that had nothing to do with it. `unload` fires whether the tests passed, failed or
 * threw, which is the only hook that covers all three.
 */
const built: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const path of built) {
    try {
      Deno.removeSync(path, { recursive: true });
    } catch {
      // Already gone. Nothing to report on the way out.
    }
  }
});

const text = (b: Uint8Array) => new TextDecoder().decode(b);

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

type Wacsshd = { dir: string; port: number; proc: Deno.ChildProcess; stderr: Promise<string> };

/**
 * The server, built once as a standalone program.
 *
 * Not `deno task app`, which builds and then *spawns* the result: it waits with `outputSync`,
 * so killing the launcher leaves the application running with nothing to reap it. Doing that
 * once per test leaked 57 servers and 13,736 zombie children before anything noticed, and the
 * container ran out of process ids. Running the built binary directly means the handle we hold
 * is the process we kill.
 */
/** The client, built once, for the both-ends-in-wac test. See the note in `cli.test.ts`. */
const sshBinary = await (async () => {
  const out = await Deno.makeTempFile({ prefix: "wac-ssh-" });
  built.push(out);
  const r = await new Deno.Command("deno", {
    args: [
      "run", "-A", "packages/platform/build.ts", "packages/ssh/src/ssh.wac",
      "--allow-read", "--allow-net", "--allow-env", "-o", out,
    ],
  }).output();
  if (!r.success) throw new Error(`building ssh failed: ${new TextDecoder().decode(r.stderr)}`);
  return out;
})();

const wacsshdBinary = await (async () => {
  const out = await Deno.makeTempFile({ prefix: "wacsshd-" });
  built.push(out);
  const r = await new Deno.Command("deno", {
    args: [
      "run", "-A", "packages/platform/build.ts", "packages/ssh/src/sshd.wac",
      "--allow-read", "--allow-net", "--allow-env", "-o", out,
    ],
  }).output();
  if (!r.success) throw new Error(`building sshd failed: ${new TextDecoder().decode(r.stderr)}`);
  return out;
})();

/** Our server, running, with a host key and one authorized client key. */
async function startWacsshd(): Promise<Wacsshd> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/.ssh`);
  for (const [name, path] of [["host", `${dir}/.ssh/ssh_host_ed25519_key`], ["client", `${dir}/clientkey`]] as const) {
    const r = await new Deno.Command("ssh-keygen", {
      args: ["-t", "ed25519", "-f", path, "-N", "", "-q"],
    }).output();
    if (!r.success) throw new Error(`ssh-keygen failed for ${name}`);
    await Deno.chmod(path, 0o600);
  }
  await Deno.copyFile(`${dir}/clientkey.pub`, `${dir}/.ssh/authorized_keys`);

  const port = freePort();
  const proc = new Deno.Command(wacsshdBinary, {
    args: ["-p", String(port)],
    env: { HOME: dir },
    clearEnv: false,
    stdout: "null",
    // Captured rather than discarded so a test can read what the server said about itself. The
    // startup line is the only place `sshd.wac`'s `itoa` is observable at all, and it survived
    // mutation testing as `return ""` — a server announcing "listening on port " with no number.
    stderr: "piped",
  }).spawn();

  // Drained as it arrives, rather than with `new Response(proc.stderr).text()`, which only resolves
  // at end of stream. Two things need it: a server that filled the pipe would block, and startup
  // has to be able to wait for a *particular* line.
  let said = "";
  let announced = () => {};
  const hasAnnounced = new Promise<void>((r) => { announced = r; });
  const stderr = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) {
      said += dec.decode(chunk, { stream: true });
      if (said.includes("listening on port")) announced();
    }
    announced();          // the process ended without saying it; the waiter must not hang
    return said;
  })();

  // Poll rather than sleep: the first run compiles the wac and the rest do not.
  let accepted = false;
  for (let i = 0; i < 200 && !accepted; i++) {
    try {
      const probe = await Deno.connect({ hostname: "127.0.0.1", port });
      probe.close();
      accepted = true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!accepted) throw new Error("our sshd never accepted a connection");

  // **And wait for the announcement, not just for the socket.** A successful connect only proves
  // the listener is bound; the startup line is written around the same moment and read here a
  // moment later. Returning on the connect alone meant a test could `SIGKILL` the server before
  // that line had been drained, and then assert on an empty string — which is what made this file
  // fail about one full parallel run in ten, always in the one test that reads stderr. Issue 0026.
  await Promise.race([
    hasAnnounced,
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  return { dir, port, proc, stderr };
}

async function stopWacsshd(s: Wacsshd | undefined): Promise<void> {
  if (s === undefined) return;
  try { s.proc.kill("SIGKILL"); } catch { /* already gone */ }
  await s.proc.status;
  await Deno.remove(s.dir, { recursive: true });
}

/**
 * The real OpenSSH client, against our server.
 *
 * **`-F /dev/null` is why a real bug lived here for as long as it did.** Discarding the system
 * config makes the test reproducible, and it also removes `SendEnv LANG LC_*` — the Debian and
 * Ubuntu default — so the client never sent the `env` requests that broke the server. `extra`
 * exists to put them back: see the test named for it below.
 */
async function realSsh(
  s: Wacsshd, command: string, key = `${s.dir}/clientkey`, extra: string[] = [],
) {
  const r = await new Deno.Command("ssh", {
    args: [
      "-F", "/dev/null", "-i", key, "-p", String(s.port),
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "-o", "BatchMode=yes", ...extra, "claude@127.0.0.1", command,
    ],
    env: {
      LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: s.dir,
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    },
    clearEnv: true,
  }).output();
  // The client writes its host key notice to stderr; it is not the command's output.
  const stderr = text(r.stderr).split("\n")
    .filter(l => !l.startsWith("Warning: Permanently added")).join("\n");
  return { code: r.code, stdout: text(r.stdout), stderr };
}

Deno.test({
  name: "OpenSSH's own client connects to our server, authenticates and runs a command",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Wacsshd | undefined;
    try {
      s = await startWacsshd();

      const hello = await realSsh(s, "echo hello from the wac server");
      if (hello.code !== 0) throw new Error(`exit ${hello.code}: ${hello.stderr}`);
      if (hello.stdout !== "hello from the wac server\n") {
        throw new Error(`stdout was ${JSON.stringify(hello.stdout)}`);
      }
      // A clean end. Closing the socket without waiting for the client's CHANNEL_CLOSE makes ssh
      // report "Connection closed by remote host", and sending DISCONNECT instead makes it throw
      // the output away and exit 255 — so the absence of both is the assertion.
      if (hello.stderr.trim() !== "") throw new Error(`unexpected stderr: ${hello.stderr}`);

      // The command's exit status reaches the client as its own.
      for (const [command, want] of [["true", 0], ["false", 1], ["frobnicate", 127]] as const) {
        const r = await realSsh(s, command);
        if (r.code !== want) throw new Error(`${command}: exit ${r.code}, expected ${want}`);
      }

      // The two streams stay apart.
      const missing = await realSsh(s, "frobnicate");
      if (missing.stdout !== "") throw new Error("an error message went to stdout");
      if (!missing.stderr.includes("command not found")) {
        throw new Error(`stderr was ${JSON.stringify(missing.stderr)}`);
      }

      // The command is run by `packages/sh`, so what arrives over the channel is a shell script
      // rather than a name the server knows. Each of these needs a different part of it.
      for (const [script, want] of [
        ["seq 1 100 | grep 7 | wc -l", "19\n"],                       // pipeline, three stages
        ['x="a b c"; echo "$x" | tr " " "-"', "a-b-c\n"],             // quoting and expansion
        ['echo "there are $(seq 1 5 | wc -l) lines"', "there are 5 lines\n"],   // substitution
        ["false || echo fallback", "fallback\n"],                     // and-or
        ["echo a; echo b", "a\nb\n"],                                 // a list
      ] as const) {
        const r = await realSsh(s, script);
        if (r.stdout !== want) {
          throw new Error(`${script}\n  got  ${JSON.stringify(r.stdout)}\n  want ${JSON.stringify(want)}`);
        }
      }

      // A file read through the capability world, sorted by the shell's own `sort`.
      const cat = await realSsh(s, `cat ${s.dir}/.ssh/authorized_keys`);
      if (!cat.stdout.startsWith("ssh-ed25519 ")) throw new Error(`cat gave ${cat.stdout.slice(0, 40)}`);

      // The shell's exit status becomes the channel's, which becomes ssh's.
      const nomatch = await realSsh(s, "seq 1 3 | grep 9");
      if (nomatch.code !== 1) throw new Error(`grep with no match exited ${nomatch.code}`);

      // A key that is not in authorized_keys does not get in. This is the check that the
      // signature verification and the key lookup are both doing something.
      const other = `${s.dir}/otherkey`;
      await new Deno.Command("ssh-keygen", {
        args: ["-t", "ed25519", "-f", other, "-N", "", "-q"],
      }).output();
      await Deno.chmod(other, 0o600);
      const refused = await realSsh(s, "echo should not run", other);
      if (refused.code === 0) throw new Error("an unauthorized key was let in");
      if (refused.stdout !== "") throw new Error("an unauthorized key ran a command");
      if (!refused.stderr.includes("Permission denied")) {
        throw new Error(`unexpected refusal: ${refused.stderr}`);
      }
    } finally {
      await stopWacsshd(s);
    }
  },
});

Deno.test({
  name: "an interactive session keeps its shell between lines",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Wacsshd | undefined;
    try {
      s = await startWacsshd();

      // `ssh -T` asks for a shell and no pty, which is the case this server serves. Lines go in
      // over the channel and each one runs as it arrives.
      const r = await new Deno.Command("ssh", {
        args: [
          "-T", "-F", "/dev/null", "-i", `${s.dir}/clientkey`, "-p", String(s.port),
          "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
          "-o", "BatchMode=yes", "claude@127.0.0.1",
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const w = r.stdin.getWriter();
      await w.write(new TextEncoder().encode(
        "x=hello\n" +
        "echo $x world\n" +
        "seq 1 5 | wc -l\n" +
        "echo state persists: $x\n"));
      await w.close();
      const out = await r.output();
      const stdout = text(out.stdout);

      // The middle assertion is the one that makes it a *session*: a variable set on the first
      // line is still there on the fourth. Without one shell for the whole channel each line
      // would start again and the last would print nothing.
      const want = "hello world\n5\nstate persists: hello\n";
      if (stdout !== want) {
        throw new Error(`interactive session:\n  got  ${JSON.stringify(stdout)}\n  want ${JSON.stringify(want)}`);
      }

      // `exit` ends the session and its status becomes ssh's.
      const bye = new Deno.Command("ssh", {
        args: [
          "-T", "-F", "/dev/null", "-i", `${s.dir}/clientkey`, "-p", String(s.port),
          "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
          "-o", "BatchMode=yes", "claude@127.0.0.1",
        ],
        stdin: "piped",
        stdout: "null",
        stderr: "null",
      }).spawn();
      const bw = bye.stdin.getWriter();
      await bw.write(new TextEncoder().encode("exit 6\n"));
      await bw.close();
      const byeStatus = await bye.status;
      if (byeStatus.code !== 6) throw new Error(`exit 6 gave ${byeStatus.code}`);
    } finally {
      await stopWacsshd(s);
    }
  },
});

Deno.test({
  name: "our own client talks to our own server, both ends in wac",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Wacsshd | undefined;
    try {
      s = await startWacsshd();

      // A HOME for the client, with the server's host key recorded so it will proceed.
      const home = `${s.dir}/clienthome`;
      await Deno.mkdir(`${home}/.ssh`, { recursive: true });
      await Deno.copyFile(`${s.dir}/clientkey`, `${home}/.ssh/id_ed25519`);
      await Deno.chmod(`${home}/.ssh/id_ed25519`, 0o600);
      const hostBlob = (await Deno.readTextFile(`${s.dir}/.ssh/ssh_host_ed25519_key.pub`)).split(" ")[1];
      await Deno.writeTextFile(`${home}/.ssh/known_hosts`,
        `[127.0.0.1]:${s.port} ssh-ed25519 ${hostBlob}\n`);

      // The built client, not `platform/app.ts`: the launcher spawns the application and forwards
      // no signals, so each call left an orphan behind. Same reason the server binary above is
      // built once — wac-mono issue 0017.
      const r = await new Deno.Command(sshBinary, {
        args: ["-p", String(s.port), "127.0.0.1", "echo", "both", "ends", "in", "wac"],
        env: { HOME: home, USER: "claude" },
        clearEnv: false,
      }).output();
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${text(r.stderr)}`);
      if (text(r.stdout) !== "both ends in wac\n") {
        throw new Error(`stdout was ${JSON.stringify(text(r.stdout))}`);
      }

      // Worth being explicit that this proves less than the test above: two implementations that
      // share an author agree with each other about a misreading as readily as about the spec.
      // It is here because it exercises both halves in one process tree, not as evidence.
    } finally {
      await stopWacsshd(s);
    }
  },
});

Deno.test({
  name: "a client that sends environment requests first still gets its command run",
  ignore: !haveSshd,
  sanitizeResources: false,
  async fn() {
    const s = await startWacsshd();
    try {
      // `SendEnv LANG LC_*` is the default in Debian's and Ubuntu's `ssh_config`, so this is what
      // most clients in the world actually do: two `env` channel requests, both with want_reply
      // *false*, and then `exec`.
      //
      // The server used to treat every request that was not `shell` as an attempt to `exec`,
      // fail to read a command out of it, and answer CHANNEL_FAILURE. Since the `env` requests
      // asked for no reply, those answers landed against the *next* request the client had made —
      // its `exec` — so every command failed with `exec request failed on channel 0` while the
      // server logged that the client had never asked to run anything.
      //
      // It is invisible without this test, because the rest of them pass `-F /dev/null`.
      const r = await realSsh(s, "echo env-first", undefined, ["-o", "SendEnv=LANG LC_*"]);
      if (r.stdout !== "env-first\n") {
        throw new Error(`env-first: got ${JSON.stringify(r.stdout)} code ${r.code}\n${r.stderr}`);
      }
      if (r.code !== 0) throw new Error(`env-first: exit ${r.code}\n${r.stderr}`);

      // And the same again with a command whose status is not zero, so the reply pairing is
      // checked rather than just the happy path.
      const bad = await realSsh(s, "exit 7", undefined, ["-o", "SendEnv=LANG LC_*"]);
      if (bad.code !== 7) throw new Error(`env-first status: exit ${bad.code}\n${bad.stderr}`);
    } finally {
      await stopWacsshd(s);
    }
  },
});

Deno.test({
  name: "a refused pty-req is answered, because that request did want a reply",
  ignore: !haveSshd,
  sanitizeResources: false,
  async fn() {
    const s = await startWacsshd();
    try {
      // The other half of the `want_reply` rule, and the half the `SendEnv` test above cannot
      // reach. That one proves we stay *silent* for requests that asked for nothing; this proves
      // we still *answer* one that asked. Without it, `requestWantsReply` could return a constant
      // `false` and the whole suite stayed green — which is exactly what mutation testing found.
      //
      // `ssh -tt` forces `pty-req` with want_reply set. We refuse it deliberately (no terminal
      // modes to honour), and the client prints the refusal. No answer at all and there is
      // nothing for it to print.
      const r = await new Deno.Command("ssh", {
        args: [
          "-tt", "-F", "/dev/null", "-i", `${s.dir}/clientkey`, "-p", String(s.port),
          "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
          "-o", "BatchMode=yes", "claude@127.0.0.1",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const err = text(r.stderr);
      if (!err.includes("PTY allocation request failed")) {
        throw new Error(`no refusal reached the client. stderr: ${JSON.stringify(err)}`);
      }
    } finally {
      await stopWacsshd(s);
    }
  },
});

Deno.test({
  name: "the server announces the port it is actually listening on",
  ignore: !haveSshd,
  sanitizeResources: false,
  async fn() {
    const s = await startWacsshd();
    let said: string;
    try {
      // `itoa` in `sshd.wac` has exactly one observable: this line. It survived mutation testing
      // replaced by `return ""`, which yields `sshd: listening on port ` — a server that has
      // forgotten to say where it is. Harmless-looking, and the first thing anyone reads when a
      // connection will not go through.
      //
      // Asserted against the port the *test* chose, not against whatever the line contains, so a
      // number that is merely present but wrong fails too.
      await stopWacsshd(s);
      said = await s.stderr;
    } catch (e) {
      await stopWacsshd(s);
      throw e;
    }
    const want = `sshd: listening on port ${s.port}`;
    if (!said.includes(want)) {
      throw new Error(`expected ${JSON.stringify(want)}, server said ${JSON.stringify(said.trim())}`);
    }
  },
});
