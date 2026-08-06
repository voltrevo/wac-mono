// Spawning a binary that was just built: retried on ETXTBSY, and diagnosed if it happens.
//
// Imported for its side effect by every test file that builds something and runs it. It wraps
// `Deno.Command` so that "Text file busy" is retried a few times a few milliseconds apart instead of
// failing the suite.
//
// **Why a retry is the answer here, and not the usual cop-out.** wac-mono 0074: a full parallel suite
// failed this way three times in one day, always under load, never in isolation. `ETXTBSY` means some
// process holds the file open *for writing* at the instant of the `execve`, so the hunt was for that
// process. Everything in this repo was ruled out by measurement — `place()` in
// `packages/platform/build.ts` writes a uniquely-named temp, closes the handle by hand and renames;
// `buildCache.ts` does the same for its entry; ~660 build-and-exec rounds across three write patterns,
// including one with no rename at all, reproduced nothing.
//
// Then this file caught one in the act. It asks `/proc/*/fd` who holds the path the moment the spawn
// fails, and the answer was **"holders: none found"** — nobody had it open by the time we looked,
// microseconds later. That is the finding: the window is real, it is not a leaked handle anybody can
// point at, and it is already shut by the time user space can ask. A fix would have to be inside the
// kernel or inside Deno's file plumbing; from here, waiting and trying again is the correct response to
// a condition that has already cleared.
//
// The diagnostic stays on. If a future failure names a holder, that is a *different* bug — a real leaked
// write handle — and it should be fixed rather than retried.
// Imported for a second side effect: under `WAC_PROFILE` this installs the wrapper that attributes
// coverage to tests. Every subprocess-based test file imports *this* module — that is what makes it the
// right place — and several of them reach `build.ts` only through a dynamic `import()` inside a test
// body, which is too late: `Deno.test` has already registered the case by then, so the wrapper wraps
// nothing and the file writes no profile at all. That is the shape wac-mono 0024 is about, and it would
// have looked exactly like the problem it was meant to fix.
import "./wacProfile.ts";

const RealCommand = Deno.Command;

/** How many times, and how long between: the window measured closed in under a millisecond. */
const ATTEMPTS = 6;
const WAIT_MS = 10;

function isBusy(e: unknown): boolean {
  return String(e).includes("Text file busy");
}

/** Sleep, synchronously, because `spawn` and `outputSync` cannot await. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holdersOf(path: string): string[] {
  const found: string[] = [];
  try {
    for (const pid of Deno.readDirSync("/proc")) {
      if (!/^\d+$/.test(pid.name)) continue;
      try {
        for (const fd of Deno.readDirSync(`/proc/${pid.name}/fd`)) {
          try {
            if (Deno.readLinkSync(`/proc/${pid.name}/fd/${fd.name}`) !== path) continue;
            const cmd = new TextDecoder().decode(Deno.readFileSync(`/proc/${pid.name}/cmdline`))
              .replaceAll("\0", " ").slice(0, 120);
            const info = Deno.readTextFileSync(`/proc/${pid.name}/fdinfo/${fd.name}`)
              .replaceAll("\n", " ");
            found.push(`pid ${pid.name} fd ${fd.name} [${cmd}] ${info}`);
          } catch { /* the process or the fd went away while we looked: expected */ }
        }
      } catch { /* not ours to read */ }
    }
  } catch { /* no /proc: nothing to report */ }
  return found;
}

/**
 * Say what was holding it, once per occurrence.
 *
 * Printed even though the spawn then succeeds, because the *rate* is what tells us whether 0074 is
 * still the same phenomenon — and because a named holder means this is no longer a race but a leak.
 */
function report(path: string, attempt: number): void {
  const holders = holdersOf(path);
  console.error(
    `ETXTBSY spawning ${path} (attempt ${attempt}) — holders: ${holders.length === 0 ? "none found" : ""}`,
  );
  for (const h of holders) console.error(`   ${h}`);
}

// deno-lint-ignore no-explicit-any
(Deno as any).Command = class RetryingCommand extends RealCommand {
  #path: string;
  // deno-lint-ignore no-explicit-any
  constructor(path: string | URL, options?: any) {
    super(path, options);
    this.#path = String(path);
  }

  override spawn(): Deno.ChildProcess {
    for (let attempt = 1;; attempt++) {
      try {
        return super.spawn();
      } catch (e) {
        if (!isBusy(e) || attempt === ATTEMPTS) throw e;
        report(this.#path, attempt);
        pause(WAIT_MS);
      }
    }
  }

  override outputSync(): Deno.CommandOutput {
    for (let attempt = 1;; attempt++) {
      try {
        return super.outputSync();
      } catch (e) {
        if (!isBusy(e) || attempt === ATTEMPTS) throw e;
        report(this.#path, attempt);
        pause(WAIT_MS);
      }
    }
  }

  override async output(): Promise<Deno.CommandOutput> {
    for (let attempt = 1;; attempt++) {
      try {
        return await super.output();
      } catch (e) {
        if (!isBusy(e) || attempt === ATTEMPTS) throw e;
        report(this.#path, attempt);
        await new Promise((res) => setTimeout(res, WAIT_MS));
      }
    }
  }
};
