// Which test files need the machine to themselves.
//
// A file declares it near the top:
//
//     // test-lane: exclusive — a real OpenSSH server per case, on a real port
//
// and both entry points — `deno task test` and `deno task test:changed` — run it in a pass of its own,
// sequentially, after the parallel one.
//
// **Why a lane rather than another workaround.** Three ssh files each start a real sshd on a real port,
// and under five parallel workers one of them resets during the handshake about once in eight suite runs
// (wac-mono 0082's seventh member). Around that we had already accumulated `harness/port.ts` holding a
// listener until the bind, `harness/reap.ts` killing sshds orphaned by a killed run, a deliberately
// unanchored pattern because sshd rewrites its argv, and a `MaxStartups` hypothesis waiting to be tried.
// Four workarounds for one decision: running tests that want exclusive resources concurrently with
// everything else. The lane removes the decision.
//
// **Declared in the file, not listed here**, for the same reason the dead-export check reads imports
// rather than a table of package names: a list is wrong the first time somebody writes a server test
// somewhere new, and wrong silently. `tools/lane.test.ts` checks that every declaration gives a reason.

/** `// test-lane: exclusive — why`, at the start of a line. */
export const LANE = /^\/\/\s*test-lane:\s*exclusive\b\s*(?:[—-]\s*)?(.*)$/m;

export type Exclusive = { file: string; why: string };

/** Every test file that has declared itself exclusive, with the reason it gave. */
export async function exclusiveTests(roots = ["packages", "harness", "tools"]): Promise<Exclusive[]> {
  const out: Exclusive[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".cache") continue;
        await walk(path);
      } else if (e.name.endsWith(".test.ts")) {
        const m = LANE.exec(await Deno.readTextFile(path));
        if (m !== null) out.push({ file: path, why: m[1].trim() });
      }
    }
  };
  for (const root of roots) await walk(root);
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/**
 * How a set of targets divides into the parallel pass and the lane.
 *
 * Pure, and separately tested, because both callers got it wrong in different ways when it was inline:
 * `tools/testChanged.ts` compared a *directory* target against a *file* path so nothing ever matched,
 * and its whole-suite mode passes no targets at all, where "no targets" means everything rather than
 * nothing. Neither mistake failed anything — the suite passed, in parallel, exactly as before, and said
 * nothing either way. That is the shape of bug this repo keeps finding, so this one is a function with
 * cases rather than four lines repeated twice.
 *
 * `targets` empty means "whatever `deno test` discovers", so every declared file is in the lane.
 */
export function laneSplit(targets: string[], declared: string[]): { alone: string[]; ignore: string[] } {
  const alone = targets.length === 0
    ? [...declared]
    : declared.filter((f) => targets.some((t) => f.startsWith(t)));
  return { alone, ignore: alone };
}
