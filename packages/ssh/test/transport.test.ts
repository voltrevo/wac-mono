// The SSH transport, against a real OpenSSH server.
//
// The unit tests below pin the wire types and the packet framing against their rules. This first
// one is the only test that can tell us the rules were read correctly: it runs `sshd`, performs
// the version exchange and the KEXINIT exchange with it, and negotiates. A server that dislikes
// anything about our framing closes the connection instead of answering, so reaching a parsed
// server KEXINIT means the packet layer is right in both directions.

import { wacBind } from "../../../harness/wacBind.ts";
import { freePort, haveSshd, type Server, startServer, stopServer } from "./server.ts";

const mod = await wacBind("packages/ssh/test/wac/probe.wac") as unknown as {
  sshMessageNumbers(): Int32Array;
  sshServerChannelFailure(channel: number): Uint8Array;
  sshServerReadOpenChannel(payload: Uint8Array): number;
  sshServerDisconnect(reason: number, description: Uint8Array): Uint8Array;
  sshServerOpenFailure(channel: number, reason: number, description: Uint8Array): Uint8Array;
  sshByApplication(): number;
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
  sshEphemeralPublic(secret: Uint8Array): Uint8Array;
  sshEcdhInit(qc: Uint8Array): Uint8Array;
  sshEcdhReplyOk(payload: Uint8Array): boolean;
  sshEcdhReplyField(payload: Uint8Array, which: number): Uint8Array;
  sshSharedSecret(secret: Uint8Array, peerPublic: Uint8Array): Uint8Array;
  sshExchangeHash(vc: Uint8Array, vs: Uint8Array, ic: Uint8Array, isrv: Uint8Array,
                  ks: Uint8Array, qc: Uint8Array, qs: Uint8Array, k: Uint8Array): Uint8Array;
  sshVerifyHostKey(hostKey: Uint8Array, signature: Uint8Array, h: Uint8Array): boolean;
  sshDeriveKey(k: Uint8Array, h: Uint8Array, sessionId: Uint8Array, letter: number, needed: number): Uint8Array;
  sshCipherKeyLength(): number;
  sshCipherTagLength(): number;
  sshAeadPaddingFor(n: number, block: number): number;
  sshSeal(key: Uint8Array, seq: number, payload: Uint8Array, random: Uint8Array, block: number): Uint8Array;
  sshPeekLength(key: Uint8Array, seq: number, src: Uint8Array, at: number): number;
  sshOpenStatus(key: Uint8Array, seq: number, src: Uint8Array, at: number, end: number, maxPacket: number): number;
  sshOpenPayload(key: Uint8Array, seq: number, src: Uint8Array, at: number, end: number, maxPacket: number): Uint8Array;
  sshOpenUsed(key: Uint8Array, seq: number, src: Uint8Array, at: number, end: number, maxPacket: number): number;
  sshSealBody(key: Uint8Array, seq: number, body: Uint8Array): Uint8Array;
  sshReadKeyStatus(pem: Uint8Array, passphrase: Uint8Array): number;
  sshReadKeySeed(pem: Uint8Array, passphrase: Uint8Array): Uint8Array;
  sshReadKeyPublic(pem: Uint8Array, passphrase: Uint8Array): Uint8Array;
  sshMsgUserAuthSuccess(): number;
  sshMsgUserAuthFailure(): number;
  sshMsgServiceAccept(): number;
  sshKnownHost(file: Uint8Array, host: Uint8Array, port: number, keyType: Uint8Array, keyBlob: Uint8Array): number;
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
  sshServiceRequest(): Uint8Array;
  sshSignedData(sessionId: Uint8Array, user: Uint8Array, publicBlob: Uint8Array): Uint8Array;
  sshPublicKeyRequest(sessionId: Uint8Array, user: Uint8Array, publicBlob: Uint8Array, seed: Uint8Array): Uint8Array;
};

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b).map(v => v.toString(16).padStart(2, "0")).join("");

/**
 * The whole handshake, up to an authenticated connection.
 *
 * Every intermediate value is returned rather than only the result, so the test that exists to
 * *verify* the handshake can assert over them while the tests that merely need a session ignore
 * them. Only the checks a caller could not continue past are made here.
 */
async function handshake(s: Server) {
  const { conn, dir, port } = s;
  const block = mod.sshMinBlock();
  const MAX = 35000;
  let buf = new Uint8Array(0);

  const read = async () => {
    const chunk = new Uint8Array(65536);
    const n = await conn.read(chunk);
    if (n === null) throw new Error("server closed the connection");
    const next = new Uint8Array(buf.length + n);
    next.set(buf);
    next.set(chunk.subarray(0, n), buf.length);
    buf = next;
  };
  const framed = async (payload: Uint8Array) => {
    const pad = crypto.getRandomValues(new Uint8Array(mod.sshPaddingFor(payload.length, block)));
    await conn.write(mod.sshFrame(payload, pad, block));
  };
  const nextPlain = async () => {
    while (mod.sshUnframeStatus(buf) === 1) await read();
    if (mod.sshUnframeStatus(buf) !== 0) throw new Error("a packet could not be framed");
    const p = mod.sshUnframePayload(buf);
    buf = buf.slice(mod.sshUnframeUsed(buf));
    return p;
  };

  // Our version line goes first; SSH does not wait for the peer's.
  await conn.write(mod.sshClientVersionLine());
  while (mod.sshScanStatus(buf) === 1) await read();
  if (mod.sshScanStatus(buf) !== 0) throw new Error("server version line was rejected");
  const serverVersion = mod.sshScanLine(buf);
  buf = buf.slice(mod.sshScanUsed(buf));

  // KEXINIT, both sides sending without waiting.
  const cookie = crypto.getRandomValues(new Uint8Array(16));
  const ourKexInit = mod.sshKexInit(cookie);
  await framed(ourKexInit);
  const serverKexInit = await nextPlain();
  if (serverKexInit[0] !== 20) throw new Error(`expected KEXINIT, got ${serverKexInit[0]}`);

  // Key exchange.
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const qc = mod.sshEphemeralPublic(secret);
  await framed(mod.sshEcdhInit(qc));
  const reply = await nextPlain();
  if (reply[0] !== 31) throw new Error(`expected KEX_ECDH_REPLY, got ${reply[0]}`);
  const hostKeyBlob = mod.sshEcdhReplyField(reply, 0);
  const qs = mod.sshEcdhReplyField(reply, 1);
  const signature = mod.sshEcdhReplyField(reply, 2);
  const shared = mod.sshSharedSecret(secret, qs);
  if (shared.length === 0) throw new Error("shared secret was rejected as low-order");
  const h = mod.sshExchangeHash(mod.sshClientVersion(), serverVersion, ourKexInit, serverKexInit,
                                hostKeyBlob, qc, qs, shared);
  if (!mod.sshVerifyHostKey(hostKeyBlob, signature, h)) {
    throw new Error("the server's host key signature did not verify over our exchange hash");
  }

  // NEWKEYS. Both sides advertised strict KEX, so the sequence numbers reset to zero here.
  await framed(new Uint8Array([21]));
  const nk = await nextPlain();
  if (nk[0] !== 21) throw new Error(`expected NEWKEYS, got ${nk[0]}`);

  const keyOut = mod.sshDeriveKey(shared, h, h, 0x43, mod.sshCipherKeyLength());
  const keyIn = mod.sshDeriveKey(shared, h, h, 0x44, mod.sshCipherKeyLength());
  let outSeq = 0;
  let inSeq = 0;

  const send = async (payload: Uint8Array) => {
    const pad = crypto.getRandomValues(
      new Uint8Array(mod.sshAeadPaddingFor(payload.length, block)));
    await conn.write(mod.sshSeal(keyOut, outSeq, payload, pad, block));
    outSeq++;
  };
  const next = async () => {
    while (mod.sshOpenStatus(keyIn, inSeq, buf, 0, buf.length, MAX) === 1) await read();
    if (mod.sshOpenStatus(keyIn, inSeq, buf, 0, buf.length, MAX) !== 0) {
      throw new Error(`encrypted packet ${inSeq} did not open`);
    }
    const p = mod.sshOpenPayload(keyIn, inSeq, buf, 0, buf.length, MAX);
    buf = buf.slice(mod.sshOpenUsed(keyIn, inSeq, buf, 0, buf.length, MAX));
    inSeq++;
    return p;
  };

  await send(mod.sshServiceRequest());
  let sawExtInfo = false;
  let accepted = false;
  for (let i = 0; i < 8 && !accepted; i++) {
    const p = await next();
    if (p[0] === 7) sawExtInfo = true;
    if (p[0] === mod.sshMsgServiceAccept()) accepted = true;
  }
  if (!accepted) throw new Error("never received SSH_MSG_SERVICE_ACCEPT");

  // Authenticate, reading the private key with our own code.
  const pem = await Deno.readFile(`${dir}/clientkey`);
  const empty = new Uint8Array(0);
  if (mod.sshReadKeyStatus(pem, empty) !== 0) throw new Error("could not read the private key");
  const seed = mod.sshReadKeySeed(pem, empty);
  const publicBlob = mod.sshReadKeyPublic(pem, empty);
  const user = bytes(Deno.env.get("USER") ?? "claude");
  await send(mod.sshPublicKeyRequest(h, user, publicBlob, seed));

  let authed = false;
  for (let i = 0; i < 8 && !authed; i++) {
    const p = await next();
    if (p[0] === mod.sshMsgUserAuthFailure()) {
      throw new Error(`the server rejected our signature: ${text(mod.sshReadString(p.slice(1)))}`);
    }
    if (p[0] === mod.sshMsgUserAuthSuccess()) authed = true;
  }
  if (!authed) throw new Error("never received SSH_MSG_USERAUTH_SUCCESS");

  return {
    serverVersion, ourKexInit, serverKexInit, hostKeyBlob, signature, qc, qs, shared, h,
    publicBlob, seed, sawExtInfo, block, port, dir, send, next, MAX,
  };
}

Deno.test({
  name: "connect to a real OpenSSH server and authenticate with a public key",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Server | undefined;
    try {
      s = await startServer();
      const r = await handshake(s);

      if (!text(r.serverVersion).startsWith("SSH-2.0-OpenSSH")) {
        throw new Error(`expected an OpenSSH server, got ${text(r.serverVersion)}`);
      }
      if (!mod.sshSpeaksV2(r.serverVersion)) throw new Error("server is not SSH-2.0");

      // Our choice must be our own first preference that the server supports — client order
      // decides, and the server's is ignored.
      const kex = text(mod.sshNegotiate(r.serverKexInit, 0));
      const hostKey = text(mod.sshNegotiate(r.serverKexInit, 1));
      const cipherOut = text(mod.sshNegotiate(r.serverKexInit, 2));
      const cipherIn = text(mod.sshNegotiate(r.serverKexInit, 3));
      if (kex !== "curve25519-sha256") throw new Error(`kex negotiated as ${kex}`);
      if (hostKey !== "ssh-ed25519") throw new Error(`host key negotiated as ${hostKey}`);
      if (cipherOut !== "chacha20-poly1305@openssh.com") throw new Error(`c2s cipher: ${cipherOut}`);
      if (cipherIn !== "chacha20-poly1305@openssh.com") throw new Error(`s2c cipher: ${cipherIn}`);

      // Sanity that we parsed the server's lists rather than our own: OpenSSH offers several key
      // exchanges, and a single-entry list would mean we read back what we sent.
      const theirKex = text(mod.sshProposalField(r.serverKexInit, 0));
      if (!theirKex.includes(",")) throw new Error(`server kex list looks wrong: ${theirKex}`);
      if (!theirKex.includes("kex-strict-s-v00@openssh.com")) {
        throw new Error("server did not offer strict KEX, so the sequence numbers do not reset");
      }

      // Tampering with H must break the signature — otherwise `handshake`'s check proves nothing.
      const bent = new Uint8Array(r.h);
      bent[0] ^= 1;
      if (mod.sshVerifyHostKey(r.hostKeyBlob, r.signature, bent)) {
        throw new Error("a signature verified over the wrong exchange hash");
      }

      // A verifying signature only proves the peer holds the key it presented — it says nothing
      // about *which* peer. So the host key goes through known_hosts, as a real client does.
      const wantBlob = (await Deno.readTextFile(`${s.dir}/hostkey.pub`)).split(" ")[1];
      const knownHosts = bytes(`[127.0.0.1]:${s.port} ssh-ed25519 ${wantBlob}\n`);
      const host = bytes("127.0.0.1");
      const keyType = bytes("ssh-ed25519");
      if (mod.sshKnownHost(knownHosts, host, s.port, keyType, r.hostKeyBlob) !== 1) {
        throw new Error("known_hosts did not recognise the host key");
      }
      if (mod.sshKnownHost(new Uint8Array(0), host, s.port, keyType, r.hostKeyBlob) !== 0) {
        throw new Error("an empty known_hosts matched");
      }
      const wrong = bytes(`[127.0.0.1]:${s.port} ssh-ed25519 ${btoa(String.fromCharCode(
        ...Uint8Array.from({ length: 51 }, (_, i) => i)))}\n`);
      if (mod.sshKnownHost(wrong, host, s.port, keyType, r.hostKeyBlob) !== 2) {
        throw new Error("a changed host key was not caught");
      }

      // The blob we parsed out of the private key must be the one in the .pub file, or we would
      // be offering a key the server never heard of and reading its refusal as our own bug.
      const wantPub = (await Deno.readTextFile(`${s.dir}/clientkey.pub`)).split(" ")[1];
      if (btoa(String.fromCharCode(...r.publicBlob)) !== wantPub) {
        throw new Error("the public blob from the private key does not match clientkey.pub");
      }
      if (!r.sawExtInfo) {
        throw new Error("no EXT_INFO, though we advertised ext-info-c — decryption may be wrong");
      }
    } finally {
      await stopServer(s);
    }
  },
});

Deno.test("mpint is minimal, and signed", () => {
  // RFC 4251 §5 gives these exact encodings, which is why they are the ones checked.
  const cases: [string, string][] = [
    ["", "00000000"],                                   // zero is an empty string, not one byte
    ["00", "00000000"],                                 // leading zeroes are stripped to nothing
    // RFC 4251 §5's own example. It writes the value as `9a378f9b2e332a7`, an odd number of hex
    // digits, so the byte string is `09 a3 …` — here with two leading zero bytes to strip as well.
    ["000009a378f9b2e332a7", "0000000809a378f9b2e332a7"],
    ["80", "000000020080"],                             // high bit set, so a zero byte is added
    ["ff", "0000000200ff"],
    ["7f", "000000017f"],                               // high bit clear, no padding
    ["0000ff00", "0000000300ff00"],                     // strip, then pad
  ];
  for (const [inHex, wantHex] of cases) {
    // An odd-length literal would silently lose its last digit to the pairing below, and the
    // resulting test would still look like it was checking the RFC's value.
    if (inHex.length % 2 !== 0) throw new Error(`test vector ${inHex} is not whole bytes`);
    const magnitude = Uint8Array.from(
      (inHex.match(/../g) ?? []).map(h => parseInt(h, 16)));
    const got = hex(mod.sshWriteMpint(magnitude));
    if (got !== wantHex) throw new Error(`mpint(${inHex || "empty"}): got ${got}, want ${wantHex}`);
  }
});

Deno.test("a string carries arbitrary binary, including NULs", () => {
  const payload = new Uint8Array([0, 1, 0, 255, 0x2c, 0]);
  const wire = mod.sshWriteString(payload);
  if (hex(wire) !== "00000006" + hex(payload)) throw new Error(`framed wrong: ${hex(wire)}`);
  const back = mod.sshReadString(wire);
  if (hex(back) !== hex(payload)) throw new Error(`round trip lost bytes: ${hex(back)}`);
});

Deno.test("a truncated or oversized string is refused, not guessed at", () => {
  // Claims 8 bytes, supplies 3.
  if (mod.sshReadStringOk(new Uint8Array([0, 0, 0, 8, 1, 2, 3]))) {
    throw new Error("a truncated string was accepted");
  }
  // Claims 2^31 bytes: the length is negative once read into an i32, which must be rejected
  // rather than wrapped into a small read.
  if (mod.sshReadStringOk(new Uint8Array([0x80, 0, 0, 0, 1, 2, 3]))) {
    throw new Error("a string claiming 2^31 bytes was accepted");
  }
  if (!mod.sshReadStringOk(new Uint8Array([0, 0, 0, 3, 1, 2, 3]))) {
    throw new Error("a well-formed string was refused");
  }
});

Deno.test("padding keeps the whole packet aligned, including the length field", () => {
  for (const block of [8, 16]) {
    for (let n = 0; n < 64; n++) {
      const pad = mod.sshPaddingFor(n, block);
      if (pad < 4) throw new Error(`payload ${n}, block ${block}: padding ${pad} is under the minimum`);
      if ((4 + 1 + n + pad) % block !== 0) {
        throw new Error(`payload ${n}, block ${block}: total ${4 + 1 + n + pad} is not a multiple`);
      }
      // Minimal: dropping a whole block would still leave 4 or more, so it was not chosen.
      if (pad - block >= 4) throw new Error(`payload ${n}, block ${block}: padding ${pad} is not minimal`);
    }
  }
});

Deno.test("a framed packet unframes to what went in", () => {
  const block = mod.sshMinBlock();
  for (const n of [0, 1, 7, 8, 9, 100, 1000]) {
    const payload = Uint8Array.from({ length: n }, (_, i) => (i * 31) & 255);
    const random = crypto.getRandomValues(new Uint8Array(mod.sshPaddingFor(n, block)));
    const packet = mod.sshFrame(payload, random, block);
    if (packet.length % block !== 0) throw new Error(`packet of ${n} is not block-aligned`);
    if (mod.sshUnframeStatus(packet) !== 0) throw new Error(`packet of ${n} did not unframe`);
    if (hex(mod.sshUnframePayload(packet)) !== hex(payload)) throw new Error(`payload of ${n} changed`);
    if (mod.sshUnframeUsed(packet) !== packet.length) throw new Error(`used wrong for ${n}`);

    // One byte short is "read more", never a parse.
    if (mod.sshUnframeStatus(packet.slice(0, packet.length - 1)) !== 1) {
      throw new Error(`a short packet of ${n} was not reported as incomplete`);
    }
  }
});

Deno.test("a packet that cannot be one is malformed rather than trusted", () => {
  // padding_length below the minimum of 4.
  if (mod.sshUnframeStatus(new Uint8Array([0, 0, 0, 12, 3, ...new Array(11).fill(0)])) !== 2) {
    throw new Error("padding under 4 bytes was accepted");
  }
  // packet_length longer than anything anyone must accept.
  if (mod.sshUnframeStatus(new Uint8Array([0, 1, 0, 0, 8, 0, 0, 0])) !== 2) {
    throw new Error("an oversized packet length was accepted");
  }
  // padding_length larger than the packet, so the payload length goes negative.
  if (mod.sshUnframeStatus(new Uint8Array([0, 0, 0, 6, 200, 0, 0, 0, 0, 0])) !== 2) {
    throw new Error("padding longer than the packet was accepted");
  }
  // A length with the top bit set arrives negative in an i32.
  if (mod.sshUnframeStatus(new Uint8Array([0x80, 0, 0, 0, 8, 0, 0, 0])) !== 2) {
    throw new Error("a packet length of 2^31 was accepted");
  }
});

Deno.test("the version scanner skips a banner and keeps the line ending out of the string", () => {
  const withBanner = bytes("Authorized users only.\r\nAnother line\r\nSSH-2.0-OpenSSH_9.6\r\nleftover");
  if (mod.sshScanStatus(withBanner) !== 0) throw new Error("banner lines were not skipped");
  const line = text(mod.sshScanLine(withBanner));
  if (line !== "SSH-2.0-OpenSSH_9.6") throw new Error(`got ${JSON.stringify(line)}`);
  // `used` must land exactly after the CR LF, so the caller's next byte is the first packet.
  const rest = text(withBanner.slice(mod.sshScanUsed(withBanner)));
  if (rest !== "leftover") throw new Error(`used left ${JSON.stringify(rest)}`);

  // A bare LF is tolerated, and there is no CR to strip.
  const bareLf = bytes("SSH-2.0-Other\n");
  if (mod.sshScanStatus(bareLf) !== 0) throw new Error("a bare LF line was rejected");
  if (text(mod.sshScanLine(bareLf)) !== "SSH-2.0-Other") throw new Error("bare LF line mis-parsed");

  // Half a line is "read more", not a verdict.
  if (mod.sshScanStatus(bytes("SSH-2.0-Open")) !== 1) throw new Error("a partial line was not incomplete");

  // A line that can never fit the limit is refused rather than buffered forever.
  if (mod.sshScanStatus(bytes("x".repeat(300))) !== 2) throw new Error("an overlong line was not refused");
});

Deno.test("negotiation takes the client's preference, not the server's", () => {
  // Server offers both, in the opposite order to ours. Ours must win.
  const cookie = new Uint8Array(16);
  const serverPayload = (() => {
    // Build a KEXINIT by hand with a known list, since our own encoder only writes our proposal.
    const parts: number[] = [20, ...cookie];
    const str = (s: string) => {
      const b = bytes(s);
      parts.push((b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255);
      parts.push(...b);
    };
    str("curve25519-sha256@libssh.org,curve25519-sha256");   // reversed relative to ours
    str("ssh-ed25519");
    str("chacha20-poly1305@openssh.com");
    str("chacha20-poly1305@openssh.com");
    str("hmac-sha2-256");
    str("hmac-sha2-256");
    str("none");
    str("none");
    str("");
    str("");
    parts.push(0, 0, 0, 0, 0);
    return new Uint8Array(parts);
  })();

  if (!mod.sshProposalOk(serverPayload)) throw new Error("hand-built KEXINIT did not parse");
  const kex = text(mod.sshNegotiate(serverPayload, 0));
  if (kex !== "curve25519-sha256") {
    throw new Error(`server order won: got ${kex}, expected our first preference`);
  }
});

Deno.test("no overlap is an empty answer rather than a default", () => {
  const cookie = new Uint8Array(16);
  const parts: number[] = [20, ...cookie];
  const str = (s: string) => {
    const b = bytes(s);
    parts.push((b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255);
    parts.push(...b);
  };
  str("diffie-hellman-group1-sha1");     // nothing we offer
  for (let i = 0; i < 9; i++) str(i < 3 ? "none" : "");
  parts.push(0, 0, 0, 0, 0);
  const payload = new Uint8Array(parts);
  if (mod.sshNegotiate(payload, 0).length !== 0) {
    throw new Error("a key exchange was negotiated with no algorithm in common");
  }
});

// The key derivation of RFC 4253 §7.2, against a transcription of the RFC using WebCrypto.
//
// Written out separately rather than round-tripped, because the interesting rule only appears for
// keys longer than one hash: the extension hashes **everything produced so far**, not just the
// previous block. Hashing only the previous block gives the right first 32 bytes and wrong ones
// after, and the only key we need that is longer than a hash is chacha20-poly1305's 64 bytes — so
// nothing else in the protocol would catch it.
Deno.test("key derivation extends by hashing the accumulated output", async () => {
  // `Uint8Array<ArrayBuffer>` rather than the default `ArrayBufferLike`: WebCrypto's
  // `BufferSource` excludes a SharedArrayBuffer-backed view, and `cat` below always
  // allocates a plain one.
  const sha256 = async (b: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  /** The mpint form of K, which is what the RFC means by K here — not the raw bytes. */
  const mpint = (v: Uint8Array): Uint8Array<ArrayBuffer> => {
    let at = 0;
    while (at < v.length && v[at] === 0) at++;
    const body = v.slice(at);
    const pad = body.length > 0 && (body[0] & 0x80) !== 0;
    const n = body.length === 0 ? 0 : body.length + (pad ? 1 : 0);
    const head = new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    return body.length === 0 ? head : cat(head, pad ? new Uint8Array([0]) : new Uint8Array(0), body);
  };

  async function reference(k: Uint8Array, h: Uint8Array, sid: Uint8Array, letter: number, needed: number) {
    const base = cat(mpint(k), h);
    let out = await sha256(cat(base, new Uint8Array([letter]), sid));
    while (out.length < needed) out = cat(out, await sha256(cat(base, out)));
    return out.slice(0, needed);
  }

  // Shared secrets chosen to exercise the mpint rules: a plain one, one with the top bit set so a
  // zero byte is prepended, and one with leading zeroes to strip.
  const secrets = [
    Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0xff : i)),
    Uint8Array.from({ length: 32 }, (_, i) => (i < 2 ? 0 : i)),
  ];
  const h = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 255);
  const sid = Uint8Array.from({ length: 32 }, (_, i) => (i * 11) & 255);

  for (const k of secrets) {
    for (const letter of [0x41, 0x43, 0x46]) {                 // 'A', 'C', 'F'
      for (const needed of [1, 16, 32, 33, 64, 100]) {
        const got = mod.sshDeriveKey(k, h, sid, letter, needed);
        const want = await reference(k, h, sid, letter, needed);
        if (got.length !== needed) throw new Error(`asked ${needed}, got ${got.length}`);
        if (hex(got) !== hex(want)) {
          throw new Error(`derive(letter ${letter}, ${needed} bytes):\n  got  ${hex(got)}\n  want ${hex(want)}`);
        }
      }
    }
  }
});

Deno.test("a host key blob that names the wrong algorithm is refused", () => {
  // A well-formed Ed25519 key and signature, relabelled. The bytes are all the right lengths, so
  // only the name check stands between this and being handed to Ed25519 verification.
  const str = (b: Uint8Array) => {
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length);
    out.set(b, 4);
    return out;
  };
  const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  const pub = new Uint8Array(32).fill(2);
  const sig = new Uint8Array(64).fill(3);
  const h = new Uint8Array(32).fill(4);

  const goodKey = cat(str(bytes("ssh-ed25519")), str(pub));
  const goodSig = cat(str(bytes("ssh-ed25519")), str(sig));
  // Not asserting this verifies — the bytes are made up. Only that the name checks reject.
  if (mod.sshVerifyHostKey(cat(str(bytes("ssh-rsa")), str(pub)), goodSig, h)) {
    throw new Error("a host key naming ssh-rsa was accepted as Ed25519");
  }
  if (mod.sshVerifyHostKey(goodKey, cat(str(bytes("ssh-rsa")), str(sig)), h)) {
    throw new Error("a signature naming ssh-rsa was accepted as Ed25519");
  }
  // Right names, wrong sizes.
  if (mod.sshVerifyHostKey(cat(str(bytes("ssh-ed25519")), str(new Uint8Array(31))), goodSig, h)) {
    throw new Error("a 31-byte public key was accepted");
  }
  if (mod.sshVerifyHostKey(goodKey, cat(str(bytes("ssh-ed25519")), str(new Uint8Array(63))), h)) {
    throw new Error("a 63-byte signature was accepted");
  }
  if (mod.sshVerifyHostKey(new Uint8Array(0), goodSig, h)) throw new Error("an empty host key was accepted");
});

Deno.test("a low-order peer point is rejected rather than shared", () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  // The all-zero point: X25519 with it yields an all-zero secret, which every session would
  // share. RFC 8731 §3 requires aborting, and nothing later in the protocol notices.
  if (mod.sshSharedSecret(secret, new Uint8Array(32)).length !== 0) {
    throw new Error("the all-zero point produced a shared secret");
  }
  // A point of order 8, likewise.
  const orderEight = new Uint8Array(32);
  orderEight[0] = 1;
  const got = mod.sshSharedSecret(secret, orderEight);
  if (got.length !== 0) throw new Error("a low-order point produced a shared secret");
  // A real peer key does work, so the check is not simply refusing everything.
  const peer = mod.sshEphemeralPublic(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
  if (mod.sshSharedSecret(secret, peer).length !== 32) throw new Error("a valid point was rejected");
});

// The cipher, on its own. The interop test above is what says it is *right*; these pin the
// properties that a wrong-but-self-consistent implementation would still satisfy, so that a
// future change cannot quietly break interop while still round-tripping with itself.
Deno.test("sealing and opening round-trips, and the padding rule is the AEAD one", () => {
  const key = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 1) & 255);
  const block = 8;
  for (const n of [0, 1, 5, 6, 7, 8, 9, 100, 1000]) {
    // The AEAD rule excludes the 4-byte length from the alignment, unlike RFC 4253's.
    const pad = mod.sshAeadPaddingFor(n, block);
    if (pad < 4) throw new Error(`payload ${n}: padding ${pad} is under the minimum`);
    if ((1 + n + pad) % block !== 0) {
      throw new Error(`payload ${n}: (1 + ${n} + ${pad}) is not a multiple of ${block}`);
    }
    // And it is *not* the RFC rule — those differ by exactly 4 for every length, so a test that
    // only checked "some multiple" would pass with either.
    if ((4 + 1 + n + pad) % block === 0) {
      throw new Error(`payload ${n}: padding also satisfies the non-AEAD rule, so it is ambiguous`);
    }

    const payload = Uint8Array.from({ length: n }, (_, i) => (i * 31) & 255);
    const random = crypto.getRandomValues(new Uint8Array(pad));
    const packet = mod.sshSeal(key, 7, payload, random, block);
    if (packet.length !== 4 + 1 + n + pad + mod.sshCipherTagLength()) {
      throw new Error(`payload ${n}: packet is ${packet.length} bytes`);
    }
    if (mod.sshPeekLength(key, 7, packet, 0) !== 1 + n + pad) {
      throw new Error(`payload ${n}: peeked length is wrong`);
    }
    if (mod.sshOpenStatus(key, 7, packet, 0, packet.length, 35000) !== 0) {
      throw new Error(`payload ${n}: did not open`);
    }
    if (hex(mod.sshOpenPayload(key, 7, packet, 0, packet.length, 35000)) !== hex(payload)) {
      throw new Error(`payload ${n}: contents changed`);
    }
    if (mod.sshOpenUsed(key, 7, packet, 0, packet.length, 35000) !== packet.length) {
      throw new Error(`payload ${n}: used is wrong`);
    }
    // One byte short is "read more", never a verdict.
    if (mod.sshOpenStatus(key, 7, packet, 0, packet.length - 1, 35000) !== 1) {
      throw new Error(`payload ${n}: a short packet was not incomplete`);
    }
  }
});

Deno.test("a packet does not open under the wrong sequence number", () => {
  const key = Uint8Array.from({ length: 64 }, (_, i) => (i * 5) & 255);
  const payload = bytes("the sequence number is the nonce, and it is never transmitted");
  const random = crypto.getRandomValues(new Uint8Array(mod.sshAeadPaddingFor(payload.length, 8)));
  const packet = mod.sshSeal(key, 42, payload, random, 8);

  if (mod.sshOpenStatus(key, 42, packet, 0, packet.length, 35000) !== 0) {
    throw new Error("the packet did not open under its own sequence number");
  }
  for (const seq of [0, 41, 43, 43 + 65536]) {
    if (mod.sshOpenStatus(key, seq, packet, 0, packet.length, 35000) !== 2) {
      throw new Error(`a packet sealed at 42 opened at ${seq} — the nonce is not the sequence number`);
    }
  }
});

Deno.test("any single flipped bit is caught, wherever it lands", () => {
  const key = Uint8Array.from({ length: 64 }, (_, i) => (i * 3 + 9) & 255);
  const payload = bytes("sixteen bytes ok");
  const random = crypto.getRandomValues(new Uint8Array(mod.sshAeadPaddingFor(payload.length, 8)));
  const packet = mod.sshSeal(key, 3, payload, random, 8);

  // Every byte: the encrypted length, the encrypted body, and the tag. A corrupted length may be
  // rejected as out of range rather than by the MAC, which is also a refusal.
  for (let i = 0; i < packet.length; i++) {
    const bad = new Uint8Array(packet);
    bad[i] ^= 0x40;
    if (mod.sshOpenStatus(key, 3, bad, 0, bad.length, 35000) === 0) {
      throw new Error(`flipping a bit in byte ${i} of ${packet.length} still opened`);
    }
  }

  // And the wrong key.
  const other = new Uint8Array(key);
  other[0] ^= 1;
  if (mod.sshOpenStatus(other, 3, packet, 0, packet.length, 35000) === 0) {
    throw new Error("a packet opened under the wrong key");
  }
});

Deno.test("the two key halves are not interchangeable", () => {
  // K_2 is the first half and K_1 the second. Swapping them is the single most likely mistake,
  // and it round-trips perfectly against itself — only a real server notices. So it is asserted
  // here directly: a packet sealed with the halves swapped must not open with them in order.
  const key = Uint8Array.from({ length: 64 }, (_, i) => (i * 11 + 4) & 255);
  const swapped = new Uint8Array(64);
  swapped.set(key.slice(32), 0);
  swapped.set(key.slice(0, 32), 32);

  const payload = bytes("halves");
  const random = crypto.getRandomValues(new Uint8Array(mod.sshAeadPaddingFor(payload.length, 8)));
  const packet = mod.sshSeal(swapped, 1, payload, random, 8);
  if (mod.sshOpenStatus(key, 1, packet, 0, packet.length, 35000) === 0) {
    throw new Error("a packet sealed with swapped key halves opened with them in order");
  }
});

Deno.test("an unauthenticated length is bounded before it is believed", () => {
  const key = Uint8Array.from({ length: 64 }, (_, i) => i & 255);
  const payload = bytes("x");
  const random = crypto.getRandomValues(new Uint8Array(mod.sshAeadPaddingFor(1, 8)));
  const packet = mod.sshSeal(key, 0, payload, random, 8);

  // The length is decrypted before the MAC can be checked — the MAC covers bytes not yet read —
  // so a peer can steer it. It must be rejected on range, not used to size an allocation.
  // This packet's inner length is 8 — a 1-byte payload plus the padding-length byte and 6 of
  // padding — so the limits here are below that, not at it. A limit equal to the length must
  // accept, which is checked separately below.
  for (const max of [5, 7]) {
    if (mod.sshOpenStatus(key, 0, packet, 0, packet.length, max) !== 2) {
      throw new Error(`a packet longer than the ${max}-byte limit was accepted`);
    }
  }
  if (mod.sshOpenStatus(key, 0, packet, 0, packet.length, 8) !== 0) {
    throw new Error("a packet exactly at the limit was refused; the bound is off by one");
  }
  // Its own limit still works, so the bound is not simply refusing everything.
  if (mod.sshOpenStatus(key, 0, packet, 0, packet.length, 35000) !== 0) {
    throw new Error("a packet inside the limit was refused");
  }
});

// A regression anchor, not an independent vector: these bytes came from this implementation after
// the interop test above established it agrees with OpenSSH. On its own it only says we still do
// what we did before.
Deno.test("the cipher is pinned to a fixed answer", () => {
  const key = Uint8Array.from({ length: 64 }, (_, i) => i & 255);
  const packet = mod.sshSeal(key, 1, bytes("hello"), new Uint8Array(10).fill(0xaa), 8);
  // 36 bytes: 4 encrypted length, 16 of body (1 padding-length + 5 payload + 10 padding, since
  // the minimum of 4 forces a whole extra block here), and a 16-byte tag.
  const want = "c922a7b5633419b55d6512d087dbd48519bebdb8b96aaad3ff47411634076af21570d9a7";
  const got = hex(packet);
  if (packet.length !== 36) throw new Error(`packet is ${packet.length} bytes, expected 36`);
  if (got !== want) throw new Error(`cipher output changed:\n  got  ${got}\n  want ${want}`);
});

// Reading a private key, including an encrypted one — bcrypt_pbkdf and AES-CTR, in wac.
//
// The strong form of this test is that the *same* key is read from both an unencrypted and an
// encrypted file and must yield identical seeds. `ssh-keygen -p` changes only the passphrase, so
// the key material is unchanged by construction and any difference is ours.
Deno.test({
  name: "an OpenSSH private key reads, encrypted or not, and a wrong passphrase is caught",
  ignore: !haveSshd,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const gen = await new Deno.Command("ssh-keygen", {
        args: ["-t", "ed25519", "-f", `${dir}/k`, "-N", "", "-q", "-C", "test key"],
      }).output();
      if (!gen.success) throw new Error("ssh-keygen failed");

      const plainPem = await Deno.readFile(`${dir}/k`);
      const empty = new Uint8Array(0);
      if (mod.sshReadKeyStatus(plainPem, empty) !== 0) throw new Error("unencrypted key did not read");
      const seed = mod.sshReadKeySeed(plainPem, empty);
      const pub = mod.sshReadKeyPublic(plainPem, empty);
      if (seed.length !== 32) throw new Error("seed is not 32 bytes");

      // Same key, now encrypted. `-p` rewrites the file with a passphrase and nothing else.
      await Deno.copyFile(`${dir}/k`, `${dir}/enc`);
      const pass = "a passphrase with spaces";
      const rekey = await new Deno.Command("ssh-keygen", {
        args: ["-p", "-f", `${dir}/enc`, "-P", "", "-N", pass, "-q", "-a", "8"],
      }).output();
      if (!rekey.success) throw new Error(`ssh-keygen -p failed: ${text(rekey.stderr)}`);

      const encPem = await Deno.readFile(`${dir}/enc`);
      if (text(encPem).includes("aes256-ctr") === false && text(encPem) === text(plainPem)) {
        throw new Error("the key was not actually encrypted");
      }
      const status = mod.sshReadKeyStatus(encPem, bytes(pass));
      if (status !== 0) throw new Error(`encrypted key did not read: status ${status}`);
      if (hex(mod.sshReadKeySeed(encPem, bytes(pass))) !== hex(seed)) {
        throw new Error("the encrypted file yielded a different seed for the same key");
      }
      if (hex(mod.sshReadKeyPublic(encPem, bytes(pass))) !== hex(pub)) {
        throw new Error("the encrypted file yielded a different public blob");
      }

      // A wrong passphrase must be reported as such. There is no MAC over the private section, so
      // the doubled check word is the only thing that notices — and if it were skipped, the parse
      // would continue into random bytes.
      if (mod.sshReadKeyStatus(encPem, bytes("wrong")) !== 4) {
        throw new Error("a wrong passphrase was not reported as a bad passphrase");
      }
      if (mod.sshReadKeyStatus(encPem, empty) !== 4) {
        throw new Error("an empty passphrase against an encrypted key was not caught");
      }
      // And the right passphrase against an unencrypted key is simply ignored.
      if (mod.sshReadKeyStatus(plainPem, bytes(pass)) !== 0) {
        throw new Error("a passphrase broke reading an unencrypted key");
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("a file that is not an OpenSSH key is refused by shape, not misread", () => {
  const empty = new Uint8Array(0);
  const cases: [string, number][] = [
    ["", 1],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\n-----END OPENSSH PRIVATE KEY-----\n", 1],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n", 1],
    ["not base64 at all ~~~\n", 1],
  ];
  for (const [pem, want] of cases) {
    const got = mod.sshReadKeyStatus(bytes(pem), empty);
    if (got !== want) throw new Error(`${JSON.stringify(pem.slice(0, 30))}: status ${got}, want ${want}`);
  }
});

Deno.test("the signed data length-prefixes the session id", () => {
  // Omitting that length is a natural mistake and produces a signature the server rejects with no
  // explanation, so the layout is asserted directly rather than only through interop.
  const sessionId = Uint8Array.from({ length: 32 }, (_, i) => i);
  const user = bytes("alice");
  const pub = Uint8Array.from({ length: 51 }, (_, i) => i & 255);
  const signed = mod.sshSignedData(sessionId, user, pub);

  const dv = new DataView(signed.buffer, signed.byteOffset, signed.byteLength);
  if (dv.getUint32(0) !== 32) throw new Error("the session id is not length-prefixed");
  if (hex(signed.slice(4, 36)) !== hex(sessionId)) throw new Error("session id is not first");
  if (signed[36] !== 50) throw new Error("SSH_MSG_USERAUTH_REQUEST does not follow the session id");
  if (dv.getUint32(37) !== user.length) throw new Error("the user name is not next");

  // The signed data must be a prefix of the request itself, up to the signature field.
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 3) & 255);
  const request = mod.sshPublicKeyRequest(sessionId, user, pub, seed);
  const withoutSessionId = signed.slice(36);
  if (hex(request.slice(0, withoutSessionId.length)) !== hex(withoutSessionId)) {
    throw new Error("the request and the signed data disagree before the signature");
  }
  // …and the request carries a signature blob after it, naming its algorithm.
  const tail = request.slice(withoutSessionId.length);
  if (text(mod.sshReadString(tail.slice(4))) !== "ssh-ed25519") {
    throw new Error("the signature blob does not name ssh-ed25519");
  }
});

// known_hosts, against a file the real ssh client wrote.
//
// This is the only way to know the hashed form is right: `HashKnownHosts` is on by default, so a
// real entry is `|1|<salt>|<HMAC-SHA-1(salt, name)>` and there is nothing to compare against
// except a file OpenSSH produced. It also pins the `[host]:port` spelling, which is what gets
// hashed for a non-default port — get that wrong and every lookup silently reports "unknown".
Deno.test({
  name: "a known_hosts written by the real ssh client is read correctly",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const port = freePort();
    let sshd: Deno.ChildProcess | undefined;
    try {
      for (const name of ["hostkey", "clientkey"]) {
        const r = await new Deno.Command("ssh-keygen", {
          args: ["-t", "ed25519", "-f", `${dir}/${name}`, "-N", "", "-q"],
        }).output();
        if (!r.success) throw new Error(`ssh-keygen failed for ${name}`);
      }
      await Deno.chmod(`${dir}/hostkey`, 0o600);
      await Deno.chmod(`${dir}/clientkey`, 0o600);
      await Deno.copyFile(`${dir}/clientkey.pub`, `${dir}/authorized_keys`);
      await Deno.chmod(`${dir}/authorized_keys`, 0o600);
      await Deno.writeTextFile(`${dir}/sshd_config`, [
        `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${dir}/hostkey`,
        `AuthorizedKeysFile ${dir}/authorized_keys`,
        "StrictModes no", "UsePAM no", "PasswordAuthentication no", "PidFile none",
      ].join("\n"));

      sshd = new Deno.Command("/usr/sbin/sshd", {
        args: ["-D", "-f", `${dir}/sshd_config`], stdout: "null", stderr: "null",
      }).spawn();
      for (let i = 0; i < 100; i++) {
        try {
          const probe = await Deno.connect({ hostname: "127.0.0.1", port });
          probe.close();
          break;
        } catch {
          await new Promise(r => setTimeout(r, 50));
        }
      }

      // Let the real client connect — that is what writes the entry. Once with hashing and once
      // without, because `-F /dev/null` drops the system default and the two forms are parsed by
      // completely different code. Both are files OpenSSH actually produced.
      async function writeKnownHosts(hashed: boolean): Promise<Uint8Array> {
        const kh = `${dir}/known_hosts_${hashed ? "hashed" : "plain"}`;
        const run = await new Deno.Command("ssh", {
          args: ["-F", "/dev/null", "-i", `${dir}/clientkey`, "-p", String(port),
                 "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${kh}`,
                 "-o", `HashKnownHosts=${hashed ? "yes" : "no"}`,
                 "-o", "BatchMode=yes", "127.0.0.1", "true"],
        }).output();
        if (!run.success) throw new Error(`ssh failed: ${text(run.stderr)}`);
        return await Deno.readFile(kh);
      }

      const plainFile = await writeKnownHosts(false);
      const hashedFile = await writeKnownHosts(true);
      // Confirm each really is the form it claims, so a config change cannot quietly turn this
      // into the same test twice.
      if (text(plainFile).includes("|1|")) throw new Error("the plain file is hashed");
      if (!text(hashedFile).includes("|1|")) {
        throw new Error(`expected a hashed entry, got: ${text(hashedFile).slice(0, 120)}`);
      }
      // The plain form pins the `[host]:port` spelling that also gets hashed.
      if (!text(plainFile).startsWith(`[127.0.0.1]:${port} ssh-ed25519 `)) {
        throw new Error(`unexpected plain entry: ${text(plainFile).slice(0, 80)}`);
      }

      // The host key blob, as it appears in the exchange, taken from the .pub file.
      const pubB64 = (await Deno.readTextFile(`${dir}/hostkey.pub`)).split(" ")[1];
      const blob = Uint8Array.from(atob(pubB64), c => c.charCodeAt(0));
      const type = bytes("ssh-ed25519");
      const host = bytes("127.0.0.1");

      const changed = new Uint8Array(blob);
      changed[changed.length - 1] ^= 1;

      for (const [what, file] of [["plain", plainFile], ["hashed", hashedFile]] as const) {
        if (mod.sshKnownHost(file, host, port, type, blob) !== 1) {
          throw new Error(`${what}: the entry ssh just wrote was not recognised as a match`);
        }
        // One byte different is the case the file exists to catch, and must not read as unknown.
        if (mod.sshKnownHost(file, host, port, type, changed) !== 2) {
          throw new Error(`${what}: a changed host key was not reported as a mismatch`);
        }
        // The same key on another port is a different entry — the port is part of the name, and
        // for the hashed form that means it is inside the hash.
        if (mod.sshKnownHost(file, host, port + 1, type, blob) !== 0) {
          throw new Error(`${what}: a lookup on the wrong port matched`);
        }
        if (mod.sshKnownHost(file, bytes("example.com"), port, type, blob) !== 0) {
          throw new Error(`${what}: a lookup for another host matched`);
        }
        // A different algorithm says nothing about this key — a host may have several.
        if (mod.sshKnownHost(file, host, port, bytes("ssh-rsa"), blob) !== 0) {
          throw new Error(`${what}: an entry for another algorithm was treated as authoritative`);
        }
      }
    } finally {
      if (sshd !== undefined) {
        try { sshd.kill("SIGTERM"); } catch { /* already gone */ }
        await sshd.status;
      }
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("known_hosts plain entries: patterns, negation, markers and comments", () => {
  const type = bytes("ssh-ed25519");
  const blob = Uint8Array.from({ length: 51 }, (_, i) => (i * 3) & 255);
  const other = Uint8Array.from({ length: 51 }, (_, i) => (i * 5) & 255);
  const b64 = btoa(String.fromCharCode(...blob));
  const otherB64 = btoa(String.fromCharCode(...other));

  const check = (file: string, host: string, port = 22, key = blob, kt = type) =>
    mod.sshKnownHost(bytes(file), bytes(host), port, kt, key);

  // Exact, comments and blank lines.
  if (check(`# a comment\n\nexample.com ssh-ed25519 ${b64} me@here\n`, "example.com") !== 1) {
    throw new Error("a plain entry with a trailing comment did not match");
  }
  // Several names on one line.
  if (check(`a.example,b.example,c.example ssh-ed25519 ${b64}\n`, "b.example") !== 1) {
    throw new Error("a middle name in a list did not match");
  }
  // Patterns.
  if (check(`*.example ssh-ed25519 ${b64}\n`, "host.example") !== 1) throw new Error("* did not match");
  if (check(`*.example ssh-ed25519 ${b64}\n`, "example") !== 0) throw new Error("* matched too much");
  if (check(`h??t.example ssh-ed25519 ${b64}\n`, "host.example") !== 1) throw new Error("? did not match");
  if (check(`h??t.example ssh-ed25519 ${b64}\n`, "hoost.example") !== 0) throw new Error("? matched two");
  // A negation vetoes the whole entry even though the wildcard matches.
  if (check(`*.example,!bad.example ssh-ed25519 ${b64}\n`, "bad.example") !== 0) {
    throw new Error("a negation did not veto the entry");
  }
  if (check(`*.example,!bad.example ssh-ed25519 ${b64}\n`, "good.example") !== 1) {
    throw new Error("a negation vetoed an unrelated host");
  }
  // Known host, different key.
  if (check(`example.com ssh-ed25519 ${otherB64}\n`, "example.com") !== 2) {
    throw new Error("a different key was not a mismatch");
  }
  // A second line with the right key still matches, even after a wrong one.
  if (check(`example.com ssh-ed25519 ${otherB64}\nexample.com ssh-ed25519 ${b64}\n`, "example.com") !== 1) {
    throw new Error("a matching line after a non-matching one did not win");
  }
  // @revoked outranks everything, wherever it appears.
  if (check(`example.com ssh-ed25519 ${b64}\n@revoked example.com ssh-ed25519 ${b64}\n`, "example.com") !== 3) {
    throw new Error("a revocation did not outrank a match");
  }
  // @cert-authority describes a CA, not this host key: it must not be compared as one.
  if (check(`@cert-authority *.example ssh-ed25519 ${otherB64}\n`, "host.example") !== 0) {
    throw new Error("a cert-authority line was treated as a host key");
  }
  // A non-default port uses the bracketed form.
  if (check(`[example.com]:2222 ssh-ed25519 ${b64}\n`, "example.com", 2222) !== 1) {
    throw new Error("the bracketed port form did not match");
  }
  if (check(`example.com ssh-ed25519 ${b64}\n`, "example.com", 2222) !== 0) {
    throw new Error("a bare name matched a non-default port");
  }
  // Junk lines are ignored rather than fatal — a file may have entries we cannot read.
  if (check(`garbage\nexample.com ssh-ed25519 !!!not base64!!!\nexample.com ssh-ed25519 ${b64}\n`, "example.com") !== 1) {
    throw new Error("an unreadable line stopped a later valid one from matching");
  }
  if (check("", "example.com") !== 0) throw new Error("an empty file was not unknown");
});

// Running a command: open a session channel, exec, and read the output back.
//
// This is the end of the protocol — everything before it exists to make this possible. The output
// is deliberately many windows long, because flow control is the part that is invisible when it
// is wrong: a client that never sends WINDOW_ADJUST reads exactly one window and then hangs,
// having done nothing that any error reports.
Deno.test({
  name: "run a command on a real OpenSSH server and read its output",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    let s: Server | undefined;
    try {
      s = await startServer();
      const { send, next } = await handshake(s);

      // A small window on purpose, so the output is many windows long and the adjustment path is
      // exercised rather than merely present. Channel 7 rather than 0, so a client that echoed
      // its own number back instead of the server's would fail here.
      const OUR_CHANNEL = 7;
      const WINDOW = 8192;
      await send(mod.sshOpenSession(OUR_CHANNEL, WINDOW, mod.sshDefaultMaxPacket()));

      let serverChannel = -1;
      for (let i = 0; i < 8 && serverChannel < 0; i++) {
        const p = await next();
        const kind = mod.sshIncomingField(p, 0);
        if (kind === mod.sshMsgChannelOpenFailure()) {
          throw new Error(`channel open refused: ${text(mod.sshIncomingData(p))}`);
        }
        if (kind === mod.sshMsgChannelOpenConfirmation()) {
          if (mod.sshIncomingField(p, 1) !== OUR_CHANNEL) {
            throw new Error("the confirmation was addressed to another channel");
          }
          serverChannel = mod.sshIncomingField(p, 2);
        }
      }
      if (serverChannel < 0) throw new Error("no channel open confirmation");

      await send(mod.sshExecRequest(serverChannel, bytes("seq 1 100000; echo done >&2; exit 3"), true));

      const window = mod.sshWindowCreate(WINDOW);
      let stdout = "";
      let stderr = "";
      let exitStatus = -1;
      let closed = false;
      let adjustments = 0;

      for (let i = 0; i < 20000 && !closed; i++) {
        const p = await next();
        const kind = mod.sshIncomingField(p, 0);
        if (mod.sshIncomingField(p, 5) !== 1) throw new Error("a channel message did not parse");

        if (kind === mod.sshMsgChannelData() || kind === mod.sshMsgChannelExtendedData()) {
          const data = mod.sshIncomingData(p);
          if (kind === mod.sshMsgChannelData()) stdout += text(data);
          else if (mod.sshIncomingField(p, 4) === mod.sshExtendedDataStderr()) stderr += text(data);
          // Give the credit back, or the server stops sending after one window.
          const increment = mod.sshWindowConsume(window, data.length);
          if (increment > 0) {
            await send(mod.sshWindowAdjust(serverChannel, increment));
            adjustments++;
          }
        } else if (kind === mod.sshMsgChannelRequest()) {
          if (text(mod.sshIncomingData(p)) === "exit-status") {
            exitStatus = mod.sshIncomingField(p, 4);
          }
        } else if (kind === mod.sshMsgChannelClose()) {
          closed = true;
        }
      }

      if (!closed) throw new Error("the channel never closed");
      if (exitStatus !== 3) throw new Error(`exit status was ${exitStatus}, expected 3`);
      if (stderr.trim() !== "done") throw new Error(`stderr was ${JSON.stringify(stderr)}`);

      const lines = stdout.trimEnd().split("\n");
      if (lines.length !== 100000) throw new Error(`got ${lines.length} lines, expected 100000`);
      if (lines[0] !== "1" || lines[99999] !== "100000") {
        throw new Error(`output bounds wrong: ${lines[0]} … ${lines[99999]}`);
      }
      // The point of the large output: without window adjustments this would hang rather than
      // fail, so assert the path was actually taken.
      if (adjustments < 5) {
        throw new Error(`only ${adjustments} window adjustments for ${stdout.length} bytes`);
      }

      await send(mod.sshChannelClose(serverChannel));
    } finally {
      await stopServer(s);
    }
  },
});

Deno.test("the window returns credit before it runs out, not after", () => {
  const initial = 1000;
  const w = mod.sshWindowCreate(initial);
  if (mod.sshWindowLeft(w) !== initial) throw new Error("a new window is not full");

  // Above half, nothing is due: adjusting per packet would spend a packet per packet.
  if (mod.sshWindowConsume(w, 100) !== 0) throw new Error("adjusted too early");
  if (mod.sshWindowLeft(w) !== 900) throw new Error("consume did not reduce the window");
  if (mod.sshWindowConsume(w, 399) !== 0) throw new Error("adjusted at exactly half plus one");
  if (mod.sshWindowLeft(w) !== 501) throw new Error(`window is ${mod.sshWindowLeft(w)}`);

  // Crossing half returns exactly what was consumed, and refills.
  const increment = mod.sshWindowConsume(w, 1);
  if (increment !== 500) throw new Error(`increment was ${increment}, expected 500`);
  if (mod.sshWindowLeft(w) !== initial) throw new Error("the window was not refilled");

  // A single read larger than the whole window still returns the right credit — the server may
  // send up to its maximum packet size regardless of what we think is left.
  const w2 = mod.sshWindowCreate(initial);
  if (mod.sshWindowConsume(w2, 1500) !== 1500) throw new Error("an oversized read mis-credited");
  if (mod.sshWindowLeft(w2) !== initial) throw new Error("the window was not refilled after overrun");
});

Deno.test("channel messages parse to their fields", () => {
  const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const str = (b: Uint8Array) => { const o = new Uint8Array(4 + b.length); o.set(u32(b.length)); o.set(b, 4); return o; };
  const join = (...ps: Uint8Array[]) => {
    const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of ps) { o.set(p, at); at += p.length; }
    return o;
  };
  const field = (p: Uint8Array, i: number) => mod.sshIncomingField(p, i);

  // OPEN_CONFIRMATION: our number, then theirs. They need not agree, and the test uses different
  // values so a parser that read the wrong one would be caught.
  const conf = join(new Uint8Array([91]), u32(7), u32(42), u32(2097152), u32(32768));
  if (field(conf, 0) !== 91) throw new Error("kind wrong");
  if (field(conf, 1) !== 7) throw new Error("recipient channel wrong");
  if (field(conf, 2) !== 42) throw new Error("sender channel wrong");
  if (field(conf, 3) !== 2097152) throw new Error("window wrong");
  if (field(conf, 4) !== 32768) throw new Error("max packet wrong");

  const data = join(new Uint8Array([94]), u32(7), str(bytes("hello")));
  if (field(data, 0) !== 94 || text(mod.sshIncomingData(data)) !== "hello") {
    throw new Error("CHANNEL_DATA did not parse");
  }

  const ext = join(new Uint8Array([95]), u32(7), u32(1), str(bytes("oops")));
  if (field(ext, 4) !== 1 || text(mod.sshIncomingData(ext)) !== "oops") {
    throw new Error("EXTENDED_DATA did not parse");
  }

  const adjust = join(new Uint8Array([93]), u32(7), u32(4096));
  if (field(adjust, 3) !== 4096) throw new Error("WINDOW_ADJUST increment wrong");

  // exit-status carries a uint32 *after* the want_reply boolean, and is a request rather than a
  // reply — nothing prompts it.
  const exit = join(new Uint8Array([98]), u32(7), str(bytes("exit-status")), new Uint8Array([0]), u32(3));
  if (field(exit, 0) !== 98) throw new Error("request kind wrong");
  if (text(mod.sshIncomingData(exit)) !== "exit-status") throw new Error("request name wrong");
  if (field(exit, 4) !== 3) throw new Error(`exit status parsed as ${field(exit, 4)}`);

  // A request that is not exit-status has no trailing uint32 to read, and must not go looking.
  const other = join(new Uint8Array([98]), u32(7), str(bytes("keepalive@openssh.com")), new Uint8Array([1]));
  if (field(other, 5) !== 1) throw new Error("a request without a status did not parse");
  if (field(other, 4) !== 0) throw new Error("a status was invented");

  const failure = join(new Uint8Array([92]), u32(7), u32(4), str(bytes("no more sessions")), str(bytes("")));
  if (field(failure, 4) !== 4) throw new Error("open failure reason wrong");
  if (text(mod.sshIncomingData(failure)) !== "no more sessions") throw new Error("description wrong");

  // A transport message is not a channel message, and that is ordinary rather than an error.
  const transport = new Uint8Array([21]);
  if (field(transport, 0) !== 0) throw new Error("a transport message was taken for a channel one");
  if (field(transport, 5) !== 1) throw new Error("a transport message was reported as malformed");

  // Truncated messages are malformed, not silently zero-filled.
  for (const p of [
    new Uint8Array([]),
    new Uint8Array([91]),
    join(new Uint8Array([91]), u32(7)),
    join(new Uint8Array([94]), u32(7), new Uint8Array([0, 0, 0, 9, 1])),   // claims 9 bytes, has 1
    join(new Uint8Array([98]), u32(7), str(bytes("exit-status")), new Uint8Array([0])),  // no status
  ]) {
    if (field(p, 5) === 1 && field(p, 0) !== 0) {
      throw new Error(`a truncated message of ${p.length} bytes parsed as valid`);
    }
  }
});

Deno.test("channel messages address the recipient's channel number", () => {
  // Every channel message carries the number the *other* side chose. With one channel numbered
  // zero on both sides — the common case — getting this backwards works perfectly, so it is
  // asserted with a number that could only have come from the right place.
  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const open = mod.sshOpenSession(7, 8192, 32768);
  if (open[0] !== 90) throw new Error("not a CHANNEL_OPEN");
  // "session", then *our* number, since the server has not chosen one yet.
  if (text(mod.sshReadString(open.slice(1))) !== "session") throw new Error("channel type wrong");
  if (dv(open).getUint32(12) !== 7) throw new Error("open does not carry our channel number");
  if (dv(open).getUint32(16) !== 8192) throw new Error("open does not carry the window");

  for (const [name, msg] of [
    ["exec", mod.sshExecRequest(42, bytes("true"), true)],
    ["adjust", mod.sshWindowAdjust(42, 100)],
    ["eof", mod.sshChannelEof(42)],
    ["close", mod.sshChannelClose(42)],
    ["data", mod.sshChannelData(42, bytes("x"))],
  ] as const) {
    if (dv(msg).getUint32(1) !== 42) throw new Error(`${name} does not address the server's number`);
  }
});

Deno.test("authorized_keys: a key is found, and options are refused rather than ignored", () => {
  const blob = Uint8Array.from({ length: 51 }, (_, i) => (i * 3) & 255);
  const other = Uint8Array.from({ length: 51 }, (_, i) => (i * 5) & 255);
  const b64 = btoa(String.fromCharCode(...blob));
  const type = bytes("ssh-ed25519");
  const check = (file: string, key = blob) => mod.sshAuthorized(bytes(file), type, key);

  if (check(`ssh-ed25519 ${b64} me@here\n`) !== 1) throw new Error("a plain line did not match");
  if (check(`# comment\n\nssh-ed25519 ${b64}\n`) !== 1) throw new Error("comments broke the scan");
  if (check(`ssh-ed25519 ${b64}\n`, other) !== 0) throw new Error("a different key matched");
  if (check("") !== 0) throw new Error("an empty file matched");
  if (check(`ssh-rsa ${b64}\n`) !== 0) throw new Error("another algorithm matched");

  // Options are parsed and the line is refused, because a server that reads a restriction and
  // ignores it is worse than one that refuses: the operator wrote it expecting it to hold.
  if (check(`no-pty ssh-ed25519 ${b64}\n`) !== 2) throw new Error("an option was ignored");
  if (check(`restrict,pty ssh-ed25519 ${b64}\n`) !== 2) throw new Error("options were ignored");

  // `command="…"` contains spaces and commas. Splitting the options field on the first space
  // finds a key type where there is none, which reads as "this line is not for you" — so a
  // restricted key would slip through as *unknown* rather than as restricted.
  if (check(`command="echo hello world" ssh-ed25519 ${b64}\n`) !== 2) {
    throw new Error("a quoted option with spaces was mis-parsed");
  }
  if (check(`command="a,b c",no-pty ssh-ed25519 ${b64}\n`) !== 2) {
    throw new Error("a quoted option with a comma was mis-parsed");
  }
  if (check(`command="say \\"hi\\" now" ssh-ed25519 ${b64}\n`) !== 2) {
    throw new Error("an escaped quote inside an option was mis-parsed");
  }

  // An unrestricted line elsewhere in the file wins: the key is allowed outright.
  if (check(`no-pty ssh-ed25519 ${b64}\nssh-ed25519 ${b64}\n`) !== 1) {
    throw new Error("a plain line after a restricted one did not win");
  }
  // Junk is skipped rather than fatal.
  if (check(`garbage\nssh-ed25519 !!!\nssh-ed25519 ${b64}\n`) !== 1) {
    throw new Error("an unreadable line stopped a later valid one");
  }
});

Deno.test("the server's messages carry the fields a client reads", () => {
  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const point = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  // The host key blob: `string "ssh-ed25519"` then the point. 4 + 11 + 4 + 32.
  const blob = mod.sshHostKeyBlob(point);
  if (blob.length !== 51) throw new Error(`host key blob is ${blob.length} bytes`);
  if (text(mod.sshReadString(blob)) !== "ssh-ed25519") throw new Error("blob does not name its type");

  // OPEN_CONFIRMATION is the one message carrying both channel numbers, and they differ here so
  // reading the wrong one is visible.
  const conf = mod.sshOpenConfirmation(11, 22, 4096, 1024);
  if (conf[0] !== 91) throw new Error("not an open confirmation");
  if (dv(conf).getUint32(1) !== 11) throw new Error("the client's number is not the recipient");
  if (dv(conf).getUint32(5) !== 22) throw new Error("our number is not the sender");
  if (dv(conf).getUint32(9) !== 4096) throw new Error("window wrong");

  // exit-status is a request with want_reply false, then the code.
  const exit = mod.sshExitStatus(7, 42);
  if (exit[0] !== 98) throw new Error("exit status is not a channel request");
  if (dv(exit).getUint32(1) !== 7) throw new Error("exit status addresses the wrong channel");
  if (text(mod.sshReadString(exit.slice(5))) !== "exit-status") throw new Error("wrong request name");
  if (exit[20] !== 0) throw new Error("want_reply must be false — nothing answers it");
  if (dv(exit).getUint32(21) !== 42) throw new Error("the status is wrong");

  // PK_OK echoes the algorithm and blob back, which is what makes the client sign.
  const ok = mod.sshPkOk(bytes("ssh-ed25519"), blob);
  if (ok[0] !== 60) throw new Error("PK_OK has the wrong message number");
  if (text(mod.sshReadString(ok.slice(1))) !== "ssh-ed25519") throw new Error("PK_OK type wrong");

  // The exec command comes out of a CHANNEL_REQUEST, and only from an `exec` one.
  const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const str = (b: Uint8Array) => { const o = new Uint8Array(4 + b.length); o.set(u32(b.length)); o.set(b, 4); return o; };
  const join = (...ps: Uint8Array[]) => {
    const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of ps) { o.set(p, at); at += p.length; }
    return o;
  };
  const exec = join(new Uint8Array([98]), u32(0), str(bytes("exec")), new Uint8Array([1]), str(bytes("uname -a")));
  if (text(mod.sshExecCommand(exec)) !== "uname -a") throw new Error("the command did not parse");
  const pty = join(new Uint8Array([98]), u32(0), str(bytes("pty-req")), new Uint8Array([1]));
  if (mod.sshExecCommand(pty).length !== 0) throw new Error("a pty request was read as exec");

  // The server offers what it can do and nothing else — advertising more would have the client
  // choose it.
  if (text(mod.sshServerProposalField(1)) !== "ssh-ed25519") throw new Error("host key list wrong");
  if (!text(mod.sshServerProposalField(0)).includes("kex-strict-s-v00@openssh.com")) {
    throw new Error("the server does not offer its half of strict KEX");
  }
});

Deno.test("a userauth request is verified against bytes we rebuild, not the client's account", () => {
  const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const str = (b: Uint8Array) => { const o = new Uint8Array(4 + b.length); o.set(u32(b.length)); o.set(b, 4); return o; };
  const join = (...ps: Uint8Array[]) => {
    const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of ps) { o.set(p, at); at += p.length; }
    return o;
  };

  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 9 + 1) & 255);
  const sessionId = Uint8Array.from({ length: 32 }, (_, i) => (i * 13) & 255);
  const user = bytes("claude");
  const publicBlob = mod.sshHostKeyBlob(mod.sshEphemeralPublicForSeed(seed));

  // Build a genuine request with our own client code, then check the server accepts it.
  const request = mod.sshPublicKeyRequest(sessionId, user, publicBlob, seed);
  if (!mod.sshVerifyAuth(request, sessionId)) throw new Error("a valid request did not verify");

  // The same request under a different session id must not verify — that binding is the whole
  // reason a signature cannot be replayed to another server.
  const otherSession = new Uint8Array(sessionId);
  otherSession[0] ^= 1;
  if (mod.sshVerifyAuth(request, otherSession)) {
    throw new Error("a signature verified under a different session id");
  }

  // A probe carries no signature and must never be treated as authentication.
  const probe = join(new Uint8Array([50]), str(user), str(bytes("ssh-connection")),
                     str(bytes("publickey")), new Uint8Array([0]),
                     str(bytes("ssh-ed25519")), str(publicBlob));
  if (mod.sshAuthRequestField(probe, 0) !== 1) throw new Error("a probe did not parse");
  if (mod.sshAuthRequestField(probe, 1) !== 0) throw new Error("a probe claimed a signature");
  if (mod.sshVerifyAuth(probe, sessionId)) throw new Error("a probe was accepted as authentication");

  // Another method parses far enough to be named, so a server can say what it will not do.
  const password = join(new Uint8Array([50]), str(user), str(bytes("ssh-connection")),
                        str(bytes("password")), new Uint8Array([0]), str(bytes("hunter2")));
  if (mod.sshAuthRequestField(password, 0) !== 1) throw new Error("a password request did not parse");
  if (text(mod.sshAuthRequestMethod(password)) !== "password") throw new Error("method name lost");
  if (mod.sshVerifyAuth(password, sessionId)) throw new Error("a password request verified");
});

Deno.test("every message number is the one the RFC assigns", () => {
  // A function returning a constant has no oracle inside this package: `parse` reads a byte and
  // compares it against `msgChannelEof()`, so both move together if the number is wrong and every
  // test still passes. Mutation testing found exactly that — six of these could be replaced with
  // zero without reddening anything, including `msgIgnore`, `msgDebug` and `msgUnimplemented`,
  // which no test sends at all.
  //
  // So the oracle has to come from outside: RFC 4250 §4.1.2, with EXT_INFO from RFC 8308 §2.3 and
  // the ECDH pair from RFC 5656 §7.1. Written out rather than derived, because a table generated
  // from the same source it checks is the self-comparison this exists to escape.
  const want: [string, number][] = [
    ["SSH_MSG_DISCONNECT", 1],
    ["SSH_MSG_IGNORE", 2],
    ["SSH_MSG_UNIMPLEMENTED", 3],
    ["SSH_MSG_DEBUG", 4],
    ["SSH_MSG_SERVICE_REQUEST", 5],
    ["SSH_MSG_SERVICE_ACCEPT", 6],
    ["SSH_MSG_EXT_INFO", 7],
    ["SSH_MSG_KEXINIT", 20],
    ["SSH_MSG_NEWKEYS", 21],
    ["SSH_MSG_KEX_ECDH_INIT", 30],
    ["SSH_MSG_KEX_ECDH_REPLY", 31],
    ["SSH_MSG_USERAUTH_REQUEST", 50],
    ["SSH_MSG_USERAUTH_FAILURE", 51],
    ["SSH_MSG_USERAUTH_SUCCESS", 52],
    ["SSH_MSG_CHANNEL_OPEN", 90],
    ["SSH_MSG_CHANNEL_OPEN_CONFIRMATION", 91],
    ["SSH_MSG_CHANNEL_OPEN_FAILURE", 92],
    ["SSH_MSG_CHANNEL_WINDOW_ADJUST", 93],
    ["SSH_MSG_CHANNEL_DATA", 94],
    ["SSH_MSG_CHANNEL_EXTENDED_DATA", 95],
    ["SSH_MSG_CHANNEL_EOF", 96],
    ["SSH_MSG_CHANNEL_CLOSE", 97],
    ["SSH_MSG_CHANNEL_REQUEST", 98],
    ["SSH_MSG_CHANNEL_SUCCESS", 99],
    ["SSH_MSG_CHANNEL_FAILURE", 100],
  ];
  const got = Array.from(mod.sshMessageNumbers());
  if (got.length !== want.length) {
    throw new Error(`expected ${want.length} numbers, got ${got.length}`);
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i][1]) {
      throw new Error(`${want[i][0]}: expected ${want[i][1]}, got ${got[i]}`);
    }
  }
});

Deno.test("the refusal messages are laid out as the RFC says, byte for byte", () => {
  // `channelFailure`, `openFailure` and `disconnect` all survived mutation testing with their
  // bodies replaced, because a client only sees them when something has gone wrong and nothing in
  // the suite makes anything go wrong at this layer. They are pure functions over integers and
  // bytes, so the fix is not a harder integration test — it is to assert the bytes.
  //
  // Layouts: RFC 4254 §5.1 (CHANNEL_OPEN_FAILURE), §5.4 (CHANNEL_FAILURE) and RFC 4253 §11.1
  // (DISCONNECT). Note all three end with an empty language tag, which is a `string` and so four
  // zero bytes, not nothing — the field a hand-rolled encoder forgets.
  const enc = new TextEncoder();
  const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(" ");
  const check = (name: string, got: Uint8Array, want: string) => {
    if (hex(got) !== want) throw new Error(`${name}\n  got:  ${hex(got)}\n  want: ${want}`);
  };

  // byte 100, uint32 recipient channel. Nothing else — a CHANNEL_FAILURE carries no reason.
  check("channelFailure(7)", mod.sshServerChannelFailure(7), "64 00 00 00 07");

  // byte 1, uint32 reason, string description, string language tag.
  check(
    "disconnect(11, bye)",
    mod.sshServerDisconnect(11, enc.encode("bye")),
    "01 00 00 00 0b 00 00 00 03 62 79 65 00 00 00 00",
  );

  // byte 92, uint32 recipient channel, uint32 reason code, string description, string language.
  check(
    "openFailure(3, 4, no)",
    mod.sshServerOpenFailure(3, 4, enc.encode("no")),
    "5c 00 00 00 03 00 00 00 04 00 00 00 02 6e 6f 00 00 00 00",
  );

  // SSH_DISCONNECT_BY_APPLICATION, RFC 4253 §11.1. The one reason code this server sends.
  if (mod.sshByApplication() !== 11) {
    throw new Error(`byApplication: expected 11, got ${mod.sshByApplication()}`);
  }
});

Deno.test("a key whose two public halves disagree is refused, not carried out", async () => {
  // An OpenSSH private key states its public key *twice*: once in the outer envelope and again
  // inside the private section. Every other field here was validated and the outer blob was not,
  // so a file where the two disagree parsed cleanly — and `sshd.wac`'s `hostPublicPoint`, which
  // slices the last 32 bytes of that blob, then trapped on a short one. A crafted or corrupt host
  // key crashed the server at startup instead of being reported.
  //
  // Found by following a surviving `trap;` mutant rather than by reading the parser, which is the
  // argument for mutation testing in one line: the trap was flagged as untested, and the reason
  // it was untested is that nothing could reach it *through a valid file*.
  const dir = await Deno.makeTempDir({ prefix: "wac-badkey-" });
  try {
    const path = `${dir}/k`;
    await new Deno.Command("ssh-keygen", {
      args: ["-t", "ed25519", "-f", path, "-N", "", "-q"],
    }).output();
    const pem = await Deno.readTextFile(path);

    // Decode the base64 body, then rewrite the outer public-key string to something short. Every
    // field is length-prefixed, so shortening one keeps the rest parseable — which is exactly why
    // the file used to survive parsing.
    const b64 = pem.split("\n").filter((l) => !l.startsWith("-----")).join("");
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const view = new DataView(raw.buffer);
    let at = "openssh-key-v1\0".length;
    const skip = () => { const n = view.getUint32(at); at += 4 + n; };
    skip(); skip(); skip();          // ciphername, kdfname, kdfoptions
    at += 4;                          // keycount
    const pubAt = at;
    const pubLen = view.getUint32(pubAt);

    const short = new Uint8Array(4 + 8);
    new DataView(short.buffer).setUint32(0, 8);
    const mangled = new Uint8Array(raw.length - (4 + pubLen) + short.length);
    mangled.set(raw.subarray(0, pubAt), 0);
    mangled.set(short, pubAt);
    mangled.set(raw.subarray(pubAt + 4 + pubLen), pubAt + short.length);

    const body = btoa(String.fromCharCode(...mangled)).match(/.{1,70}/g)!.join("\n");
    const bad = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;

    // 3 is Malformed. Anything else means it was accepted, and an accepted one traps later.
    const got = mod.sshReadKeyStatus(bytes(bad), new Uint8Array(0));
    if (got !== 3) throw new Error(`a mangled public blob gave status ${got}, want 3 (malformed)`);

    // And the untouched key still reads, so the new check is not refusing everything.
    const good = mod.sshReadKeyStatus(bytes(pem), new Uint8Array(0));
    if (good !== 0) throw new Error(`the real key now gives status ${good}, want 0`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("a channel open is read for its number, whatever the number is", () => {
  // This survived mutation testing as `return 0`, and the reason is worth keeping: OpenSSH's
  // first channel *is* zero, so the only witness the suite had always agreed with the constant.
  // A parser whose every test supplies the same answer is not being tested.
  //
  // SSH_MSG_CHANNEL_OPEN, RFC 4254 §5.1: byte 90, string channel type, uint32 sender channel,
  // uint32 initial window, uint32 maximum packet size. Note the sender's number comes *after* the
  // type string, which is the one message where it is not immediately after the byte — reading it
  // at a fixed offset is the mistake this function exists to avoid.
  const open = (type: string, channel: number) => {
    const t = new TextEncoder().encode(type);
    const b = new Uint8Array(1 + 4 + t.length + 12);
    const v = new DataView(b.buffer);
    b[0] = 90;
    v.setUint32(1, t.length);
    b.set(t, 5);
    v.setUint32(5 + t.length, channel);
    v.setUint32(5 + t.length + 4, 2 * 1024 * 1024);
    v.setUint32(5 + t.length + 8, 32768);
    return b;
  };

  for (const n of [0, 1, 7, 258, 0x7fffffff]) {
    const got = mod.sshServerReadOpenChannel(open("session", n));
    if (got !== n) throw new Error(`session channel ${n}: read back ${got}`);
  }

  // Anything that is not a session is refused rather than served on a guessed channel.
  for (const bad of ["x11", "direct-tcpip", "", "sessionx", "sessio"]) {
    const got = mod.sshServerReadOpenChannel(open(bad, 3));
    if (got !== -1) throw new Error(`channel type ${JSON.stringify(bad)}: got ${got}, want -1`);
  }

  // Truncated so the *channel number itself* is incomplete. Cutting less than that is not a
  // truncation as far as this function is concerned: it needs `5 + typeLen + 4` bytes and reads
  // nothing beyond them, so lopping off the window and max-packet fields is legitimately fine.
  // My first version of this case cut two bytes and asserted -1, which failed for that reason —
  // the test was wrong, not the parser.
  const full = open("session", 5);
  if (mod.sshServerReadOpenChannel(full.subarray(0, 15)) !== -1) {
    throw new Error("an open with an incomplete channel number was read anyway");
  }
  if (mod.sshServerReadOpenChannel(full.subarray(0, 16)) !== 5) {
    throw new Error("an open carrying exactly the channel number was refused");
  }
  // A different message entirely.
  const notOpen = open("session", 5).slice();
  notOpen[0] = 98;
  if (mod.sshServerReadOpenChannel(notOpen) !== -1) {
    throw new Error("a CHANNEL_REQUEST was read as a CHANNEL_OPEN");
  }
});
