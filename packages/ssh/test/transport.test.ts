// The SSH transport, against a real OpenSSH server.
//
// The unit tests below pin the wire types and the packet framing against their rules. This first
// one is the only test that can tell us the rules were read correctly: it runs `sshd`, performs
// the version exchange and the KEXINIT exchange with it, and negotiates. A server that dislikes
// anything about our framing closes the connection instead of answering, so reaching a parsed
// server KEXINIT means the packet layer is right in both directions.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/ssh/test/wac/probe.wac") as unknown as {
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
  sshServiceRequest(): Uint8Array;
  sshSignedData(sessionId: Uint8Array, user: Uint8Array, publicBlob: Uint8Array): Uint8Array;
  sshPublicKeyRequest(sessionId: Uint8Array, user: Uint8Array, publicBlob: Uint8Array, seed: Uint8Array): Uint8Array;
};

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b).map(v => v.toString(16).padStart(2, "0")).join("");

const haveSshd = await (async () => {
  try {
    return (await Deno.stat("/usr/sbin/sshd")).isFile;
  } catch {
    return false;
  }
})();

/** A port nothing is listening on. Racy in principle; the window is microseconds. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

Deno.test({
  name: "connect to a real OpenSSH server and authenticate with a public key",
  ignore: !haveSshd,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const port = freePort();
    let sshd: Deno.ChildProcess | undefined;
    let conn: Deno.TcpConn | undefined;
    try {
      const kg = await new Deno.Command("ssh-keygen", {
        args: ["-t", "ed25519", "-f", `${dir}/hostkey`, "-N", "", "-q"],
      }).output();
      if (!kg.success) throw new Error("ssh-keygen failed");
      await Deno.chmod(`${dir}/hostkey`, 0o600);
      // A client key too, and an sshd that accepts it. sshd runs as this user and so can only
      // authenticate this user, which is exactly what we want to attempt.
      const kg2 = await new Deno.Command("ssh-keygen", {
        args: ["-t", "ed25519", "-f", `${dir}/clientkey`, "-N", "", "-q"],
      }).output();
      if (!kg2.success) throw new Error("ssh-keygen failed for the client key");
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
      sshd = new Deno.Command("/usr/sbin/sshd", {
        args: ["-D", "-f", `${dir}/sshd_config`],
        stdout: "null",
        stderr: "null",
      }).spawn();

      // Wait for it to accept, rather than sleeping a guessed amount.
      for (let i = 0; i < 100 && conn === undefined; i++) {
        try {
          conn = await Deno.connect({ hostname: "127.0.0.1", port });
        } catch {
          await new Promise(r => setTimeout(r, 50));
        }
      }
      if (conn === undefined) throw new Error(`sshd never accepted on ${port}`);

      let buf = new Uint8Array(0);
      const read = async () => {
        const chunk = new Uint8Array(16384);
        const n = await conn!.read(chunk);
        if (n === null) throw new Error("server closed the connection");
        const next = new Uint8Array(buf.length + n);
        next.set(buf);
        next.set(chunk.subarray(0, n), buf.length);
        buf = next;
      };

      // Our version line goes first; SSH does not wait for the peer's.
      await conn.write(mod.sshClientVersionLine());

      while (mod.sshScanStatus(buf) === 1) await read();
      if (mod.sshScanStatus(buf) !== 0) throw new Error("server version line was rejected");
      const serverVersion = mod.sshScanLine(buf);
      if (!mod.sshSpeaksV2(serverVersion)) {
        throw new Error(`server is not SSH-2.0: ${text(serverVersion)}`);
      }
      if (!text(serverVersion).startsWith("SSH-2.0-OpenSSH")) {
        throw new Error(`expected an OpenSSH server, got ${text(serverVersion)}`);
      }
      buf = buf.slice(mod.sshScanUsed(buf));

      // KEXINIT, framed as a binary packet. Both sides send without waiting.
      const cookie = crypto.getRandomValues(new Uint8Array(16));
      const ourKexInit = mod.sshKexInit(cookie);
      const block = mod.sshMinBlock();
      const padding = crypto.getRandomValues(new Uint8Array(mod.sshPaddingFor(ourKexInit.length, block)));
      await conn.write(mod.sshFrame(ourKexInit, padding, block));

      while (mod.sshUnframeStatus(buf) === 1) await read();
      if (mod.sshUnframeStatus(buf) !== 0) throw new Error("could not frame the server's first packet");
      const payload = mod.sshUnframePayload(buf);
      if (payload[0] !== 20) throw new Error(`expected SSH_MSG_KEXINIT (20), got ${payload[0]}`);
      if (!mod.sshProposalOk(payload)) throw new Error("server KEXINIT did not parse");

      // The server must offer what we picked, and our choice must be our own first preference
      // that it supports — client order decides.
      const kex = text(mod.sshNegotiate(payload, 0));
      const hostKey = text(mod.sshNegotiate(payload, 1));
      const cipherOut = text(mod.sshNegotiate(payload, 2));
      const cipherIn = text(mod.sshNegotiate(payload, 3));
      if (kex !== "curve25519-sha256") throw new Error(`kex negotiated as ${kex}`);
      if (hostKey !== "ssh-ed25519") throw new Error(`host key negotiated as ${hostKey}`);
      if (cipherOut !== "chacha20-poly1305@openssh.com") throw new Error(`c2s cipher: ${cipherOut}`);
      if (cipherIn !== "chacha20-poly1305@openssh.com") throw new Error(`s2c cipher: ${cipherIn}`);

      // Sanity that we parsed the server's lists rather than our own: OpenSSH offers several
      // key exchanges, and a single-entry list here would mean we read back what we sent.
      const theirKex = text(mod.sshProposalField(payload, 0));
      if (!theirKex.includes(",")) throw new Error(`server kex list looks wrong: ${theirKex}`);
      if (!theirKex.includes("curve25519-sha256")) throw new Error("server does not offer curve25519");
      buf = buf.slice(mod.sshUnframeUsed(buf));

      // ── Key exchange ────────────────────────────────────────────────────────
      //
      // The signature check at the end is the whole point: it can only pass if every input to the
      // exchange hash matches what the server used — both version strings, both KEXINIT payloads
      // byte for byte, the host key, both ephemeral keys, and the shared secret in its mpint form.
      // One wrong byte anywhere and Ed25519 verification fails.
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const qc = mod.sshEphemeralPublic(secret);
      const initPayload = mod.sshEcdhInit(qc);
      const initPad = crypto.getRandomValues(new Uint8Array(mod.sshPaddingFor(initPayload.length, block)));
      await conn.write(mod.sshFrame(initPayload, initPad, block));

      while (mod.sshUnframeStatus(buf) === 1) await read();
      if (mod.sshUnframeStatus(buf) !== 0) throw new Error("could not frame the ECDH reply");
      const reply = mod.sshUnframePayload(buf);
      if (reply[0] !== 31) {
        throw new Error(`expected SSH_MSG_KEX_ECDH_REPLY (31), got ${reply[0]}`);
      }
      if (!mod.sshEcdhReplyOk(reply)) throw new Error("ECDH reply did not parse");

      const hostKeyBlob = mod.sshEcdhReplyField(reply, 0);
      const qs = mod.sshEcdhReplyField(reply, 1);
      const signature = mod.sshEcdhReplyField(reply, 2);

      const shared = mod.sshSharedSecret(secret, qs);
      if (shared.length === 0) throw new Error("shared secret was rejected as low-order");

      const h = mod.sshExchangeHash(
        mod.sshClientVersion(), serverVersion, ourKexInit, payload,
        hostKeyBlob, qc, qs, shared);
      if (h.length !== 32) throw new Error("exchange hash is not 32 bytes");

      if (!mod.sshVerifyHostKey(hostKeyBlob, signature, h)) {
        throw new Error("the server's host key signature did not verify over our exchange hash");
      }

      // Independently: the key the server presented is the one we generated for it. Without this,
      // a signature that verifies only proves self-consistency — we would accept any host.
      const pubLine = await Deno.readTextFile(`${dir}/hostkey.pub`);
      const wantBlob = pubLine.split(" ")[1];
      const gotBlob = btoa(String.fromCharCode(...hostKeyBlob));
      if (gotBlob !== wantBlob) throw new Error("host key blob is not the one in hostkey.pub");

      // Tampering with H must break the signature — otherwise the check above proves nothing.
      const bent = new Uint8Array(h);
      bent[0] ^= 1;
      if (mod.sshVerifyHostKey(hostKeyBlob, signature, bent)) {
        throw new Error("a signature verified over the wrong exchange hash");
      }
      buf = buf.slice(mod.sshUnframeUsed(buf));

      // ── NEWKEYS, and everything after it is encrypted ───────────────────────
      //
      // Both sides advertised strict KEX, so the sequence numbers reset to zero at NEWKEYS rather
      // than continuing. Getting that wrong fails the MAC on the very first encrypted packet with
      // no indication of why, which is the whole reason it is asserted rather than assumed.
      if (!theirKex.includes("kex-strict-s-v00@openssh.com")) {
        throw new Error("server did not offer strict KEX, so the sequence numbers do not reset");
      }

      const newKeys = new Uint8Array([21]);
      const nkPad = crypto.getRandomValues(new Uint8Array(mod.sshPaddingFor(1, block)));
      await conn.write(mod.sshFrame(newKeys, nkPad, block));

      while (mod.sshUnframeStatus(buf) === 1) await read();
      if (mod.sshUnframeStatus(buf) !== 0) throw new Error("could not frame the server's NEWKEYS");
      const nk = mod.sshUnframePayload(buf);
      if (nk[0] !== 21) throw new Error(`expected SSH_MSG_NEWKEYS (21), got ${nk[0]}`);
      buf = buf.slice(mod.sshUnframeUsed(buf));

      // session_id is H from the first exchange. 'C' is client-to-server, 'D' the other way.
      const keyOut = mod.sshDeriveKey(shared, h, h, 0x43, mod.sshCipherKeyLength());
      const keyIn = mod.sshDeriveKey(shared, h, h, 0x44, mod.sshCipherKeyLength());

      // Send an encrypted SERVICE_REQUEST for ssh-userauth. If our sealing is wrong in any way —
      // key halves swapped, wrong counter, wrong padding rule, wrong sequence number — the server
      // drops the connection instead of replying.
      const serviceRequest = (() => {
        const name = bytes("ssh-userauth");
        const out = new Uint8Array(1 + 4 + name.length);
        out[0] = 5;                                    // SSH_MSG_SERVICE_REQUEST
        new DataView(out.buffer).setUint32(1, name.length);
        out.set(name, 5);
        return out;
      })();
      const srPad = crypto.getRandomValues(
        new Uint8Array(mod.sshAeadPaddingFor(serviceRequest.length, block)));
      await conn.write(mod.sshSeal(keyOut, 0, serviceRequest, srPad, block));

      // Read encrypted packets until SERVICE_ACCEPT. OpenSSH sends EXT_INFO first, because we
      // asked for it with ext-info-c.
      const MAX = 35000;
      let inSeq = 0;
      let accepted = false;
      let sawExtInfo = false;
      for (let i = 0; i < 8 && !accepted; i++) {
        while (mod.sshOpenStatus(keyIn, inSeq, buf, 0, buf.length, MAX) === 1) await read();
        const status = mod.sshOpenStatus(keyIn, inSeq, buf, 0, buf.length, MAX);
        if (status !== 0) {
          throw new Error(`encrypted packet ${inSeq} did not open (status ${status}) — ` +
            `the cipher, the key halves or the sequence number is wrong`);
        }
        const p = mod.sshOpenPayload(keyIn, inSeq, buf, 0, buf.length, MAX);
        buf = buf.slice(mod.sshOpenUsed(keyIn, inSeq, buf, 0, buf.length, MAX));
        inSeq++;
        if (p[0] === 7) sawExtInfo = true;                      // SSH_MSG_EXT_INFO
        if (p[0] === mod.sshMsgServiceAccept()) {
          const name = text(mod.sshReadString(p.slice(1)));
          if (name !== "ssh-userauth") throw new Error(`service accepted was ${name}`);
          accepted = true;
        }
      }
      if (!accepted) throw new Error("never received SSH_MSG_SERVICE_ACCEPT");
      if (!sawExtInfo) {
        throw new Error("no EXT_INFO, though we advertised ext-info-c — decryption may be wrong");
      }

      // ── Authenticate ────────────────────────────────────────────────────────
      //
      // The private key is read by our own wac code, straight out of the file ssh-keygen wrote.
      const pem = await Deno.readFile(`${dir}/clientkey`);
      const empty = new Uint8Array(0);
      if (mod.sshReadKeyStatus(pem, empty) !== 0) {
        throw new Error(`could not read the private key: status ${mod.sshReadKeyStatus(pem, empty)}`);
      }
      const seed = mod.sshReadKeySeed(pem, empty);
      const publicBlob = mod.sshReadKeyPublic(pem, empty);
      if (seed.length !== 32) throw new Error("seed is not 32 bytes");

      // The blob we parsed must be the one in the .pub file, or we would be offering a key the
      // server has never heard of and reading its refusal as our own bug.
      const wantPub = (await Deno.readTextFile(`${dir}/clientkey.pub`)).split(" ")[1];
      if (btoa(String.fromCharCode(...publicBlob)) !== wantPub) {
        throw new Error("the public blob from the private key does not match clientkey.pub");
      }

      // session_id is H from the first exchange. Signing over it is what stops a signature being
      // replayable to another server.
      const user = bytes(Deno.env.get("USER") ?? "claude");
      const authRequest = mod.sshPublicKeyRequest(h, user, publicBlob, seed);
      const arPad = crypto.getRandomValues(
        new Uint8Array(mod.sshAeadPaddingFor(authRequest.length, block)));
      await conn.write(mod.sshSeal(keyOut, 1, authRequest, arPad, block));

      let authed = false;
      for (let i = 0; i < 8 && !authed; i++) {
        while (mod.sshOpenStatus(keyIn, inSeq, buf, 0, buf.length, MAX) === 1) await read();
        if (mod.sshOpenStatus(keyIn, inSeq, buf, 0, buf.length, MAX) !== 0) {
          throw new Error(`packet ${inSeq} did not open while authenticating`);
        }
        const p = mod.sshOpenPayload(keyIn, inSeq, buf, 0, buf.length, MAX);
        buf = buf.slice(mod.sshOpenUsed(keyIn, inSeq, buf, 0, buf.length, MAX));
        inSeq++;
        if (p[0] === mod.sshMsgUserAuthFailure()) {
          throw new Error(`the server rejected our signature: ${text(mod.sshReadString(p.slice(1)))}`);
        }
        if (p[0] === mod.sshMsgUserAuthSuccess()) authed = true;
      }
      if (!authed) throw new Error("never received SSH_MSG_USERAUTH_SUCCESS");
    } finally {
      try { conn?.close(); } catch { /* already gone */ }
      if (sshd !== undefined) {
        try { sshd.kill("SIGTERM"); } catch { /* already gone */ }
        await sshd.status;
      }
      await Deno.remove(dir, { recursive: true });
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
