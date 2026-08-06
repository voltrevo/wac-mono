// `dird` over a socket: publish a descriptor, then fetch it back.
//
// Everything about *deciding* — which descriptors are acceptable, what they are called, which targets
// are a publish — is checked without a socket in `hsstore_wac.test.ts` and `hspublish_wac.test.ts`,
// against verdicts C tor reached on the same bytes. What is left is the part only a connection can
// show, and it is the part that has bitten this package before: a body that arrives in more than one
// read. Issue 0089 was two weeks of a relay dropping data because a record was fed to a parser in
// pieces, and a fourteen-kilobyte POST is the same shape.
//
// So the first case here is the **control**: a fetch before anything is published. Without it a 200
// later proves only that the server answers, not that it stored anything — and a route that returned
// the descriptor unconditionally would pass every other case in this file.

import { buildApp } from "../../platform/build.ts";
import "../../../harness/spawnRetry.ts";

const generated = JSON.parse(
  await Deno.readTextFile(new URL("data/hsdesc_generated.json", import.meta.url)),
) as { descriptor: string; descriptorNext: string; blindPublic: string };
const consensusVector = JSON.parse(
  await Deno.readTextFile(new URL("data/consensus_generated.json", import.meta.url)),
) as { consensus: string; descriptor: string };
const certVector = JSON.parse(
  await Deno.readTextFile(new URL("data/authcert_generated.json", import.meta.url)),
) as { certificate: string };

const DESCRIPTOR = generated.descriptor;
/** The same service, one revision later — what a republishing service actually sends. */
const NEWER = generated.descriptorNext;
const QUERY = btoa(
  String.fromCharCode(...generated.blindPublic.match(/../g)!.map((h) => parseInt(h, 16))),
).replace(/=+$/, "");

function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

type Reply = { status: number; body: string };

/** Send raw request bytes, in `chunks` pieces, and read the whole reply. */
async function request(port: number, bytes: Uint8Array, chunks = 1): Promise<Reply> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const size = Math.ceil(bytes.length / chunks);
    for (let at = 0; at < bytes.length; at += size) {
      await conn.write(bytes.subarray(at, Math.min(at + size, bytes.length)));
      // A pause between pieces, so the server genuinely sees more than one read rather than the
      // kernel coalescing them into one. Without it "sent in four chunks" is a claim about this test.
      if (chunks > 1) await new Promise((r) => setTimeout(r, 15));
    }
    const parts: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    for (;;) {
      const n = await conn.read(buf);
      if (n === null) break;
      parts.push(buf.slice(0, n));
    }
    const all = new TextDecoder().decode(
      parts.reduce((a, b) => new Uint8Array([...a, ...b]), new Uint8Array()),
    );
    const at = all.indexOf("\r\n\r\n");
    const head = at < 0 ? all : all.slice(0, at);
    return {
      status: parseInt(head.split(" ")[1] ?? "-1", 10),
      body: at < 0 ? "" : all.slice(at + 4),
    };
  } finally {
    conn.close();
  }
}

function get(port: number, target: string): Promise<Reply> {
  return request(port, new TextEncoder().encode(`GET ${target} HTTP/1.0\r\n\r\n`));
}

function post(port: number, body: string, chunks = 1): Promise<Reply> {
  const encoded = new TextEncoder().encode(body);
  const head = `POST /tor/hs/3/publish HTTP/1.0\r\nHost: 127.0.0.1\r\n` +
    `Content-Length: ${encoded.length}\r\n\r\n`;
  return request(
    port,
    new Uint8Array([...new TextEncoder().encode(head), ...encoded]),
    chunks,
  );
}

Deno.test("dird publishes and serves an onion service descriptor", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wac-dird-" });
  const bin = `${dir}/dird`;
  await buildApp("packages/tor/src/dird.wac", bin, { read: true, net: true });
  await Deno.writeTextFile(`${dir}/consensus`, consensusVector.consensus);
  await Deno.writeTextFile(`${dir}/cert`, certVector.certificate);
  await Deno.writeTextFile(`${dir}/desc`, consensusVector.descriptor);

  // Port 0 asks the OS for a free one, which two agents running the suite at once cannot collide on.
  const child = new Deno.Command(bin, {
    args: [`${dir}/consensus`, `${dir}/cert`, `${dir}/desc`, "0"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Drained continuously rather than read up to the port and abandoned: `dird` logs what it stores,
  // and a reader that stops after the first line turns every later log line into a full pipe — which
  // would eventually block the process being tested.
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  let ended = false;
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { ended = true; return; }
      seen += value;
    }
  })();

  async function waitFor(re: RegExp, what: string): Promise<RegExpMatchArray> {
    for (let i = 0; i < 400; i++) {
      const m = seen.match(re);
      if (m) return m;
      if (ended) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`dird never said it ${what}. Its output was:\n${seen}`);
  }

  try {
    const port = parseInt((await waitFor(/serving the directory on 127\.0\.0\.1:(\d+)/, "listened"))[1], 10);

    // ── The control: nothing has been published, so there is nothing to serve ──
    const before = await get(port, `/tor/hs/3/${QUERY}`);
    assertEquals(before.status, 404, "a descriptor nobody uploaded is not served");

    // ── Publish, in four pieces, because a real upload does not arrive in one read ──
    const published = await post(port, DESCRIPTOR, 4);
    assertEquals(published.status, 200, "a valid descriptor is accepted");
    assertEquals(
      published.body.includes("stored successfully"),
      true,
      `the reply says so — got ${JSON.stringify(published.body)}`,
    );

    // ── And it comes back, byte for byte, under the name the certificate gave it ──
    const after = await get(port, `/tor/hs/3/${QUERY}`);
    assertEquals(after.status, 200, "the descriptor is served after publication");
    assertEquals(after.body, DESCRIPTOR, "and it is the bytes that were uploaded, unchanged");

    // A client asks for one service, so another name must not reach this one.
    const other = await get(port, "/tor/hs/3/" + "A".repeat(43));
    assertEquals(other.status, 404, "another blinded key is not this descriptor");

    // ── A descriptor tor refuses, refused — and it must not evict the good one ──
    const at = DESCRIPTOR.indexOf("superencrypted") + 60;
    const broken = DESCRIPTOR.slice(0, at) + (DESCRIPTOR[at] === "X" ? "Y" : "X") +
      DESCRIPTOR.slice(at + 1);
    const rejected = await post(port, broken);
    assertEquals(rejected.status, 400, "a descriptor whose signature fails is refused");
    const still = await get(port, `/tor/hs/3/${QUERY}`);
    assertEquals(still.body, DESCRIPTOR, "and a refused upload does not disturb what is held");

    // ── Republishing: strictly newer, or refused ──
    // tor's `cache_store_v3_as_dir` replaces only when the revision counter is greater, so an
    // unchanged descriptor uploaded twice is a 400 rather than a no-op 200. This case asserted 200
    // until the sequence was put to a real HSDir, which refused it.
    assertEquals(
      (await post(port, DESCRIPTOR)).status,
      400,
      "an unchanged descriptor is refused the second time, as tor refuses it",
    );
    assertEquals(
      (await get(port, `/tor/hs/3/${QUERY}`)).body,
      DESCRIPTOR,
      "and what is held is untouched by the refusal",
    );

    assertEquals((await post(port, NEWER)).status, 200, "a newer revision is accepted");
    assertEquals(
      (await get(port, `/tor/hs/3/${QUERY}`)).body,
      NEWER,
      "and replaces what was held rather than joining it",
    );
    // An older descriptor arriving late must not undo the newest publication — the failure that
    // makes a service unreachable while every log line says it published.
    assertEquals((await post(port, DESCRIPTOR)).status, 400, "the older one is refused");
    assertEquals(
      (await get(port, `/tor/hs/3/${QUERY}`)).body,
      NEWER,
      "and the newer descriptor still stands",
    );
    // Two accepted uploads, and the directory still holds one descriptor. A store that appended
    // would serve whichever copy the search reached first, which over a service's lifetime is the
    // stale one — and the count is the only signal that tells the two apart.
    await waitFor(/stored a descriptor, 1 held[\s\S]*stored a descriptor, 1 held/,
                  "stored one descriptor twice");

    // The directory documents still work, so publication did not take the port over.
    assertEquals(
      (await get(port, "/tor/status-vote/current/consensus")).status,
      200,
      "the consensus is still served",
    );
  } finally {
    reader.cancel().catch(() => {});
    await pump.catch(() => {});
    try {
      child.kill();
    } catch { /* already gone */ }
    await child.status;
    await Deno.remove(dir, { recursive: true });
  }
});
