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
export function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Everything a test needs from a running sshd, so the setup is written once. */
export type Server = { dir: string; port: number; sshd: Deno.ChildProcess; conn: Deno.TcpConn };

/**
 * Start an sshd that accepts a freshly generated client key, and connect to it.
 *
 * The server runs as this user and so can only authenticate this user, which is exactly the
 * account the tests attempt.
 */
export async function startServer(): Promise<Server> {
  const dir = await Deno.makeTempDir();
  const port = freePort();
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

