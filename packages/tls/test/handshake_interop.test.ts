// A real TLS 1.3 handshake, against real clients.
//
// Everything else in this package is checked against vectors and against WebCrypto,
// which establishes that the primitives and the key schedule are right. None of it
// establishes that the *protocol* is right — a handshake can have every secret correct
// and still fail on a length prefix, a missing legacy field, or a transcript that
// includes one message too many.
//
// So this runs the thing. A listener, a real client, and a check that the client got the
// bytes it asked for. Two clients rather than one, because they are separate
// implementations that disagree about different things:
//
//   OpenSSL 3.0   the reference everyone tests against
//   rustls        Deno's TLS client, and a from-scratch implementation in another
//                 language — it also verifies the certificate chain, which OpenSSL is
//                 told to skip
//
// The certificate is a CA-signed leaf rather than a self-signed one, because rustls
// rejects a CA certificate presented as an end-entity — correctly, and the first version
// of this test hit exactly that.

import { feed, newConnection, recordNeeded, send, tlsClose, unpack } from "../host/serve.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Run the wac TLS server on an ephemeral port for one connection, and answer one
 * request. Returns the port, and a promise that resolves when the connection is done.
 */
function serveOnce(reply: string): { port: number; done: Promise<string | null>; close: () => void } {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      try { listener.close(); } catch { /* already closed */ }
    }
  };

  const done = (async (): Promise<string | null> => {
    let received: string | null = null;
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

          const r = unpack(feed(state, ready));
          state = r.state;
          if (r.toSend.length > 0) await conn.write(r.toSend);
          if (r.appData.length > 0) {
            received = dec.decode(r.appData);
            const s = unpack(send(state, enc.encode(reply)));
            state = s.state;
            await conn.write(s.toSend);
            const c = unpack(tlsClose(state));
            state = c.state;
            if (c.toSend.length > 0) await conn.write(c.toSend);
            break;
          }
        }
      } finally {
        try { conn.close(); } catch { /* already closed */ }
      }
    } catch { /* the client hung up, or the listener closed */ }
    close();
    return received;
  })();

  return { port, done, close };
}

const BODY = "hello from wac over TLS 1.3\n";
const REPLY = `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n` +
  `content-length: ${BODY.length}\r\nconnection: close\r\n\r\n${BODY}`;

Deno.test("tls: OpenSSL completes a TLS 1.3 handshake and exchanges data", async () => {
  const server = serveOnce(REPLY);
  const proc = new Deno.Command("openssl", {
    args: ["s_client", "-connect", `127.0.0.1:${server.port}`, "-tls1_3",
           "-servername", "wac.test", "-quiet", "-verify_quiet"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();

  const w = proc.stdin.getWriter();
  await w.write(enc.encode("GET / HTTP/1.1\r\nHost: wac.test\r\n\r\n"));
  const { stdout, stderr } = await proc.output();
  try { w.releaseLock(); } catch { /* already released */ }
  const received = await server.done;

  const out = dec.decode(stdout);
  const err = dec.decode(stderr);
  if (!out.includes("HTTP/1.1 200 OK") || !out.includes(BODY.trim())) {
    throw new Error(`openssl did not get the reply.\nstdout:\n${out}\nstderr:\n${err}`);
  }
  if (received === null || !received.startsWith("GET /")) {
    throw new Error(`the server did not receive the request, got ${JSON.stringify(received)}`);
  }
});

Deno.test("tls: rustls completes the handshake and verifies the certificate chain", async () => {
  // Deno's client is rustls. Unlike the OpenSSL case it is given the CA and made to
  // check the chain, so this covers the certificate being well-formed and correctly
  // framed in the Certificate message — not only that a signature verified.
  const ca = await Deno.readTextFile(new URL("./data/ca.pem", import.meta.url));
  const server = serveOnce(REPLY);
  // By IP rather than by name: `serverName` is an unstable Deno option, and the leaf
  // carries IP:127.0.0.1 in its subjectAltName precisely so this works without it.
  const conn = await Deno.connectTls({ hostname: "127.0.0.1", port: server.port, caCerts: [ca] });
  await conn.write(enc.encode("GET / HTTP/1.1\r\nHost: wac.test\r\n\r\n"));
  const buf = new Uint8Array(4096);
  const n = await conn.read(buf) ?? 0;
  const out = dec.decode(buf.subarray(0, n));
  try { conn.close(); } catch { /* the server may have closed first */ }
  await server.done;

  if (!out.includes("HTTP/1.1 200 OK") || !out.includes(BODY.trim())) {
    throw new Error(`rustls did not get the reply:\n${out}`);
  }
});

Deno.test("tls: a client offering no TLS 1.3 support is rejected", async () => {
  // The server must not fall back. A TLS 1.2 ClientHello has no supported_versions
  // extension saying 0x0304, and answering it with a TLS 1.3 ServerHello would be worse
  // than refusing — the client would fail confusingly, or worse, not fail.
  const server = serveOnce(REPLY);
  const proc = new Deno.Command("openssl", {
    args: ["s_client", "-connect", `127.0.0.1:${server.port}`, "-tls1_2", "-quiet"],
    stdin: "null", stdout: "piped", stderr: "piped",
  }).spawn();
  const { stdout } = await proc.output();
  await server.done;
  const out = dec.decode(stdout);
  if (out.includes("HTTP/1.1 200 OK")) throw new Error("a TLS 1.2 client was served");
});

Deno.test("tls: the connection closes cleanly, not as a truncation", async () => {
  // A TLS peer cannot distinguish an orderly shutdown from an attacker cutting the
  // connection unless it sees close_notify — so a client that cares reports an error on
  // a bare TCP close. rustls is such a client: a clean shutdown makes `read` return null,
  // and a truncated one makes it throw.
  const ca = await Deno.readTextFile(new URL("./data/ca.pem", import.meta.url));
  const server = serveOnce(REPLY);
  const conn = await Deno.connectTls({ hostname: "127.0.0.1", port: server.port, caCerts: [ca] });
  await conn.write(enc.encode("GET / HTTP/1.1\r\nHost: wac.test\r\n\r\n"));

  const buf = new Uint8Array(4096);
  const n = await conn.read(buf) ?? 0;
  if (!dec.decode(buf.subarray(0, n)).includes("HTTP/1.1 200 OK")) {
    throw new Error("did not get the reply");
  }
  // The next read must report end-of-stream rather than raising.
  let second: number | null;
  try {
    second = await conn.read(new Uint8Array(64));
  } catch (e) {
    throw new Error(`the shutdown was seen as a truncation: ${String(e).split("\n")[0]}`);
  }
  if (second !== null) throw new Error(`expected end of stream, read ${second} more bytes`);
  try { conn.close(); } catch { /* already closed by the peer */ }
  await server.done;
});

/** OpenSSL 3.5.7, built by tools/openssl35.sh. The system 3.0.13 has no ML-KEM. */
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
  name: "tls: the server negotiates X25519MLKEM768 with a post-quantum client",
  // Skipped rather than failed without the newer OpenSSL: it is a reference this repo
  // does not ship, and a suite that goes red over a missing optional tool gets ignored.
  ignore: !HAVE_OPENSSL35,
  fn: async () => {
    // `-groups X25519MLKEM768` makes it the *only* group offered, so a server that
    // quietly fell back to X25519 would fail the handshake rather than silently
    // downgrade — which is the outcome worth testing for.
    const server = serveOnce(REPLY);
    const proc = new Deno.Command(OPENSSL35, {
      args: ["s_client", "-connect", `127.0.0.1:${server.port}`, "-tls1_3",
             "-groups", "X25519MLKEM768", "-quiet", "-verify_quiet"],
      stdin: "piped", stdout: "piped", stderr: "piped",
    }).spawn();
    const w = proc.stdin.getWriter();
    await w.write(enc.encode("GET / HTTP/1.1\r\nHost: wac.test\r\n\r\n"));
    const { stdout, stderr } = await proc.output();
    try { w.releaseLock(); } catch { /* already released */ }
    await server.done;

    const out = dec.decode(stdout);
    if (!out.includes("HTTP/1.1 200 OK") || !out.includes(BODY.trim())) {
      throw new Error(`no reply over the hybrid group.\nstdout:\n${out}\nstderr:\n${dec.decode(stderr)}`);
    }
  },
});
