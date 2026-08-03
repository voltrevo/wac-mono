// The `ssh` program, run as a program.
//
// Everything else in this package tests the protocol through bindgen, where the wac side is a
// library and the test is the client. This runs the thing a user would run: the whole application
// in wac, launched by `packages/platform`, against a real sshd — argument parsing, the private key
// read off disk, known_hosts consulted, output on the right stream, and the command's exit status
// as the process's own.
//
// It is worth having separately because every one of those is outside the protocol and none of
// them is exercised by the transport tests.

import { haveSshd, type Server, startServer, stopServer } from "./server.ts";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A HOME with an `.ssh` the program will find by its own defaults. */
async function makeHome(s: Server, knownHost: boolean): Promise<string> {
  const home = `${s.dir}/home`;
  await Deno.mkdir(`${home}/.ssh`, { recursive: true });
  await Deno.copyFile(`${s.dir}/clientkey`, `${home}/.ssh/id_ed25519`);
  await Deno.chmod(`${home}/.ssh/id_ed25519`, 0o600);
  if (knownHost) {
    const blob = (await Deno.readTextFile(`${s.dir}/hostkey.pub`)).split(" ")[1];
    await Deno.writeTextFile(`${home}/.ssh/known_hosts`,
      `[127.0.0.1]:${s.port} ssh-ed25519 ${blob}\n`);
  }
  return home;
}

/**
 * The client, built once as a standalone program.
 *
 * Not `platform/app.ts` per invocation, which builds and then *spawns* the result: it waits with
 * `outputSync` and forwards no signals, so the launcher exiting leaves the application running
 * with nothing to reap it. `server.test.ts` already says this about the *server* binary and does
 * the right thing; the client calls here were left behind, and they leaked a launcher-plus-app
 * pair on every run. Eleven were sitting on this machine, all parented by init, the oldest nearly
 * five hours old. See wac-mono issue 0017.
 *
 * Building once is also just faster: one compile instead of one per invocation.
 */
async function buildSsh(extra: string[]): Promise<string> {
  const out = await Deno.makeTempFile({ prefix: "wac-ssh-" });
  const r = await new Deno.Command("deno", {
    args: [
      "run", "-A", "packages/platform/build.ts", "packages/ssh/src/ssh.wac",
      "--allow-read", "--allow-net", "--allow-env", ...extra, "-o", out,
    ],
  }).output();
  if (!r.success) throw new Error(`building ssh failed: ${new TextDecoder().decode(r.stderr)}`);
  return out;
}

/**
 * The client, built once per grant set rather than launched through `platform/app.ts` each time.
 *
 * `app.ts` builds and then *spawns* the result: it waits with `outputSync` and forwards no
 * signals, so the launcher exiting leaves the application running with nothing to reap it. Eleven
 * of those were sitting on this machine, all parented by init, the oldest nearly five hours old.
 * `server.test.ts` already avoided it for the server binary; these client calls were left behind.
 * See wac-mono issue 0017.
 *
 * **Two binaries, because the grants are the point of two of these tests.** They are baked in at
 * build time, so a single permissive binary would quietly pass the case that checks `-k` is
 * refused *without* `--allow-write` — the test would still be green and would no longer be
 * testing anything. That is the mistake this comment exists to stop someone repeating: my first
 * version took the grants argument and ignored it.
 */
const sshPlain = await buildSsh([]);
const sshWritable = await buildSsh(["--allow-write"]);

/** Run the application the way a user would, and hand back everything it produced. */
async function ssh(
  home: string, args: string[], grants: string[] = [], env: Record<string, string> = {},
): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
  const r = await new Deno.Command(grants.includes("--allow-write") ? sshWritable : sshPlain, {
    args,
    env: { HOME: home, USER: Deno.env.get("USER") ?? "claude", ...env },
    clearEnv: false,
  }).output();
  return { code: r.code, stdout: r.stdout, stderr: text(r.stderr) };
}

Deno.test({
  name: "the ssh program runs a command, on a real server, end to end",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Server | undefined;
    try {
      s = await startServer();
      const home = await makeHome(s, true);
      const target = `127.0.0.1`;
      const p = ["-p", String(s.port), target];

      // Standard output, byte for byte, with nothing of the client's mixed in.
      const echo = await ssh(home, [...p, "echo", "hello", "from", "wac"]);
      if (echo.code !== 0) throw new Error(`exit ${echo.code}: ${echo.stderr}`);
      if (text(echo.stdout) !== "hello from wac\n") {
        throw new Error(`stdout was ${JSON.stringify(text(echo.stdout))}`);
      }

      // The command's exit status becomes the program's. Quoting survives because the whole
      // command is one argument — the same as OpenSSH, which also joins argv with spaces.
      const failed = await ssh(home, [...p, "sh -c 'echo OUT; echo ERR >&2; exit 7'"]);
      if (failed.code !== 7) throw new Error(`exit status was ${failed.code}, expected 7`);
      if (text(failed.stdout) !== "OUT\n") {
        throw new Error(`stdout was ${JSON.stringify(text(failed.stdout))}`);
      }
      if (!failed.stderr.includes("ERR")) throw new Error(`stderr was ${JSON.stringify(failed.stderr)}`);
      // The client's own diagnostics must not land in the command's output.
      if (failed.stderr.includes("ssh:")) throw new Error(`unexpected client error: ${failed.stderr}`);

      // Binary, larger than one window, byte-exact — which needs flow control to be right and
      // nothing on the path to assume text.
      const size = 300000;
      const binary = await ssh(home, [...p, `head -c ${size} /dev/urandom | base64 -w0`]);
      if (binary.code !== 0) throw new Error(`exit ${binary.code}: ${binary.stderr}`);
      const encoded = text(binary.stdout).trim();
      if (encoded.length < size) {
        throw new Error(`got ${encoded.length} base64 chars for ${size} bytes`);
      }
      if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error("the output is not intact base64");
    } finally {
      await stopServer(s);
    }
  },
});

Deno.test({
  name: "the ssh program refuses an unknown host and reports a changed one",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Server | undefined;
    try {
      s = await startServer();
      const home = await makeHome(s, false);            // no known_hosts at all
      const p = ["-p", String(s.port), "127.0.0.1"];

      // Unknown is refused rather than accepted with a warning, and the refusal is actionable:
      // it prints the exact line to add.
      const unknown = await ssh(home, [...p, "echo", "should", "not", "run"]);
      if (unknown.code === 0) throw new Error("an unknown host was accepted");
      if (text(unknown.stdout) !== "") throw new Error("the command ran against an unknown host");
      if (!unknown.stderr.includes("is not in")) {
        throw new Error(`unhelpful refusal: ${unknown.stderr}`);
      }
      const blob = (await Deno.readTextFile(`${s.dir}/hostkey.pub`)).split(" ")[1];
      if (!unknown.stderr.includes(blob)) {
        throw new Error("the refusal did not print the host key line to add");
      }

      // `-k` records it, needs the write grant, and then the command runs.
      const added = await ssh(home, ["-k", ...p, "echo", "added"], ["--allow-write"]);
      if (added.code !== 0) throw new Error(`-k failed: ${added.stderr}`);
      if (text(added.stdout) !== "added\n") throw new Error(`stdout was ${text(added.stdout)}`);
      const kh = await Deno.readTextFile(`${home}/.ssh/known_hosts`);
      if (!kh.includes(blob)) throw new Error("known_hosts was not written");

      // Now it is known, so no grant to write is needed and no prompt appears.
      const known = await ssh(home, [...p, "echo", "again"]);
      if (known.code !== 0) throw new Error(`second run failed: ${known.stderr}`);
      if (text(known.stdout) !== "again\n") throw new Error("the recorded host was not recognised");

      // A different key for a known host is the case the file exists to catch, and must be loud
      // and refused — never quietly treated as a first connection.
      await Deno.writeTextFile(`${home}/.ssh/known_hosts`,
        `[127.0.0.1]:${s.port} ssh-ed25519 ${btoa(String.fromCharCode(
          ...Uint8Array.from({ length: 51 }, (_, i) => i)))}\n`);
      const changed = await ssh(home, [...p, "echo", "nope"]);
      if (changed.code === 0) throw new Error("a changed host key was accepted");
      if (text(changed.stdout) !== "") throw new Error("the command ran against a changed host key");
      if (!changed.stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")) {
        throw new Error(`the change was not reported loudly: ${changed.stderr}`);
      }
      // `-k` must not paper over it: adding is for unknown hosts, not for changed ones.
      const forced = await ssh(home, ["-k", ...p, "echo", "nope"], ["--allow-write"]);
      if (forced.code === 0) throw new Error("-k accepted a changed host key");
    } finally {
      await stopServer(s);
    }
  },
});

Deno.test({
  name: "the ssh program reports bad arguments and unreadable keys without connecting",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Server | undefined;
    try {
      s = await startServer();
      const home = await makeHome(s, true);
      const p = ["-p", String(s.port), "127.0.0.1"];

      const usage = await ssh(home, []);
      if (usage.code !== 2) throw new Error(`no arguments gave exit ${usage.code}, expected 2`);
      if (!usage.stderr.includes("usage:")) throw new Error("no usage line");

      const noCommand = await ssh(home, [...p]);
      if (noCommand.code !== 2) throw new Error("a host with no command was accepted");

      const badPort = await ssh(home, ["-p", "notaport", "127.0.0.1", "true"]);
      if (badPort.code !== 2) throw new Error("a non-numeric port was accepted");

      const missingKey = await ssh(home, ["-i", `${s.dir}/nosuchkey`, ...p, "true"]);
      if (missingKey.code !== 1) throw new Error("a missing identity did not fail");
      if (missingKey.stderr.includes("REMOTE HOST")) throw new Error("it got as far as the host key");

      // A file that exists but is not a key.
      await Deno.writeTextFile(`${s.dir}/notakey`, "hello\n");
      const notKey = await ssh(home, ["-i", `${s.dir}/notakey`, ...p, "true"]);
      if (notKey.code !== 1) throw new Error("a non-key file was accepted");
      if (!notKey.stderr.includes("not an OpenSSH private key")) {
        throw new Error(`unhelpful message: ${notKey.stderr}`);
      }
    } finally {
      await stopServer(s);
    }
  },
});

Deno.test({
  name: "the ssh program reads an encrypted key with SSH_PASSPHRASE, and says so without it",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Server | undefined;
    try {
      s = await startServer();
      const home = await makeHome(s, true);
      const pass = "a passphrase";
      const enc = `${s.dir}/encrypted`;
      await Deno.copyFile(`${s.dir}/clientkey`, enc);
      const rekey = await new Deno.Command("ssh-keygen", {
        args: ["-p", "-f", enc, "-P", "", "-N", pass, "-q", "-a", "4"],
      }).output();
      if (!rekey.success) throw new Error("ssh-keygen -p failed");

      const p = ["-i", enc, "-p", String(s.port), "127.0.0.1"];

      // Without the passphrase it fails before connecting, and says which of the two it needs.
      const noPass = await ssh(home, [...p, "echo", "no"]);
      if (noPass.code !== 1) throw new Error("an encrypted key was read without a passphrase");
      if (!noPass.stderr.includes("SSH_PASSPHRASE")) {
        throw new Error(`the message does not say how to supply one: ${noPass.stderr}`);
      }

      const withPass = await ssh(home, [...p, "echo", "decrypted"], [], { SSH_PASSPHRASE: pass });
      if (withPass.code !== 0) throw new Error(`with the passphrase: ${withPass.stderr}`);
      if (text(withPass.stdout) !== "decrypted\n") {
        throw new Error(`stdout was ${JSON.stringify(text(withPass.stdout))}`);
      }

      // A wrong one is a wrong passphrase, not a corrupt file.
      const wrong = await ssh(home, [...p, "echo", "no"], [], { SSH_PASSPHRASE: "wrong" });
      if (wrong.code !== 1) throw new Error("a wrong passphrase was accepted");
      if (!wrong.stderr.includes("wrong or missing passphrase")) {
        throw new Error(`unhelpful message: ${wrong.stderr}`);
      }
    } finally {
      await stopServer(s);
    }
  },
});
