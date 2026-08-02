// Branch coverage for ssh.
//
// No server here. The interop test is what says the transport is *right*; coverage is about
// reaching the branches, and the ones that matter are the refusals — a peer chooses every length
// and every algorithm name on the wire, so the paths that reject a malformed one are the paths
// most worth knowing are entered.
//
// So the inputs are mostly deliberate corruption: lengths that go negative in an i32, padding
// larger than its packet, version lines that never end, name-lists with nothing in common.
//
//   deno task coverage:ssh
//   deno task coverage:ssh --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const bytes = (s: string) => new TextEncoder().encode(s);

const run = await instrument("packages/ssh/test/wac/probe.wac");
const m = run.mod as unknown as {
  sshClientVersion(): Uint8Array;
  sshClientVersionLine(): Uint8Array;
  sshScanStatus(buf: Uint8Array): number;
  sshScanUsed(buf: Uint8Array): number;
  sshScanLine(buf: Uint8Array): Uint8Array;
  sshSpeaksV2(line: Uint8Array): boolean;
  sshMinBlock(): number;
  sshPaddingFor(n: number, block: number): number;
  sshFrame(payload: Uint8Array, random: Uint8Array, block: number): Uint8Array;
  sshUnframeStatus(buf: Uint8Array): number;
  sshUnframeUsed(buf: Uint8Array): number;
  sshUnframePayload(buf: Uint8Array): Uint8Array;
  sshKexInit(cookie: Uint8Array): Uint8Array;
  sshProposalField(payload: Uint8Array, which: number): Uint8Array;
  sshProposalOk(payload: Uint8Array): boolean;
  sshNegotiate(serverPayload: Uint8Array, which: number): Uint8Array;
  sshWriteMpint(magnitude: Uint8Array): Uint8Array;
  sshWriteString(v: Uint8Array): Uint8Array;
  sshReadString(buf: Uint8Array): Uint8Array;
  sshReadStringOk(buf: Uint8Array): boolean;
};

m.sshClientVersion();
m.sshClientVersionLine();

// ── Version lines ─────────────────────────────────────────────────────────────
for (
  const line of [
    "SSH-2.0-OpenSSH_9.6\r\n",
    "SSH-2.0-Other\n",                       // bare LF, no CR to strip
    "SSH-1.99-Legacy\r\n",                   // speaks 2 as well
    "SSH-1.5-Ancient\r\n",                   // does not
    "banner\r\nSSH-2.0-X\r\n",               // one banner line
    "a\r\nb\r\nc\r\nSSH-2.0-X\r\n",          // several
    "SSH-2.0-Trailing\r\nextra bytes",       // `used` must stop after the CR LF
    "SSH-2.0-Partial",                       // incomplete
    "",                                      // nothing at all
    "\r\n",                                  // an empty line before anything
    "SSH-",                                  // exactly the prefix, still incomplete
    "SSH-\r\n",                              // a version line with no version
    "x".repeat(300),                         // never going to be a line
    "y".repeat(300) + "\r\n",                // a complete line, over the limit
  ]
) {
  const b = bytes(line);
  if (m.sshScanStatus(b) === 0) {
    m.sshScanUsed(b);
    m.sshSpeaksV2(m.sshScanLine(b));
  }
}
m.sshSpeaksV2(new Uint8Array(0));
m.sshSpeaksV2(bytes("SSH"));

// ── Framing ───────────────────────────────────────────────────────────────────
const block = m.sshMinBlock();
for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 63, 64, 200, 5000]) {
  for (const b of [8, 16]) m.sshPaddingFor(n, b);
  const payload = Uint8Array.from({ length: n }, (_, i) => i & 255);
  const packet = m.sshFrame(payload, new Uint8Array(m.sshPaddingFor(n, block)).fill(7), block);
  m.sshUnframeStatus(packet);
  m.sshUnframeUsed(packet);
  m.sshUnframePayload(packet);
  m.sshUnframeStatus(packet.slice(0, Math.max(0, packet.length - 1)));   // incomplete
  m.sshUnframeStatus(packet.slice(0, 2));                                // shorter than a length
}

for (
  const bad of [
    [0, 0, 0, 12, 3, ...new Array(11).fill(0)],       // padding under 4
    [0, 1, 0, 0, 8, 0, 0, 0],                         // over the maximum
    [0, 0, 0, 6, 200, 0, 0, 0, 0, 0],                 // padding longer than the packet
    [0x80, 0, 0, 0, 8, 0, 0, 0],                      // length negative as an i32
    [0, 0, 0, 0, 0, 0, 0, 0],                         // length zero
    [0, 0, 0, 4, 4, 0, 0, 0],                         // length below the minimum
  ]
) {
  m.sshUnframeStatus(new Uint8Array(bad));
}
m.sshUnframeStatus(new Uint8Array(0));

// ── Wire types ────────────────────────────────────────────────────────────────
for (
  const magnitude of [
    [], [0], [0, 0, 0], [1], [0x7f], [0x80], [0xff], [0, 0x80], [0, 0, 0x7f],
    [0x09, 0xa3, 0x78, 0xf9, 0xb2, 0xe3, 0x32, 0xa7],
  ]
) {
  m.sshWriteMpint(new Uint8Array(magnitude));
}
for (const s of [[], [0], [0, 1, 255], [0x2c]]) {
  const wire = m.sshWriteString(new Uint8Array(s));
  m.sshReadStringOk(wire);
  m.sshReadString(wire);
}
for (
  const bad of [
    [0, 0, 0, 8, 1, 2, 3],                            // claims more than it has
    [0x80, 0, 0, 0, 1],                               // negative length
    [0, 0],                                           // not even a length
  ]
) {
  m.sshReadStringOk(new Uint8Array(bad));
  m.sshReadString(new Uint8Array(bad));
}

// ── KEXINIT ───────────────────────────────────────────────────────────────────
const ourKexInit = m.sshKexInit(new Uint8Array(16).fill(9));
for (let which = 0; which < 9; which++) {
  m.sshProposalField(ourKexInit, which);
  m.sshNegotiate(ourKexInit, which);
}
m.sshProposalOk(ourKexInit);

/** A KEXINIT carrying the given ten name-lists. */
function kexInit(lists: string[]): Uint8Array {
  const parts: number[] = [20, ...new Array(16).fill(0)];
  for (const s of lists) {
    const b = bytes(s);
    parts.push((b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255);
    parts.push(...b);
  }
  parts.push(0, 0, 0, 0, 0);
  return new Uint8Array(parts);
}

const overlapping = kexInit([
  "curve25519-sha256@libssh.org,curve25519-sha256", "ssh-ed25519",
  "chacha20-poly1305@openssh.com", "chacha20-poly1305@openssh.com",
  "hmac-sha2-256", "hmac-sha2-256", "none", "none", "", "",
]);
const disjoint = kexInit([
  "diffie-hellman-group1-sha1", "ssh-dss", "3des-cbc", "3des-cbc",
  "hmac-md5", "hmac-md5", "zlib", "zlib", "", "",
]);
// A single-element list, an empty one, and a trailing comma — the list walker's edges.
const odd = kexInit(["curve25519-sha256", "", "chacha20-poly1305@openssh.com,", ",none",
  "hmac-sha2-256", "", "none", "none", "", ""]);

for (const p of [overlapping, disjoint, odd]) {
  m.sshProposalOk(p);
  for (let which = 0; which < 9; which++) {
    m.sshProposalField(p, which);
    m.sshNegotiate(p, which);
  }
}

// Not a KEXINIT at all, and a truncated one.
for (const p of [new Uint8Array([21]), new Uint8Array(0), overlapping.slice(0, 30)]) {
  m.sshProposalOk(p);
  m.sshProposalField(p, 0);
  m.sshNegotiate(p, 0);
}


// ── Ranges and refusals ───────────────────────────────────────────────────────
//
// The bounds checks only fire for a caller parsing at an offset, and the traps only for a caller
// that got an argument wrong — neither is reachable through the whole-buffer forms above.

const mAt = run.mod as unknown as {
  sshUnframeStatusAt(buf: Uint8Array, at: number, end: number): number;
  sshScanStatusAt(buf: Uint8Array, at: number, end: number): number;
  sshReadStringOkAt(buf: Uint8Array, at: number, end: number): boolean;
  sshKexInitFirst(cookie: Uint8Array, first: boolean): Uint8Array;
};

function ignoringTraps(f: () => void): void {
  try {
    f();
  } catch {
    // A trap is one of the outcomes being reached here, not a failure.
  }
}

const sample = new Uint8Array([0, 0, 0, 12, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
for (const [at, end] of [[0, sample.length], [4, sample.length], [-1, 4], [0, 999], [8, 4]] as const) {
  mAt.sshUnframeStatusAt(sample, at, end);
  mAt.sshScanStatusAt(bytes("SSH-2.0-X\r\n"), at, Math.min(end, 11));
  mAt.sshReadStringOkAt(sample, at, end);
}

// Fewer bytes than a length field, through the offset form: "read more", not a verdict.
mAt.sshUnframeStatusAt(sample, 0, 2);
mAt.sshScanStatusAt(bytes("SSH-2.0-Partial"), 0, 15);

// A name the same length as one of ours but not equal — `curve25519-sha255` against
// `curve25519-sha256`. Without it the comparison loop never takes its mismatch branch, because
// every other disagreement in this file differs in length and is rejected before comparing.
const sameLength = kexInit([
  "curve25519-sha255", "ssh-ed25519", "chacha20-poly1305@openssh.com",
  "chacha20-poly1305@openssh.com", "hmac-sha2-256", "hmac-sha2-256", "none", "none", "", "",
]);
m.sshNegotiate(sameLength, 0);
m.sshProposalField(sameLength, 0);

// `first_kex_packet_follows` true is the only way to write a boolean of 1.
mAt.sshKexInitFirst(new Uint8Array(16), true);
mAt.sshKexInitFirst(new Uint8Array(16), false);

// A cookie that is not 16 bytes, and padding bytes that run out: both trap by contract.
ignoringTraps(() => mAt.sshKexInitFirst(new Uint8Array(15), false));
ignoringTraps(() => m.sshKexInit(new Uint8Array(0)));
ignoringTraps(() => m.sshFrame(new Uint8Array(10), new Uint8Array(0), 8));

report([run], "packages/ssh/", { verbose });
