// Kill the daemons a killed test run left behind.
//
// wac-mono 0073. `packages/ssh`'s tests start a real `sshd` as their oracle and stop it in a `finally`,
// which is right and is not enough: `finally` does not run when the process is killed, and a `deno test`
// that outruns `tools/push.sh`'s timeout — or a container that is stopped, or a host that is rebooted — is
// killed. Every such run leaves a daemon holding a port and a `/tmp` directory of host keys. **Thirty had
// accumulated when somebody finally looked**, the oldest up two days, on a machine three agents share.
//
// An `unload` handler is not the answer, and that was tried for the analogous binary leak: it covers a
// clean exit and a throw and not a kill, which is the case that leaks. Reaping is.
//
// **What makes this safe is the parent.** A test's daemon whose parent is init cannot belong to a live
// test — the parent would be the `deno test` that started it. So a process is only killed when *both* its
// command line matches a pattern the caller owns and its parent is 1. A running test's server always has a
// live parent, and another agent's running server does too; only the abandoned ones qualify.

/** One abandoned process: enough to report it, and to clean up after it. */
export type Orphan = {
  pid: number;
  /** The whole command line, spaces for NULs, for the report. */
  cmdline: string;
};

/**
 * Processes matching `pattern` whose parent is init.
 *
 * **Through `ps`, not `/proc`.** Reading another process's `/proc/<pid>/stat` or `cmdline` requires Deno's
 * `--allow-all`, which the suite does not grant: with `--allow-read` it answers
 * `NotCapable: Requires all access to "/proc/1089540/stat"`. A first version of this read `/proc` directly
 * and caught the failure, so it found no orphans and reported success — inert, and inert in the direction
 * that looks like everything is fine. That is the third time in one day this permission has made a guard
 * do nothing quietly, and the lesson is the same each time: a guard has to be tested under the permissions
 * it will actually run with, not under `-A`.
 *
 * `ps` needs `--allow-run`, which the suite does grant, and it answers with the parent pid and the whole
 * command line in one call.
 */
export function findOrphans(pattern: RegExp): Orphan[] {
  const found: Orphan[] = [];
  let text: string;
  try {
    const r = new Deno.Command("ps", {
      args: ["-eo", "pid=,ppid=,args="],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!r.success) return found;
    text = new TextDecoder().decode(r.stdout);
  } catch {
    // No `ps`, or no permission to run it. A cleanup that cannot look is not a reason to fail a test.
    return found;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const [, pid, ppid, cmdline] = m;
    if (ppid !== "1") continue;
    if (!pattern.test(cmdline)) continue;
    found.push({ pid: Number(pid), cmdline });
  }
  return found;
}

/**
 * Kill every orphan matching `pattern`, and report what was killed.
 *
 * Reports rather than staying silent: a suite that quietly cleans up after itself hides how often it is
 * being killed, and the number of orphans found is the only measure of that anybody gets.
 *
 * `cleanup` is called with each orphan before it is killed — for the `/tmp` directory a daemon's config
 * lives in, which is the other half of the leak.
 */
export function reapOrphans(
  pattern: RegExp,
  what: string,
  cleanup?: (orphan: Orphan) => void,
): number {
  const orphans = findOrphans(pattern);
  if (orphans.length === 0) return 0;
  console.error(
    `reaping ${orphans.length} abandoned ${what} process${orphans.length === 1 ? "" : "es"} ` +
      `(parent is init, so no test owns them) — wac-mono 0073`,
  );
  for (const orphan of orphans) {
    console.error(`  pid ${orphan.pid}: ${orphan.cmdline.slice(0, 120)}`);
    try {
      cleanup?.(orphan);
    } catch {
      // A directory that is already gone, or one somebody else owns. The kill still matters.
    }
    try {
      Deno.kill(orphan.pid, "SIGTERM");
    } catch {
      // Exited between the scan and the signal, or not ours. Nothing to do.
    }
  }
  return orphans.length;
}
