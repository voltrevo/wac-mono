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
  name: "version and KEXINIT exchange with a real OpenSSH server",
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
      await Deno.writeTextFile(`${dir}/sshd_config`, [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${dir}/hostkey`,
        "StrictModes no",
        "UsePAM no",
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
