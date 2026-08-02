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

const text = (b: Uint8Array) => new TextDecoder().decode(b);

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

type Wacsshd = { dir: string; port: number; proc: Deno.ChildProcess };

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
  const proc = new Deno.Command("deno", {
    args: [
      "run", "-A", "packages/platform/app.ts", "packages/ssh/src/sshd.wac",
      "--allow-read", "--allow-net", "--allow-env", "--", "-p", String(port),
    ],
    env: { HOME: dir },
    clearEnv: false,
    stdout: "null",
    stderr: "null",
  }).spawn();

  // Poll rather than sleep: the first run compiles the wac and the rest do not.
  for (let i = 0; i < 200; i++) {
    try {
      const probe = await Deno.connect({ hostname: "127.0.0.1", port });
      probe.close();
      return { dir, port, proc };
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error("our sshd never accepted a connection");
}

async function stopWacsshd(s: Wacsshd | undefined): Promise<void> {
  if (s === undefined) return;
  try { s.proc.kill("SIGKILL"); } catch { /* already gone */ }
  await s.proc.status;
  await Deno.remove(s.dir, { recursive: true });
}

/** The real OpenSSH client, against our server. */
async function realSsh(s: Wacsshd, command: string, key = `${s.dir}/clientkey`) {
  const r = await new Deno.Command("ssh", {
    args: [
      "-F", "/dev/null", "-i", key, "-p", String(s.port),
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "-o", "BatchMode=yes", "claude@127.0.0.1", command,
    ],
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

      // Commands that read the filesystem through the capability world.
      const cat = await realSsh(s, `cat ${s.dir}/.ssh/authorized_keys`);
      if (!cat.stdout.startsWith("ssh-ed25519 ")) throw new Error(`cat gave ${cat.stdout.slice(0, 40)}`);
      const ls = await realSsh(s, `ls ${s.dir}`);
      if (!ls.stdout.includes("clientkey")) throw new Error(`ls gave ${JSON.stringify(ls.stdout)}`);

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

      const r = await new Deno.Command("deno", {
        args: [
          "run", "-A", "packages/platform/app.ts", "packages/ssh/src/ssh.wac",
          "--allow-read", "--allow-net", "--allow-env", "--",
          "-p", String(s.port), "127.0.0.1", "echo", "both", "ends", "in", "wac",
        ],
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
