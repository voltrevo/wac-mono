// Where OpenSSL 3.5 is, for the tests that need ML-KEM.
//
// Ubuntu 24.04 ships 3.0.13, which predates X25519MLKEM768 entirely, so the two interop tests that pin the
// hybrid group — `client.test.ts` and `handshake_interop.test.ts` — need a newer build. `tools/openssl35.sh`
// makes one.
//
// **One copy of the lookup.** Both files had their own ten lines of it, with the same hardcoded `/tmp`
// path, which is how the two of them came to disagree with the build script about where it lives.
//
// The default is under `~/tools` rather than `/tmp` because **`/tmp` does not survive a container
// restart**, and a reference build that has to be redone every restart is one that is never there when a
// test looks. `~/tools/foundry` holds anvil on the same argument.

const CANDIDATES = [
  Deno.env.get("OPENSSL35"),
  `${Deno.env.get("HOME") ?? "/home/claude"}/tools/ossl/openssl-openssl-3.5.7/apps/openssl`,
  "/tmp/ossl/openssl-openssl-3.5.7/apps/openssl",
].filter((p): p is string => p !== undefined && p !== "");

function find(): string | null {
  for (const p of CANDIDATES) {
    try {
      if (Deno.statSync(p).isFile) return p;
    } catch { /* next */ }
  }
  return null;
}

const found = find();

/** The binary, or the first candidate path when there is none — callers check `HAVE_OPENSSL35` first. */
export const OPENSSL35 = found ?? CANDIDATES[CANDIDATES.length - 1];
export const HAVE_OPENSSL35 = found !== null;

/**
 * Say what is not being checked, once, on stderr.
 *
 * A skip that prints nothing reads as coverage: the suite says "ok, 2 ignored" and nobody knows the ML-KEM
 * interop has not run. Deno's own output names the test but not the reason, and the reason is the useful
 * part — it is one shell command away from being fixed.
 */
export function announceIfMissing(): void {
  if (HAVE_OPENSSL35 || announced) return;
  announced = true;
  console.error(
    `\n  OpenSSL 3.5 not found — the X25519MLKEM768 interop tests will not run.\n` +
      `  Looked in:\n${CANDIDATES.map((p) => `    ${p}`).join("\n")}\n` +
      `  Build it with:  OPENSSL35_DIR=$HOME/tools/ossl sh tools/openssl35.sh\n`,
  );
}
let announced = false;
