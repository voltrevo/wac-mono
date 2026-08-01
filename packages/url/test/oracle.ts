// The oracle for URL parsing, and why it is not `new URL`.
//
// Deno's `URL` and Node's disagree. Not on anything exotic — `file:///c|/x`, `file:////a` and a
// backslash in a non-special path all come out differently, and each runtime is self-consistent
// about it. So "the host's own URL" is not one oracle, and picking the one that happens to be
// running the test would have quietly made this package match a specific runtime rather than the
// standard.
//
// Worse, neither is right everywhere. Node is right on the file-URL cases; Deno is right that a
// relative reference cannot be resolved against an opaque path unless it starts with `#`, where
// Node happily produces `foo:opaque/a#f`. So neither can be the oracle on its own.
//
// What is sound is where they *agree*: two independent implementations landing on the same answer
// is strong evidence, and there is no case where both are wrong in the same way. `agreed` returns
// those, and reports the rest rather than hiding them — a case dropped silently would read as one
// that passed.
//
// Cases are batched through one `node` process rather than one per case: the spawn dominates
// everything else, and a few hundred cases in one pass is milliseconds.

export type Parsed = {
  ok: boolean;
  href?: string;
  protocol?: string;
  username?: string;
  password?: string;
  hostname?: string;
  port?: string;
  pathname?: string;
  search?: string;
  hash?: string;
};

export type Case = { input: string; base?: string };

const SCRIPT = `
let raw = "";
process.stdin.on("data", (d) => raw += d);
process.stdin.on("end", () => {
  const cases = JSON.parse(raw);
  const out = cases.map(({ input, base }) => {
    try {
      const u = base === undefined ? new URL(input) : new URL(input, base);
      return {
        ok: true,
        href: u.href,
        protocol: u.protocol,
        username: u.username,
        password: u.password,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
      };
    } catch {
      return { ok: false };
    }
  });
  process.stdout.write(JSON.stringify(out));
});
`;

/** Parse every case with Node's URL. One subprocess for the whole batch. */
export async function oracle(cases: Case[]): Promise<Parsed[]> {
  if (cases.length === 0) return [];
  const command = new Deno.Command("node", {
    args: ["-e", SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(cases)));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`node oracle failed: ${new TextDecoder().decode(stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(stdout)) as Parsed[];
}

/**
 * The oracle: what both runtimes say, where they say the same thing.
 *
 * `skipped` holds the indices where they differ, so a caller can report the count. Those cases
 * are not evidence of anything and must not be asserted against either implementation.
 */
export async function agreed(
  cases: Case[],
): Promise<{ want: Array<Parsed | null>; skipped: number[] }> {
  const node = await oracle(cases);
  const want: Array<Parsed | null> = [];
  const skipped: number[] = [];
  for (let i = 0; i < cases.length; i++) {
    const deno = denoOracle(cases[i]);
    if (same(deno, node[i])) {
      want.push(node[i]);
    } else {
      want.push(null);
      skipped.push(i);
    }
  }
  return { want, skipped };
}

function same(a: Parsed, b: Parsed): boolean {
  if (a.ok !== b.ok) return false;
  if (!a.ok) return true;
  return a.href === b.href && a.protocol === b.protocol && a.username === b.username &&
    a.password === b.password && a.hostname === b.hostname && a.port === b.port &&
    a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
}

/** Deno's own URL, for the test that records where the two runtimes differ. */
export function denoOracle(c: Case): Parsed {
  try {
    const u = c.base === undefined ? new URL(c.input) : new URL(c.input, c.base);
    return {
      ok: true,
      href: u.href,
      protocol: u.protocol,
      username: u.username,
      password: u.password,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
    };
  } catch {
    return { ok: false };
  }
}
