// Which of `platform.wac`'s fault categories a host error belongs to.
//
// One file rather than three, because the classification is the interesting part and three copies of
// it would drift — and because the *same* wac program runs on all three, so `rm -f` must mean the
// same thing whether the filesystem underneath is Deno's, Node's, or the Origin Private File System.
//
// The categories are deliberately few. A program branches on "was it simply not there" and little
// else; everything finer is in the message, which is the host's own words and the only text worth
// showing a person. Inventing a taxonomy of thirty errno values would be a taxonomy nobody consults.

/** Matching `FAULT_*` in platform.wac. */
export const FAULT_NONE = 0;
export const FAULT_NOT_FOUND = 1;
export const FAULT_DENIED = 2;
export const FAULT_EXISTS = 3;
export const FAULT_NOT_EMPTY = 4;
export const FAULT_OTHER = 5;
/**
 * The host cannot express this name — see `FAULT_NOT_REPRESENTABLE` in `platform.wac`.
 *
 * A path containing U+FFFD that does not resolve is the detectable case, and it is the common one: it is
 * what a lossy `readDir` hands back for a filename that is not valid UTF-8.
 */
export const FAULT_NOT_REPRESENTABLE = 6;

/**
 * A fault a host had to name itself, because its filesystem does not report one.
 *
 * OPFS is the case that needs it: it has no exclusive create, so "already exists" is a question the
 * browser host asks and answers, and if it threw a plain `Error` the category would have to be
 * recovered from my own English below. Thrown, it arrives here intact.
 */
export class Faulted extends Error {
  readonly fault: number;
  constructor(fault: number, message: string) {
    super(message);
    this.name = "Faulted";
    this.fault = fault;
  }
}

/**
 * The category of a thrown error, by whatever the host makes available.
 *
 * Deno gives typed errors, Node gives `code`, and the File System Access API gives `DOMException`
 * names — so each is asked in its own terms and the message is only a last resort. Reading the
 * *message* for a category is what an applet had to do before this existed, and it is a guess about
 * three operating systems: "No such file or directory" is not what any of them promises to say.
 */
/** The replacement character, which is what a lossy decode leaves where bytes it could not read were. */
const REPLACEMENT = "\ufffd";

/**
 * The fault for an operation on `path`, given what the host threw.
 *
 * The one refinement over `faultOf`: a `NotFound` for a path containing U+FFFD is almost certainly a name
 * the host could not express rather than a file that is not there — because U+FFFD is what a lossy
 * `readDir` produces, and a name containing it round-trips only if the file really does have a replacement
 * character in it. Checked rather than assumed: if the path resolves, it is a real name and the fault
 * stands as it was.
 */
export function faultOfPath(e: unknown, path: string): number {
  const fault = faultOf(e);
  if (fault !== FAULT_NOT_FOUND || !path.includes(REPLACEMENT)) return fault;
  return FAULT_NOT_REPRESENTABLE;
}

/**
 * The error to throw for a failed operation on `path`.
 *
 * Returns the original unless the path is one the host cannot express, in which case it returns a
 * `Faulted` carrying the category — which every reply path already respects, since `faultOf` reads it.
 * That is why this is a thrown value rather than a change to `changed()` or `faultedBytes()`: the fault
 * travels with the error and needs no new parameter anywhere.
 */
export function pathFailure(e: unknown, path: string): unknown {
  if (faultOfPath(e, path) !== FAULT_NOT_REPRESENTABLE) return e;
  return new Faulted(
    FAULT_NOT_REPRESENTABLE,
    `${path}: the name is not representable on this host — it contains U+FFFD, which is what a lossy ` +
      `directory read leaves in place of bytes that are not valid UTF-8, and no path in this runtime's ` +
      `filesystem API can name the original`,
  );
}

export function faultOf(e: unknown): number {
  if (e instanceof Faulted) return e.fault;

  // Deno's typed errors, if this is Deno. `Deno.errors` is absent under Node, hence the guard.
  const denoErrors = (globalThis as { Deno?: { errors?: Record<string, unknown> } }).Deno?.errors;
  if (denoErrors !== undefined) {
    if (isInstance(e, denoErrors.NotFound)) return FAULT_NOT_FOUND;
    if (isInstance(e, denoErrors.PermissionDenied)) return FAULT_DENIED;
    if (isInstance(e, denoErrors.AlreadyExists)) return FAULT_EXISTS;
  }

  // Node's errno codes, and Deno's too where it sets them.
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string") {
    if (code === "ENOENT") return FAULT_NOT_FOUND;
    if (code === "EACCES" || code === "EPERM") return FAULT_DENIED;
    if (code === "EEXIST") return FAULT_EXISTS;
    if (code === "ENOTEMPTY") return FAULT_NOT_EMPTY;
  }

  // The File System Access API throws `DOMException`s with names rather than codes.
  const name = (e as { name?: unknown }).name;
  if (typeof name === "string") {
    if (name === "NotFoundError") return FAULT_NOT_FOUND;
    if (name === "NotAllowedError" || name === "NoModificationAllowedError" || name === "SecurityError") {
      return FAULT_DENIED;
    }
    // Removing a directory that still has entries in it, without `recursive`.
    if (name === "InvalidModificationError") return FAULT_NOT_EMPTY;
  }

  // Last: the text. Only for the two cases no host above reports structurally — a non-empty
  // directory under Deno arrives as a plain `Error`, and its os error number is the only marker.
  const message = e instanceof Error ? e.message : String(e);
  if (/not empty|os error 39|os error 66/i.test(message)) return FAULT_NOT_EMPTY;
  if (/not granted/i.test(message)) return FAULT_DENIED;
  return FAULT_OTHER;
}

/** The payload a `Change` is decoded from: the category, then the message. */
/**
 * A failed *call's* payload: the category, then the host's message.
 *
 * The same shape `changeBytes` gives a mutation's answer, and for the same reason — a caller has to be
 * able to branch on the category without reading English. This one rides the bridge's error envelope,
 * so it covers every capability rather than the two that answer with a `Change`. wac-mono 0062.
 */
export function faultedBytes(fault: number, message: string): Uint8Array {
  return changeBytes(fault, message);
}

export function changeBytes(fault: number, message: string): Uint8Array {
  const text = new TextEncoder().encode(message);
  const out = new Uint8Array(text.length + 1);
  out[0] = fault;
  out.set(text, 1);
  return out;
}

/** The answer for something that worked. */
export const CHANGED_OK = new Uint8Array([FAULT_NONE]);

/**
 * A short phrase for a category, for a host whose own words are boilerplate.
 *
 * The Origin Private File System reports through `DOMException`, whose messages are written for a
 * developer console rather than for a terminal: "A requested file or directory could not be found at
 * the time an operation was processed." — a sentence, with a full stop, naming neither the path nor
 * the operation. In the browser shell demo that reads as a defect. Deno and Node say "No such file or
 * directory (os error 2), remove '/tmp/x'", which is terse and names both, so they keep their own
 * words and only the browser reaches for these.
 *
 * This is not inventing an explanation: the *category* was already established by `faultOf`, and
 * `FAULT_OTHER` — the case where the message is the only information — has no phrase and must not get
 * one. See `describeAsPhrase` in `browser.ts` for the policy that uses it.
 */
export function phraseOf(fault: number): string {
  if (fault === FAULT_NOT_FOUND) return "no such file or directory";
  if (fault === FAULT_DENIED) return "permission denied";
  if (fault === FAULT_EXISTS) return "already exists";
  if (fault === FAULT_NOT_EMPTY) return "directory not empty";
  if (fault === FAULT_NOT_REPRESENTABLE) return "the name is not representable on this host";
  return "";
}

/**
 * Run a change and answer with its outcome rather than throwing.
 *
 * `describe` lets a host say the failure in its own way once the category is known; the default is
 * the error's own message, which is right wherever the host's message is worth reading.
 */
// `unknown` rather than `void` because some of these answer something — Node's recursive
// `mkdir` returns the first directory it made — and none of it belongs in the reply.
export async function changed(
  work: () => Promise<unknown>,
  describe: (fault: number, message: string) => string = (_, m) => m,
): Promise<Uint8Array> {
  try {
    await work();
    return CHANGED_OK;
  } catch (e) {
    const fault = faultOf(e);
    return changeBytes(fault, describe(fault, e instanceof Error ? e.message : String(e)));
  }
}

function isInstance(e: unknown, ctor: unknown): boolean {
  return typeof ctor === "function" && e instanceof (ctor as new () => unknown);
}

/**
 * The `stat` reply's width, and where its fault byte sits.
 *
 * Here rather than in each host because three of them answer this operation — Deno, Node and the browser —
 * and `provider.ts` reads what they wrote. A field appended in two places out of four is a silent
 * disagreement about a wire format, which is the shape that made `spawn`'s argv wrong for a week.
 *
 * Layout: exists, isFile, isDir, size (i64 LE at 3), mtime (i64 LE at 11), isSymlink at 19, fault at 20.
 */
export const STAT_BYTES = 21;
export const STAT_FAULT = 20;

/**
 * The fault a failed `stat` should report — `FAULT_NONE` when the answer is simply "nothing here".
 *
 * Deliberately narrow: only the two cases where the answer is genuinely *unknowable* are faults.
 *
 *   - `FAULT_NOT_REPRESENTABLE` — a name this runtime cannot express, so the file may well be there.
 *   - `FAULT_DENIED` — no read capability, so nothing can be said either way.
 *
 * Everything else means "nothing usable at this path", which is an answer and must stay one. `ENOTDIR` is
 * the case that decides the shape: `test -e f/g` where `f` is a file is *false* in bash, not an error, and
 * a fault there would make every shell of ours disagree with it. Absence with a fault attached would also
 * make `rm -f` and every "does it exist" check start reporting failures they are written to ignore.
 */
export function statFault(e: unknown, path: string): number {
  const fault = faultOfPath(e, path);
  return fault === FAULT_NOT_REPRESENTABLE || fault === FAULT_DENIED ? fault : FAULT_NONE;
}
