// The TLS 1.3 client.
//
// A client is only as good as what it refuses. Connecting successfully proves the happy
// path; it says nothing about whether the certificate was checked, and a client that
// accepts every certificate connects successfully to everything — including to an
// attacker. So the interesting tests here are the rejections, and each one is paired
// with the connection that must still succeed, because a client that refuses everything
// passes every rejection test.
//
// Against OpenSSL's `s_server` for the interop direction, and against this repo's own
// server for the round trip, which exercises both halves of the implementation at once
// and would hide a shared misreading of the spec — hence the OpenSSL case.

import {
  close, failure, feed, init, p256Scalar, pemBundle, phase, pemToDer, request,
  send, singleRoot, unpack,
} from "../host/connect.ts";
import {
  feed as srvFeed, newConnection, recordNeeded, send as srvSend, tlsClose, unpack as srvUnpack,
} from "../host/serve.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const caPem = await Deno.readTextFile(new URL("./data/ca.pem", import.meta.url));
const caDer = pemToDer(caPem);
const BODY = "hello from the wac server\n";
const REPLY = `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n` +
  `content-length: ${BODY.length}\r\nconnection: close\r\n\r\n${BODY}`;

/** Our server, on an ephemeral port, for one connection. */
function serveOnce(): { port: number; done: Promise<void>; } {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const done = (async () => {
    try {
      const conn = await listener.accept();
      let state = newConnection();
      let buf = new Uint8Array(0);
      const chunk = new Uint8Array(16640);
      try {
        while (true) {
          const n = await conn.read(chunk);
          if (n === null) break;
          const merged = new Uint8Array(buf.length + n);
          merged.set(buf);
          merged.set(chunk.subarray(0, n), buf.length);
          buf = merged;
          let consumed = 0;
          while (buf.length - consumed >= 5 && recordNeeded(buf.subarray(consumed)) === 0) {
            consumed += 5 + ((buf[consumed + 3] << 8) | buf[consumed + 4]);
          }
          if (consumed === 0) continue;
          const ready = buf.slice(0, consumed);
          buf = buf.slice(consumed);
          const r = srvUnpack(srvFeed(state, ready));
          state = r.state;
          if (r.toSend.length > 0) await conn.write(r.toSend);
          if (r.appData.length > 0) {
            const s = srvUnpack(srvSend(state, enc.encode(REPLY)));
            state = s.state;
            await conn.write(s.toSend);
            const c = srvUnpack(tlsClose(state));
            if (c.toSend.length > 0) await conn.write(c.toSend);
            break;
          }
        }
      } finally {
        try { conn.close(); } catch { /* already closed */ }
      }
    } catch { /* the client gave up, which some of these tests intend */ }
    try { listener.close(); } catch { /* already closed */ }
  })();
  return { port, done };
}

Deno.test("client: talks to the wac server, end to end", async () => {
  const server = serveOnce();
  const r = await request("127.0.0.1", server.port, "wac.test", caDer,
    "GET / HTTP/1.1\r\nHost: wac.test\r\n\r\n");
  await server.done;
  if (r.failure !== 0) throw new Error(`handshake failed with code ${r.failure}`);
  if (!r.response.includes("HTTP/1.1 200 OK") || !r.response.includes(BODY.trim())) {
    throw new Error(`unexpected response: ${JSON.stringify(r.response)}`);
  }
});

Deno.test("client: talks to OpenSSL's s_server", async () => {
  // The round trip above would pass even if both halves misread the spec the same way.
  // OpenSSL cannot make that mistake with us.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();

  const certPath = new URL("./data/leaf.pem", import.meta.url).pathname;
  const keyPath = new URL("./data/leaf.key", import.meta.url).pathname;
  const proc = new Deno.Command("openssl", {
    args: ["s_server", "-accept", String(port), "-cert", certPath,
           "-key", keyPath, "-tls1_3", "-www", "-quiet"],
    stdout: "null", stderr: "null",
  }).spawn();
  // Give it a moment to bind.
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const r = await request("127.0.0.1", port, "wac.test", caDer,
      "GET / HTTP/1.1\r\nHost: wac.test\r\n\r\n");
    if (r.failure !== 0) throw new Error(`handshake with openssl failed, code ${r.failure}`);
    if (!r.response.includes("200 ok") && !r.response.includes("200 OK")) {
      throw new Error(`openssl did not answer: ${JSON.stringify(r.response.slice(0, 200))}`);
    }
  } finally {
    try { proc.kill(); } catch { /* already gone */ }
    await proc.status;
  }
});

Deno.test("client: refuses a certificate that does not cover the host asked for", async () => {
  // The classic failure. The certificate is genuine, in date, and signed by the CA we
  // trust — it is simply for a different name. A client that checks only the signature
  // accepts it, and an attacker who can get a certificate for any domain can then
  // impersonate every domain.
  const server = serveOnce();
  const r = await request("127.0.0.1", server.port, "not-our-name.test", caDer,
    "GET / HTTP/1.1\r\n\r\n");
  await server.done;
  if (r.failure === 0) throw new Error("accepted a certificate for the wrong host");
  // 40 + 7: verifyChain's "no matching name".
  if (r.failure !== 47) throw new Error(`expected the name check to fail, got code ${r.failure}`);
});

Deno.test("client: refuses a certificate from an issuer it does not trust", async () => {
  // The same server, and a root that did not sign its certificate. Nothing about the
  // certificate has changed; what changed is whether we have a reason to believe it.
  const otherCa = pemToDer(await Deno.readTextFile(new URL("./data/other_ca.pem", import.meta.url)));
  const server = serveOnce();
  const r = await request("127.0.0.1", server.port, "wac.test", otherCa,
    "GET / HTTP/1.1\r\n\r\n");
  await server.done;
  if (r.failure === 0) throw new Error("accepted a certificate from an untrusted issuer");
  // 45 is "issuer name does not match the root's subject", 46 is "signature does not
  // verify". Either is a correct refusal; which one depends on whether the names collide.
  if (r.failure !== 45 && r.failure !== 46) {
    throw new Error(`expected an issuer failure, got code ${r.failure}`);
  }
});

Deno.test("client: refuses when the certificate is outside its validity window", async () => {
  // Time is passed in rather than read, so this needs no clock trickery: ask the client
  // to evaluate the same handshake as though it were 1990.
  const server = serveOnce();
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: server.port });
  const longAgo = BigInt(Math.floor(new Date("1990-01-01T00:00:00Z").getTime() / 1000));
  let state: Uint8Array;
  {
    const store = singleRoot(caDer);
    const r = unpack(init(enc.encode("wac.test"), store.der, store.offsets,
      crypto.getRandomValues(new Uint8Array(32)), p256Scalar(),
      crypto.getRandomValues(new Uint8Array(64)),
      crypto.getRandomValues(new Uint8Array(32)), longAgo));
    state = r.state;
    await conn.write(r.toSend);
  }
  let buf = new Uint8Array(0);
  const chunk = new Uint8Array(16640);
  while (failure(state) === 0 && phase(state) < 3) {
    const n = await conn.read(chunk);
    if (n === null) break;
    const merged = new Uint8Array(buf.length + n);
    merged.set(buf);
    merged.set(chunk.subarray(0, n), buf.length);
    buf = merged;
    let consumed = 0;
    while (buf.length - consumed >= 5) {
      const need = 5 + ((buf[consumed + 3] << 8) | buf[consumed + 4]);
      if (buf.length - consumed < need) break;
      consumed += need;
    }
    if (consumed === 0) continue;
    const ready = buf.slice(0, consumed);
    buf = buf.slice(consumed);
    const r = unpack(feed(state, ready));
    state = r.state;
    if (r.toSend.length > 0) await conn.write(r.toSend);
  }
  try { conn.close(); } catch { /* already closed */ }
  await server.done;

  if (failure(state) === 0) throw new Error("accepted a certificate that was not yet valid");
  if (failure(state) !== 41) {
    throw new Error(`expected the notBefore check to fail, got code ${failure(state)}`);
  }
});

Deno.test("client: sends a ClientHello a real server understands", async () => {
  // Narrower than the interop tests and much faster to diagnose when it breaks: does the
  // very first flight parse at all? A malformed extension list fails the handshake with
  // no useful signal, and this at least says the failure is later than the hello.
  const seed = new Uint8Array(32);
  seed[31] = 7;
  const store = singleRoot(caDer);
  const r = unpack(init(enc.encode("wac.test"), store.der, store.offsets, seed, seed,
    new Uint8Array(64), new Uint8Array(32), 0n));
  const hello = r.toSend;
  if (hello[0] !== 22) throw new Error("the first record is not a handshake record");
  const recLen = (hello[3] << 8) | hello[4];
  if (5 + recLen !== hello.length) throw new Error("the record length does not match");
  if (hello[5] !== 1) throw new Error("the first message is not a ClientHello");
  const msgLen = (hello[6] << 16) | (hello[7] << 8) | hello[8];
  if (9 + msgLen !== hello.length) throw new Error("the message length does not match");
  // legacy_version must say 1.2 whatever we actually support.
  if (hello[9] !== 3 || hello[10] !== 3) throw new Error("legacy_version is not 0x0303");
});

Deno.test("client: completes a handshake against an ECDSA P-256 certificate", async () => {
  // Ed25519 is what this repo issues itself; ECDSA-P256 is what the web mostly uses, and
  // it exercises a different key type in the certificate, a different signature in
  // CertificateVerify, and a different DER shape — ECDSA signatures arrive wrapped in a
  // SEQUENCE of two INTEGERs, which have to be unwrapped and zero-padded back to 32.
  await againstOpenSslServer("ec");
});

Deno.test("client: completes a handshake against an RSA-2048 certificate", async () => {
  // The other half of the web. RSA brings a third encoding quirk: the modulus is a DER
  // INTEGER, which is signed, so almost every modulus carries a leading zero byte that is
  // not part of the key — and using that length as the key size fails every signature.
  await againstOpenSslServer("rsa");
});

/** Run openssl s_server with the named key pair and complete one handshake. */
async function againstOpenSslServer(kind: "ec" | "rsa"): Promise<void> {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();

  const dir = new URL("./data/", import.meta.url).pathname;
  const proc = new Deno.Command("openssl", {
    args: ["s_server", "-accept", String(port), "-cert", `${dir}${kind}_leaf.pem`,
           "-key", `${dir}${kind}_leaf.key`, "-tls1_3", "-www", "-quiet"],
    stdout: "null", stderr: "null",
  }).spawn();
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const ca = pemToDer(await Deno.readTextFile(new URL(`./data/${kind}_ca.pem`, import.meta.url)));
    const r = await request("127.0.0.1", port, "wac.test", ca,
      "GET / HTTP/1.1\r\nHost: wac.test\r\n\r\n");
    if (r.failure !== 0) throw new Error(`${kind}: handshake failed, code ${r.failure}`);
    if (!r.response.includes("200 ok") && !r.response.includes("200 OK")) {
      throw new Error(`${kind}: no reply — ${JSON.stringify(r.response.slice(0, 120))}`);
    }
  } finally {
    try { proc.kill(); } catch { /* already gone */ }
    await proc.status;
  }
}

/** OpenSSL 3.5.7, which unlike the system 3.0.13 speaks ML-KEM. */
const OPENSSL35 = Deno.env.get("OPENSSL35") ??
  "/tmp/ossl/openssl-openssl-3.5.7/apps/openssl";
const HAVE_OPENSSL35 = (() => {
  try {
    return Deno.statSync(OPENSSL35).isFile;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "client: negotiates X25519MLKEM768 against a post-quantum-only server",
  ignore: !HAVE_OPENSSL35,
  fn: async () => {
    // The server accepts nothing else, so a client whose 1216-byte share were built the
    // wrong way round — ML-KEM and X25519 are concatenated in one order for this group
    // and the other order for SecP256r1MLKEM768 — would fail rather than fall back.
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();

    const dir = new URL("./data/", import.meta.url).pathname;
    const proc = new Deno.Command(OPENSSL35, {
      args: ["s_server", "-accept", String(port), "-cert", `${dir}ec_leaf.pem`,
             "-key", `${dir}ec_leaf.key`, "-tls1_3", "-groups", "X25519MLKEM768",
             "-www", "-quiet"],
      stdout: "null", stderr: "null",
    }).spawn();
    await new Promise((r) => setTimeout(r, 1500));

    try {
      const ca = pemToDer(await Deno.readTextFile(new URL("./data/ec_ca.pem", import.meta.url)));
      const r = await request("127.0.0.1", port, "wac.test", ca,
        "GET / HTTP/1.1\r\nHost: wac.test\r\n\r\n");
      if (r.failure !== 0) throw new Error(`hybrid handshake failed, code ${r.failure}`);
      if (!r.response.includes("200 ok") && !r.response.includes("200 OK")) {
        throw new Error(`no reply: ${JSON.stringify(r.response.slice(0, 120))}`);
      }
    } finally {
      try { proc.kill(); } catch { /* already gone */ }
      await proc.status;
    }
  },
});
