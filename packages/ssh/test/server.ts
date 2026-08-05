import { freePort, holdPort } from "../../../harness/port.ts";  // one allocator — wac-mono 0069
import { reapOrphans } from "../../../harness/reap.ts";
export { freePort };  // its importers use it too
// A local sshd, for the tests that need a real server to talk to.
//
// Its own module rather than a helper inside one test file, because both the protocol tests and
// the CLI test need it and neither should import the other.

const haveSshd = await (async () => {
  try {
    return (await Deno.stat("/usr/sbin/sshd")).isFile;
  } catch {
    return false;
  }
})();

export { haveSshd };

/** A port nothing is listening on. Racy in principle; the window is microseconds. */


/** Everything a test needs from a running sshd, so the setup is written once. */
export type Server = { dir: string; port: number; sshd: Deno.ChildProcess; conn: Deno.TcpConn };

/**
 * Start an sshd that accepts a freshly generated client key, and connect to it.
 *
 * The server runs as this user and so can only authenticate this user, which is exactly the
 * account the tests attempt.
 */
/**
 * What an abandoned test sshd looks like to `ps`.
 *
 * Exported so `server.test.ts` can assert it against the real thing. **Not anchored**, because sshd
 * rewrites its own argv: a listener shows up as
 * `sshd: /usr/sbin/sshd -D -f /tmp/…/sshd_config [listener] 0 of 10-100 startups`, and the first version of
 * this pattern started at `/usr/sbin/sshd` and therefore matched nothing. A reaper with a pattern that
 * matches nothing is indistinguishable from a clean machine, which is how it passed review — mine — and
 * only failed against an orphan I planted by hand.
 *
 * `/tmp/…/sshd_config` is the part that makes it this suite's: a real sshd on this machine is configured
 * from `/etc`.
 */
export const ABANDONED_SSHD = /sshd.* -D -f \/tmp\/[^\s]+\/sshd_config/;

/**
 * The abandoned sshds of runs that were killed, cleared before starting another.
 *
 * Only ones whose parent is init: a live test's server has a live parent, and so does another agent's, so
 * this cannot touch either. The pattern is this suite's own shape — `sshd -D -f /tmp/…` — and the config
 * directory goes with the process, since that is the other half of what leaks. wac-mono 0073.
 *
 * Called from here rather than from a `globalThis.unload` handler because `unload` covers a clean exit and
 * a throw and *not* a kill, and a kill is what leaks: `tools/push.sh` times a suite out at 45 minutes, a
 * container can be stopped, and a host can be rebooted. Reaping on the way *in* is the only hook that
 * survives all three.
 */
function reapAbandonedSshds(): void {
  // **Not anchored, because sshd rewrites its own argv.** `ps` shows a listener as
  // `sshd: /usr/sbin/sshd -D -f /tmp/…/sshd_config [listener] 0 of 10-100 startups`, so a pattern anchored
  // at `/usr/sbin/sshd` matches nothing and the reaper is inert — which is exactly what the first version
  // did, silently, against a planted orphan I had to check by hand to notice.
  reapOrphans(ABANDONED_SSHD, "sshd", (orphan) => {
    const config = /-f (\/tmp\/[^\s]+)\/sshd_config/.exec(orphan.cmdline);
    if (config !== null) Deno.removeSync(config[1], { recursive: true });
  });
}

export async function startServer(): Promise<Server> {
  reapAbandonedSshds();

  const dir = await Deno.makeTempDir();
  // **Held, not merely chosen.** Two `ssh-keygen` runs and a config write happen between here and
  // sshd's bind — hundreds of milliseconds during which the old `freePort` had already let the port go.
  // The listener stays open until immediately before the spawn, so nothing on the machine can take it in
  // the meantime. wac-mono 0069.
  const held = holdPort();
  const port = held.port;
  for (const name of ["hostkey", "clientkey"]) {
    const r = await new Deno.Command("ssh-keygen", {
      args: ["-t", "ed25519", "-f", `${dir}/${name}`, "-N", "", "-q"],
    }).output();
    if (!r.success) throw new Error(`ssh-keygen failed for ${name}`);
    await Deno.chmod(`${dir}/${name}`, 0o600);
  }
  await Deno.copyFile(`${dir}/clientkey.pub`, `${dir}/authorized_keys`);
  await Deno.chmod(`${dir}/authorized_keys`, 0o600);
  await Deno.writeTextFile(`${dir}/sshd_config`, [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${dir}/hostkey`,
    `AuthorizedKeysFile ${dir}/authorized_keys`,
    "StrictModes no",
    "UsePAM no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PidFile none",
  ].join("\n"));

  // Released here and nowhere earlier: the next statement is the bind.
  held.release();

  // Foreground, so killing the child actually stops the server.
  const sshd = new Deno.Command("/usr/sbin/sshd", {
    args: ["-D", "-f", `${dir}/sshd_config`],
    stdout: "null",
    stderr: "null",
  }).spawn();

  // Wait for it to accept, rather than sleeping a guessed amount.
  let conn: Deno.TcpConn | undefined;
  for (let i = 0; i < 100 && conn === undefined; i++) {
    try {
      conn = await Deno.connect({ hostname: "127.0.0.1", port });
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
  if (conn === undefined) throw new Error(`sshd never accepted on ${port}`);
  return { dir, port, sshd, conn };
}

export async function stopServer(s: Server | undefined): Promise<void> {
  if (s === undefined) return;
  try { s.conn.close(); } catch { /* already gone */ }
  try { s.sshd.kill("SIGTERM"); } catch { /* already gone */ }
  await s.sshd.status;
  await Deno.remove(s.dir, { recursive: true });
}

