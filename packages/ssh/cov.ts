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
const text = (b: Uint8Array) => new TextDecoder().decode(b);

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

// ── Key exchange ──────────────────────────────────────────────────────────────
//
// Kept to a handful of curve operations: X25519 and Ed25519 are the expensive things in the repo,
// and the branches here are all in the parsing and checking around them, not inside.

const mKex = run.mod as unknown as {
  sshMsgKexEcdhReply(): number;
  sshEphemeralPublic(secret: Uint8Array): Uint8Array;
  sshEcdhInit(qc: Uint8Array): Uint8Array;
  sshEcdhReplyOk(payload: Uint8Array): boolean;
  sshEcdhReplyField(payload: Uint8Array, which: number): Uint8Array;
  sshSharedSecret(secret: Uint8Array, peerPublic: Uint8Array): Uint8Array;
  sshExchangeHash(vc: Uint8Array, vs: Uint8Array, ic: Uint8Array, isrv: Uint8Array,
                  ks: Uint8Array, qc: Uint8Array, qs: Uint8Array, k: Uint8Array): Uint8Array;
  sshVerifyHostKey(hostKey: Uint8Array, signature: Uint8Array, h: Uint8Array): boolean;
  sshDeriveKey(k: Uint8Array, h: Uint8Array, sid: Uint8Array, letter: number, needed: number): Uint8Array;
};

mKex.sshMsgKexEcdhReply();
const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const qc = mKex.sshEphemeralPublic(secret);
mKex.sshEcdhInit(qc);
ignoringTraps(() => mKex.sshEphemeralPublic(new Uint8Array(31)));

const str = (b: Uint8Array) => {
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length);
  out.set(b, 4);
  return out;
};
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const hostKeyBlob = join(str(bytes("ssh-ed25519")), str(new Uint8Array(32).fill(2)));
const sigBlob = join(str(bytes("ssh-ed25519")), str(new Uint8Array(64).fill(3)));
const reply = join(new Uint8Array([31]), str(hostKeyBlob), str(qc), str(sigBlob));
mKex.sshEcdhReplyOk(reply);
for (let which = 0; which < 4; which++) mKex.sshEcdhReplyField(reply, which);

for (
  const bad of [
    new Uint8Array([20]),                                          // not an ECDH reply
    new Uint8Array([31]),                                          // truncated immediately
    reply.slice(0, 20),                                            // truncated mid-field
    join(new Uint8Array([31]), str(hostKeyBlob), str(new Uint8Array(31)), str(sigBlob)),  // Q_S 31 bytes
  ]
) {
  mKex.sshEcdhReplyOk(bad);
  mKex.sshEcdhReplyField(bad, 0);
}

mKex.sshSharedSecret(secret, qc);
mKex.sshSharedSecret(secret, new Uint8Array(32));                  // all-zero point
mKex.sshSharedSecret(new Uint8Array(31), qc);                      // wrong secret length
mKex.sshSharedSecret(secret, new Uint8Array(31));                  // wrong peer length

const h = mKex.sshExchangeHash(bytes("SSH-2.0-a"), bytes("SSH-2.0-b"), new Uint8Array([20]),
                               new Uint8Array([20]), hostKeyBlob, qc, qc, secret);

// Every rejection in the host key check, then one real verification.
mKex.sshVerifyHostKey(hostKeyBlob, sigBlob, h);                              // names right, bytes bogus
mKex.sshVerifyHostKey(join(str(bytes("ssh-rsa")), str(new Uint8Array(32))), sigBlob, h);
mKex.sshVerifyHostKey(hostKeyBlob, join(str(bytes("ssh-rsa")), str(new Uint8Array(64))), h);
mKex.sshVerifyHostKey(join(str(bytes("ssh-ed25519")), str(new Uint8Array(31))), sigBlob, h);
mKex.sshVerifyHostKey(hostKeyBlob, join(str(bytes("ssh-ed25519")), str(new Uint8Array(63))), h);
mKex.sshVerifyHostKey(new Uint8Array(0), sigBlob, h);
mKex.sshVerifyHostKey(hostKeyBlob, new Uint8Array(0), h);

// A name the same length as "ssh-ed25519" but not equal. Every other wrong name here differs in
// length and is rejected before the bytes are compared, so without this the comparison loop never
// takes its mismatch branch.
mKex.sshVerifyHostKey(join(str(bytes("ssh-ed25518")), str(new Uint8Array(32))), sigBlob, h);
mKex.sshVerifyHostKey(hostKeyBlob, join(str(bytes("ssh-ed25518")), str(new Uint8Array(64))), h);

// One hash block, and more than one, so the extension loop is entered as well as skipped.
for (const needed of [16, 32, 64]) mKex.sshDeriveKey(secret, h, h, 0x41, needed);

// ── The cipher ────────────────────────────────────────────────────────────────

const mCipher = run.mod as unknown as {
  sshCipherKeyLength(): number;
  sshCipherTagLength(): number;
  sshAeadPaddingFor(n: number, block: number): number;
  sshSeal(key: Uint8Array, seq: number, payload: Uint8Array, random: Uint8Array, block: number): Uint8Array;
  sshPeekLength(key: Uint8Array, seq: number, src: Uint8Array, at: number): number;
  sshOpenStatus(key: Uint8Array, seq: number, src: Uint8Array, at: number, end: number, max: number): number;
  sshOpenPayload(key: Uint8Array, seq: number, src: Uint8Array, at: number, end: number, max: number): Uint8Array;
  sshOpenUsed(key: Uint8Array, seq: number, src: Uint8Array, at: number, end: number, max: number): number;
};

mCipher.sshCipherKeyLength();
mCipher.sshCipherTagLength();
const ckey = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 1) & 255);
for (const n of [0, 1, 6, 7, 8, 100]) {
  for (const b of [8, 16]) mCipher.sshAeadPaddingFor(n, b);
  const payload = Uint8Array.from({ length: n }, (_, i) => i & 255);
  const packet = mCipher.sshSeal(ckey, n, payload, new Uint8Array(mCipher.sshAeadPaddingFor(n, 8)).fill(1), 8);
  mCipher.sshPeekLength(ckey, n, packet, 0);
  mCipher.sshOpenStatus(ckey, n, packet, 0, packet.length, 35000);
  mCipher.sshOpenPayload(ckey, n, packet, 0, packet.length, 35000);
  mCipher.sshOpenUsed(ckey, n, packet, 0, packet.length, 35000);
  mCipher.sshOpenStatus(ckey, n, packet, 0, packet.length - 1, 35000);   // incomplete
  mCipher.sshOpenStatus(ckey, n, packet, 0, 2, 35000);                   // shorter than a length
  mCipher.sshOpenStatus(ckey, n + 1, packet, 0, packet.length, 35000);   // wrong sequence
  mCipher.sshOpenStatus(ckey, n, packet, 0, packet.length, 4);           // over the caller's limit
  mCipher.sshOpenStatus(ckey, n, packet, -1, packet.length, 35000);      // bad range
  mCipher.sshOpenStatus(ckey, n, packet, 0, packet.length + 5, 35000);   // end past the buffer
}

// A tag that does not match, and a body whose padding length is impossible once decrypted.
const tampered = mCipher.sshSeal(ckey, 0, bytes("tamper"), new Uint8Array(16).fill(2), 8);
tampered[tampered.length - 1] ^= 0xff;
mCipher.sshOpenStatus(ckey, 0, tampered, 0, tampered.length, 35000);

// A packet whose tag is right and whose padding length is impossible: only reachable by sealing a
// body directly, since `seal` computes a valid one. This is the check that runs *after* the MAC.
const mBody = run.mod as unknown as {
  sshSealBody(key: Uint8Array, seq: number, body: Uint8Array): Uint8Array;
};
for (const padByte of [200, 0, 3]) {
  const body = new Uint8Array(8);
  body[0] = padByte;                       // claims more padding than the packet holds, or too little
  const forged = mBody.sshSealBody(ckey, 0, body);
  mCipher.sshOpenStatus(ckey, 0, forged, 0, forged.length, 35000);
}

mCipher.sshPeekLength(ckey, 0, new Uint8Array(2), 0);                     // too short to peek
mCipher.sshPeekLength(ckey, 0, new Uint8Array(8), -1);                    // bad offset
ignoringTraps(() => mBody.sshSealBody(new Uint8Array(63), 0, new Uint8Array(8)));
ignoringTraps(() => mCipher.sshSeal(new Uint8Array(63), 0, bytes("x"), new Uint8Array(16), 8));
ignoringTraps(() => mCipher.sshSeal(ckey, 0, bytes("x"), new Uint8Array(0), 8));
ignoringTraps(() => mCipher.sshPeekLength(new Uint8Array(63), 0, new Uint8Array(8), 0));
ignoringTraps(() => mCipher.sshOpenStatus(new Uint8Array(63), 0, new Uint8Array(40), 0, 40, 35000));

// ── Private keys and authentication ───────────────────────────────────────────
//
// Key files are built by hand rather than by ssh-keygen: coverage is about reaching the refusals,
// and every one of them needs a file that is wrong in a specific way.

const mAuth = run.mod as unknown as {
  sshReadKeyStatus(pem: Uint8Array, passphrase: Uint8Array): number;
  sshReadKeySeed(pem: Uint8Array, passphrase: Uint8Array): Uint8Array;
  sshReadKeyPublic(pem: Uint8Array, passphrase: Uint8Array): Uint8Array;
  sshMsgUserAuthSuccess(): number;
  sshMsgUserAuthFailure(): number;
  sshMsgServiceAccept(): number;
  sshServiceRequest(): Uint8Array;
  sshSignedData(sessionId: Uint8Array, user: Uint8Array, publicBlob: Uint8Array): Uint8Array;
  sshPublicKeyRequest(sessionId: Uint8Array, user: Uint8Array, publicBlob: Uint8Array, seed: Uint8Array): Uint8Array;
};

mAuth.sshMsgUserAuthSuccess();
mAuth.sshMsgUserAuthFailure();
mAuth.sshMsgServiceAccept();
mAuth.sshServiceRequest();

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const sstr = (b: Uint8Array) => join(u32(b.length), b);
const armour = (blob: Uint8Array) => {
  const b64 = btoa(String.fromCharCode(...blob));
  const lines = b64.match(/.{1,70}/g) ?? [];
  return bytes(`-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`);
};

/** An openssh-key-v1 file with the given parts, so each refusal can be reached deliberately. */
function keyFile(opts: {
  cipher?: string; kdf?: string; kdfOptions?: Uint8Array; keyCount?: number;
  pubBlob?: Uint8Array; section?: Uint8Array;
}): Uint8Array {
  return armour(join(
    bytes("openssh-key-v1\0"),
    sstr(bytes(opts.cipher ?? "none")),
    sstr(bytes(opts.kdf ?? "none")),
    sstr(opts.kdfOptions ?? new Uint8Array(0)),
    u32(opts.keyCount ?? 1),
    sstr(opts.pubBlob ?? join(sstr(bytes("ssh-ed25519")), sstr(new Uint8Array(32).fill(4)))),
    sstr(opts.section ?? new Uint8Array(0)),
  ));
}

/** A private section: two check words, key type, public key, private key, comment. */
function section(opts: {
  check1?: number; check2?: number; type?: string; pub?: Uint8Array; priv?: Uint8Array;
}): Uint8Array {
  return join(
    u32(opts.check1 ?? 0x01020304),
    u32(opts.check2 ?? 0x01020304),
    sstr(bytes(opts.type ?? "ssh-ed25519")),
    sstr(opts.pub ?? new Uint8Array(32).fill(4)),
    sstr(opts.priv ?? new Uint8Array(64).fill(5)),
    sstr(bytes("comment")),
    new Uint8Array([1, 2, 3]),
  );
}

const noPass = new Uint8Array(0);
const good = keyFile({ section: section({}) });
mAuth.sshReadKeyStatus(good, noPass);
mAuth.sshReadKeySeed(good, noPass);
mAuth.sshReadKeyPublic(good, noPass);

for (
  const [pem, pass] of [
    [bytes(""), noPass],                                                    // nothing at all
    [bytes("-----BEGIN X-----\nnot base64 ~~~\n-----END X-----\n"), noPass],
    [armour(bytes("wrong magic!!!!")), noPass],                             // decodes, wrong magic
    [armour(bytes("openssh-key-v1\0")), noPass],                            // magic then nothing
    [keyFile({ keyCount: 2, section: section({}) }), noPass],               // more than one key
    [keyFile({ cipher: "aes128-ctr", kdf: "bcrypt", section: section({}) }), bytes("x")],
    [keyFile({ cipher: "aes256-ctr", kdf: "none", section: section({}) }), bytes("x")],
    [keyFile({ cipher: "aes256-ctr", kdf: "bcrypt", kdfOptions: new Uint8Array(0), section: section({}) }), bytes("x")],
    [keyFile({ cipher: "aes256-ctr", kdf: "bcrypt", kdfOptions: join(sstr(new Uint8Array(16).fill(1)), u32(0)), section: section({}) }), bytes("x")],
    [keyFile({ cipher: "aes256-ctr", kdf: "bcrypt", kdfOptions: join(sstr(new Uint8Array(0)), u32(4)), section: section({}) }), bytes("x")],
    // Encrypted, but with no passphrase supplied.
    [keyFile({ cipher: "aes256-ctr", kdf: "bcrypt", kdfOptions: join(sstr(new Uint8Array(16).fill(1)), u32(2)), section: new Uint8Array(96) }), noPass],
    // Encrypted with a passphrase: decrypts to noise, so the check words disagree.
    [keyFile({ cipher: "aes256-ctr", kdf: "bcrypt", kdfOptions: join(sstr(new Uint8Array(16).fill(1)), u32(2)), section: new Uint8Array(96) }), bytes("pw")],
    [keyFile({ section: section({ check2: 0x99999999 }) }), noPass],        // check words disagree
    [keyFile({ section: section({ type: "ssh-rsa" }) }), noPass],           // not ed25519
    [keyFile({ section: section({ pub: new Uint8Array(31) }) }), noPass],   // public key too short
    [keyFile({ section: section({ priv: new Uint8Array(63) }) }), noPass],  // private key too short
    [keyFile({ section: new Uint8Array([0, 0, 0, 1]) }), noPass],           // section truncated
    [armour(join(bytes("openssh-key-v1\0"), sstr(bytes("none")))), noPass], // header truncated
  ] as const
) {
  mAuth.sshReadKeyStatus(pem, pass);
  mAuth.sshReadKeySeed(pem, pass);
}

// CR LF line endings, which ssh-keygen does not write but a file copied through Windows has.
const crlf = bytes(text(good).replace(/\n/g, "\r\n"));
mAuth.sshReadKeyStatus(crlf, noPass);

// Valid check words, then nothing — the truncation that only the second `ok` test catches.
mAuth.sshReadKeyStatus(keyFile({ section: join(u32(9), u32(9), new Uint8Array([0, 0])) }), noPass);

const sessionId = new Uint8Array(32).fill(7);
const pubBlob = join(sstr(bytes("ssh-ed25519")), sstr(new Uint8Array(32).fill(4)));
mAuth.sshSignedData(sessionId, bytes("user"), pubBlob);
mAuth.sshPublicKeyRequest(sessionId, bytes("user"), pubBlob, new Uint8Array(32).fill(6));
ignoringTraps(() => mAuth.sshPublicKeyRequest(sessionId, bytes("user"), pubBlob, new Uint8Array(31)));

// ── known_hosts ───────────────────────────────────────────────────────────────

const mKnown = run.mod as unknown as {
  sshKnownHost(file: Uint8Array, host: Uint8Array, port: number, keyType: Uint8Array, keyBlob: Uint8Array): number;
};

const khBlob = Uint8Array.from({ length: 51 }, (_, i) => (i * 3) & 255);
const khOther = Uint8Array.from({ length: 51 }, (_, i) => (i * 5) & 255);
const khB64 = btoa(String.fromCharCode(...khBlob));
const khType = bytes("ssh-ed25519");

for (
  const [file, host, port] of [
    ["", "example.com", 22],
    ["# just a comment\n", "example.com", 22],
    ["\n\n", "example.com", 22],
    ["   \n", "example.com", 22],                                   // whitespace only
    [`example.com ssh-ed25519 ${khB64}\n`, "example.com", 22],
    [`example.com ssh-ed25519 ${khB64}\r\n`, "example.com", 22],     // CR LF
    [`example.com ssh-ed25519 ${khB64} a comment\n`, "example.com", 22],
    [`a.example,b.example ssh-ed25519 ${khB64}\n`, "b.example", 22],
    [`*.example ssh-ed25519 ${khB64}\n`, "host.example", 22],
    [`*.example ssh-ed25519 ${khB64}\n`, "example", 22],
    [`*.exa*ple ssh-ed25519 ${khB64}\n`, "host.example", 22],       // two stars
    [`h??t.example ssh-ed25519 ${khB64}\n`, "host.example", 22],
    [`h??t.example ssh-ed25519 ${khB64}\n`, "hoost.example", 22],
    [`*.example,!bad.example ssh-ed25519 ${khB64}\n`, "bad.example", 22],
    [`*.example,!bad.example ssh-ed25519 ${khB64}\n`, "ok.example", 22],
    [`,,example.com,, ssh-ed25519 ${khB64}\n`, "example.com", 22],   // empty list entries
    [`example.com ssh-rsa ${khB64}\n`, "example.com", 22],           // another algorithm
    [`[example.com]:2222 ssh-ed25519 ${khB64}\n`, "example.com", 2222],
    [`[example.com]:2222 ssh-ed25519 ${khB64}\n`, "example.com", 22],
    [`example.com ssh-ed25519 ${khB64}\n`, "example.com", 65535],    // multi-digit port
    [`@revoked example.com ssh-ed25519 ${khB64}\n`, "example.com", 22],
    [`@cert-authority *.example ssh-ed25519 ${khB64}\n`, "host.example", 22],
    [`@revoked\n`, "example.com", 22],                               // marker and nothing else
    [`example.com ssh-ed25519 !!!\n`, "example.com", 22],            // unreadable base64
    [`example.com\n`, "example.com", 22],                            // no key at all
    [`example.com ssh-ed25519\n`, "example.com", 22],                // no blob
    [`|1|bad ssh-ed25519 ${khB64}\n`, "example.com", 22],            // hashed, no second bar
    [`|2|c2FsdA==|aGFzaA== ssh-ed25519 ${khB64}\n`, "example.com", 22],  // unknown revision
    [`|1|!!!|!!! ssh-ed25519 ${khB64}\n`, "example.com", 22],        // hashed, unreadable base64
    [`|1|c2FsdA==|aGFzaA== ssh-ed25519 ${khB64}\n`, "example.com", 22], // hashed, wrong hash
    [`\texample.com ssh-ed25519 ${khB64}\n`, "example.com", 22],      // leading tab
  ] as const
) {
  for (const key of [khBlob, khOther]) {
    mKnown.sshKnownHost(bytes(file), bytes(host), port, khType, key);
  }
  mKnown.sshKnownHost(bytes(file), bytes(host), port, bytes("ssh-rsa"), khBlob);
}

// Port 0, which is not a real port but is what the digit loop's zero guard exists for.
mKnown.sshKnownHost(bytes(`[example.com]:0 ssh-ed25519 ${khB64}\n`), bytes("example.com"), 0, khType, khBlob);

// A marker and a key type that are the *same length* as the ones being compared but different.
// Everything above differs in length and is rejected before the bytes are looked at, so without
// these the byte-comparison loop never takes its mismatch branch — the third time this exact gap
// has turned up in this package.
mKnown.sshKnownHost(bytes(`@revoke1 example.com ssh-ed25519 ${khB64}\n`), bytes("example.com"), 22, khType, khBlob);
mKnown.sshKnownHost(bytes(`example.com ssh-ed25518 ${khB64}\n`), bytes("example.com"), 22, khType, khBlob);

// A match after a mismatch, and a revocation after a match: the whole file is read either way.
mKnown.sshKnownHost(bytes(`example.com ssh-ed25519 ${btoa(String.fromCharCode(...khOther))}\n` +
                          `example.com ssh-ed25519 ${khB64}\n`), bytes("example.com"), 22, khType, khBlob);
mKnown.sshKnownHost(bytes(`example.com ssh-ed25519 ${khB64}\n@revoked example.com ssh-ed25519 ${khB64}\n`),
                    bytes("example.com"), 22, khType, khBlob);

// ── Channels ──────────────────────────────────────────────────────────────────

const mChan = run.mod as unknown as {
  sshDefaultWindow(): number;
  sshDefaultMaxPacket(): number;
  sshExtendedDataStderr(): number;
  sshMsgChannelData(): number;
  sshMsgChannelExtendedData(): number;
  sshMsgChannelOpenConfirmation(): number;
  sshMsgChannelOpenFailure(): number;
  sshMsgChannelClose(): number;
  sshMsgChannelEof(): number;
  sshMsgChannelRequest(): number;
  sshMsgChannelSuccess(): number;
  sshMsgChannelWindowAdjust(): number;
  sshOpenSession(channel: number, window: number, maxPacket: number): Uint8Array;
  sshExecRequest(channel: number, command: Uint8Array, wantReply: boolean): Uint8Array;
  sshWindowAdjust(channel: number, increment: number): Uint8Array;
  sshChannelEof(channel: number): Uint8Array;
  sshChannelClose(channel: number): Uint8Array;
  sshChannelData(channel: number, data: Uint8Array): Uint8Array;
  sshIncomingField(payload: Uint8Array, which: number): number;
  sshIncomingData(payload: Uint8Array): Uint8Array;
  sshWindowCreate(initial: number): unknown;
  sshWindowConsume(w: unknown, n: number): number;
  sshWindowLeft(w: unknown): number;
};

mChan.sshDefaultWindow();
mChan.sshDefaultMaxPacket();
mChan.sshExtendedDataStderr();
for (const f of [mChan.sshMsgChannelData, mChan.sshMsgChannelExtendedData,
                 mChan.sshMsgChannelOpenConfirmation, mChan.sshMsgChannelOpenFailure,
                 mChan.sshMsgChannelClose, mChan.sshMsgChannelEof, mChan.sshMsgChannelRequest,
                 mChan.sshMsgChannelSuccess, mChan.sshMsgChannelWindowAdjust]) f.call(mChan);

mChan.sshOpenSession(0, 8192, 32768);
mChan.sshExecRequest(1, bytes("true"), true);
mChan.sshExecRequest(1, bytes("true"), false);
mChan.sshWindowAdjust(1, 4096);
mChan.sshChannelEof(1);
mChan.sshChannelClose(1);
mChan.sshChannelData(1, bytes("x"));

// The window: above half, at half, across it, and a read larger than the whole window.
const cw = mChan.sshWindowCreate(1000);
mChan.sshWindowConsume(cw, 100);
mChan.sshWindowLeft(cw);
mChan.sshWindowConsume(cw, 400);
mChan.sshWindowConsume(cw, 2000);

const cu32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cstr = (b: Uint8Array) => join(cu32(b.length), b);

for (
  const p of [
    new Uint8Array(0),                                                        // nothing
    new Uint8Array([21]),                                                     // a transport message
    new Uint8Array([89]),                                                     // just below the range
    new Uint8Array([101]),                                                    // just above it
    new Uint8Array([90]),                                                     // channel message, truncated
    join(new Uint8Array([90]), cstr(bytes("session")), cu32(0), cu32(1), cu32(2)),
    join(new Uint8Array([91]), cu32(7), cu32(42), cu32(2097152), cu32(32768)),
    join(new Uint8Array([91]), cu32(7)),                                      // confirmation cut short
    join(new Uint8Array([92]), cu32(7), cu32(4), cstr(bytes("no")), cstr(bytes(""))),
    join(new Uint8Array([92]), cu32(7), cu32(4)),                             // failure cut short
    join(new Uint8Array([93]), cu32(7), cu32(4096)),
    join(new Uint8Array([93]), cu32(7)),                                      // adjust cut short
    join(new Uint8Array([94]), cu32(7), cstr(bytes("hello"))),
    join(new Uint8Array([94]), cu32(7), new Uint8Array([0, 0, 0, 9, 1])),      // data cut short
    join(new Uint8Array([95]), cu32(7), cu32(1), cstr(bytes("err"))),
    join(new Uint8Array([95]), cu32(7), cu32(1)),                             // extended cut short
    join(new Uint8Array([96]), cu32(7)),                                      // EOF
    join(new Uint8Array([97]), cu32(7)),                                      // CLOSE
    join(new Uint8Array([98]), cu32(7), cstr(bytes("exit-status")), new Uint8Array([0]), cu32(3)),
    join(new Uint8Array([98]), cu32(7), cstr(bytes("exit-status")), new Uint8Array([0])),
    join(new Uint8Array([98]), cu32(7), cstr(bytes("keepalive")), new Uint8Array([1])),
    join(new Uint8Array([98]), cu32(7), cstr(bytes("exit-statu5")), new Uint8Array([0])),  // same length, different
    join(new Uint8Array([98]), cu32(7)),                                      // request cut short
    join(new Uint8Array([99]), cu32(7)),                                      // SUCCESS
    join(new Uint8Array([100]), cu32(7)),                                     // FAILURE
  ]
) {
  for (let which = 0; which < 6; which++) mChan.sshIncomingField(p, which);
  mChan.sshIncomingData(p);
}

// ── The server half ───────────────────────────────────────────────────────────

const mSrv = run.mod as unknown as {
  sshAuthorized(file: Uint8Array, keyType: Uint8Array, keyBlob: Uint8Array): number;
  sshServerProposalField(which: number): Uint8Array;
  sshHostKeyBlob(publicKey: Uint8Array): Uint8Array;
  sshParseEcdhInit(payload: Uint8Array): Uint8Array;
  sshEcdhReply(hostKey: Uint8Array, qs: Uint8Array, h: Uint8Array, seed: Uint8Array): Uint8Array;
  sshServerExchangeHash(vc: Uint8Array, vs: Uint8Array, ic: Uint8Array, isrv: Uint8Array,
                        ks: Uint8Array, qc: Uint8Array, qs: Uint8Array, k: Uint8Array): Uint8Array;
  sshAuthRequestField(payload: Uint8Array, which: number): number;
  sshAuthRequestUser(payload: Uint8Array): Uint8Array;
  sshAuthRequestMethod(payload: Uint8Array): Uint8Array;
  sshVerifyAuth(payload: Uint8Array, sessionId: Uint8Array): boolean;
  sshAuthFailure(): Uint8Array;
  sshAuthSuccess(): Uint8Array;
  sshPkOk(keyType: Uint8Array, blob: Uint8Array): Uint8Array;
  sshServiceAccept(name: Uint8Array): Uint8Array;
  sshDisconnect(why: Uint8Array): Uint8Array;
  sshOpenConfirmation(client: number, ours: number, window: number, maxPacket: number): Uint8Array;
  sshOpenFailure(client: number, reason: number, why: Uint8Array): Uint8Array;
  sshChannelSuccessMsg(channel: number): Uint8Array;
  sshServerData(channel: number, data: Uint8Array): Uint8Array;
  sshServerStderr(channel: number, data: Uint8Array): Uint8Array;
  sshExitStatus(channel: number, status: number): Uint8Array;
  sshExecCommand(payload: Uint8Array): Uint8Array;
  sshEphemeralPublicForSeed(seed: Uint8Array): Uint8Array;
};

const akBlob = Uint8Array.from({ length: 51 }, (_, i) => (i * 3) & 255);
const akOther = Uint8Array.from({ length: 51 }, (_, i) => (i * 5) & 255);
const akB64 = btoa(String.fromCharCode(...akBlob));
const akType = bytes("ssh-ed25519");

for (
  const file of [
    "",
    "# comment only\n",
    "\n\n",
    "   \n",
    `ssh-ed25519 ${akB64}\n`,
    `ssh-ed25519 ${akB64}\r\n`,
    `ssh-ed25519 ${akB64} me@here\n`,
    `\tssh-ed25519 ${akB64}\n`,                                  // leading tab
    `ssh-rsa ${akB64}\n`,                                        // another algorithm
    `ssh-ed2551a ${akB64}\n`,                                    // same length, different
    `no-pty ssh-ed25519 ${akB64}\n`,                             // an option
    `restrict,pty ssh-ed25519 ${akB64}\n`,
    `command="echo hello world" ssh-ed25519 ${akB64}\n`,          // spaces inside quotes
    `command="a,b c",no-pty ssh-ed25519 ${akB64}\n`,              // a comma inside quotes
    `command="say \\"hi\\" now" ssh-ed25519 ${akB64}\n`,          // an escaped quote
    `command="unterminated ssh-ed25519 ${akB64}\n`,               // a quote that never closes
    `no-pty ssh-rsa ${akB64}\n`,                                 // options then another algorithm
    `no-pty\n`,                                                  // options and nothing else
    `ssh-ed25519\n`,                                             // no blob
    `ssh-ed25519 !!!\n`,                                         // unreadable base64
    `no-pty ssh-ed25519 ${akB64}\nssh-ed25519 ${akB64}\n`,        // restricted then plain
  ]
) {
  for (const key of [akBlob, akOther]) mSrv.sshAuthorized(bytes(file), akType, key);
  mSrv.sshAuthorized(bytes(file), bytes("ssh-rsa"), akBlob);
}

// A line whose key decodes to a *different length*. Every blob above is 51 bytes, so the length
// check in the comparison never fired — the same shape as the same-length name gaps, inverted.
mSrv.sshAuthorized(bytes(`ssh-ed25519 ${btoa("short")}\n`), akType, akBlob);

for (let which = 0; which < 4; which++) mSrv.sshServerProposalField(which);

const srvSeed = Uint8Array.from({ length: 32 }, (_, i) => (i * 9 + 1) & 255);
const srvPoint = mSrv.sshEphemeralPublicForSeed(srvSeed);
const srvKs = mSrv.sshHostKeyBlob(srvPoint);
ignoringTraps(() => mSrv.sshHostKeyBlob(new Uint8Array(31)));

const srvQ = mKex.sshEphemeralPublic(Uint8Array.from({ length: 32 }, (_, i) => i + 2));
mSrv.sshParseEcdhInit(join(new Uint8Array([30]), str(srvQ)));
mSrv.sshParseEcdhInit(join(new Uint8Array([31]), str(srvQ)));               // wrong message
mSrv.sshParseEcdhInit(new Uint8Array([30]));                               // truncated
mSrv.sshParseEcdhInit(join(new Uint8Array([30]), str(new Uint8Array(31)))); // wrong length

const srvH = mSrv.sshServerExchangeHash(bytes("SSH-2.0-a"), bytes("SSH-2.0-b"),
  new Uint8Array([20]), new Uint8Array([20]), srvKs, srvQ, srvQ, srvSeed);
mSrv.sshEcdhReply(srvKs, srvQ, srvH, srvSeed);
ignoringTraps(() => mSrv.sshEcdhReply(srvKs, srvQ, srvH, new Uint8Array(31)));

const srvSession = Uint8Array.from({ length: 32 }, (_, i) => (i * 13) & 255);
const srvUser = bytes("claude");
const genuine = mAuth.sshPublicKeyRequest(srvSession, srvUser, srvKs, srvSeed);
for (let which = 0; which < 4; which++) mSrv.sshAuthRequestField(genuine, which);
mSrv.sshAuthRequestUser(genuine);
mSrv.sshAuthRequestMethod(genuine);
mSrv.sshVerifyAuth(genuine, srvSession);
mSrv.sshVerifyAuth(genuine, new Uint8Array(32));                            // wrong session

for (
  const bad of [
    new Uint8Array(0),
    new Uint8Array([49]),                                                   // not a userauth request
    new Uint8Array([50]),                                                   // truncated
    join(new Uint8Array([50]), str(srvUser), str(bytes("ssh-connection")), str(bytes("password")),
         new Uint8Array([0]), str(bytes("hunter2"))),                       // another method
    join(new Uint8Array([50]), str(srvUser), str(bytes("ssh-connection")), str(bytes("publickey")),
         new Uint8Array([0]), str(bytes("ssh-ed25519")), str(srvKs)),       // a probe
    join(new Uint8Array([50]), str(srvUser), str(bytes("ssh-connection")), str(bytes("publickey")),
         new Uint8Array([1]), str(bytes("ssh-rsa")), str(srvKs), str(new Uint8Array(64))),
    join(new Uint8Array([50]), str(srvUser), str(bytes("ssh-connection")), str(bytes("publickey")),
         new Uint8Array([1]), str(bytes("ssh-ed25519")), str(new Uint8Array(4)), str(new Uint8Array(64))),
    join(new Uint8Array([50]), str(srvUser), str(bytes("ssh-connection")), str(bytes("publickey")),
         new Uint8Array([1]), str(bytes("ssh-ed25519")), str(srvKs),
         join(str(bytes("ssh-rsa")), str(new Uint8Array(64)))),             // signature names ssh-rsa
    join(new Uint8Array([50]), str(srvUser), str(bytes("ssh-connection")), str(bytes("publickey")),
         new Uint8Array([1]), str(bytes("ssh-ed25519")), str(srvKs),
         join(str(bytes("ssh-ed25519")), str(new Uint8Array(63)))),         // 63-byte signature
    join(new Uint8Array([50]), str(srvUser), str(bytes("ssh-connection")), str(bytes("publickey")),
         new Uint8Array([1]), str(bytes("ssh-ed25519")), str(srvKs)),       // signature missing
  ]
) {
  for (let which = 0; which < 4; which++) mSrv.sshAuthRequestField(bad, which);
  mSrv.sshAuthRequestUser(bad);
  mSrv.sshVerifyAuth(bad, srvSession);
}

// The server's own curve operations, which are separate functions from the client's.
const mSrv2 = run.mod as unknown as {
  sshServerEphemeral(secret: Uint8Array): Uint8Array;
  sshServerShared(secret: Uint8Array, peer: Uint8Array): Uint8Array;
  sshServerChannelFailure(channel: number): Uint8Array;
  sshServerChannelEof(channel: number): Uint8Array;
  sshServerChannelClose(channel: number): Uint8Array;
};
const srvSecret = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
const srvPub = mSrv2.sshServerEphemeral(srvSecret);
mSrv2.sshServerShared(srvSecret, srvPub);
mSrv2.sshServerShared(srvSecret, new Uint8Array(32));       // all-zero point
mSrv2.sshServerShared(new Uint8Array(31), srvPub);          // wrong secret length
mSrv2.sshServerShared(srvSecret, new Uint8Array(31));       // wrong peer length
ignoringTraps(() => mSrv2.sshServerEphemeral(new Uint8Array(31)));
mSrv2.sshServerChannelFailure(7);
mSrv2.sshServerChannelEof(7);
mSrv2.sshServerChannelClose(7);

// Names the same length as the ones compared, so the byte loops take their mismatch branch —
// the fourth time this gap has appeared in this package, hence checking for it up front.
mSrv.sshAuthorized(bytes(`ssh-ed2551a ${akB64}\n`), akType, akBlob);
mSrv.sshExecCommand(join(new Uint8Array([98]), cu32(0), cstr(bytes("exe0")), new Uint8Array([1]),
                         cstr(bytes("x"))));

mSrv.sshAuthFailure();
mSrv.sshAuthSuccess();
mSrv.sshPkOk(akType, srvKs);
mSrv.sshServiceAccept(bytes("ssh-userauth"));
mSrv.sshDisconnect(bytes("done"));
mSrv.sshOpenConfirmation(11, 22, 4096, 1024);
mSrv.sshOpenFailure(11, 3, bytes("only session channels"));
mSrv.sshChannelSuccessMsg(7);
mSrv.sshServerData(7, bytes("out"));
mSrv.sshServerStderr(7, bytes("err"));
mSrv.sshExitStatus(7, 42);

mSrv.sshExecCommand(join(new Uint8Array([98]), cu32(0), cstr(bytes("exec")), new Uint8Array([1]),
                         cstr(bytes("uname -a"))));
mSrv.sshExecCommand(join(new Uint8Array([98]), cu32(0), cstr(bytes("pty-req")), new Uint8Array([1])));
mSrv.sshExecCommand(join(new Uint8Array([98]), cu32(0), cstr(bytes("exec")), new Uint8Array([1])));
mSrv.sshExecCommand(new Uint8Array([94]));
mSrv.sshExecCommand(new Uint8Array([98]));

report([run], "packages/ssh/", { verbose });
