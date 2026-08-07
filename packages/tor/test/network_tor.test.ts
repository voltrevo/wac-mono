// test-lane: exclusive — three relays and an authority, deriving RSA identities on real ports
//
// Design 0002's done condition: *`deno task test` stands up a Tor network with no C in it, publishes
// an onion service on it, fetches a page from that service through a three-hop circuit, and tears it
// down.* Three relays, an authority, a service and two clients — every layer of it wac, from the TLS
// record up. The first test here is the network and a document fetched over a circuit; the second is
// the onion service on that same network.
//
// This is the file `network.test.ts` deliberately is not. That one tests the launcher against
// `waiter` and `wc`, so it fails when the *launcher* is wrong; this one fails when anything in the
// stack is. Both are wanted and they are different questions, which is why they are different files.
//
// ## What makes this possible in a suite at all
//
// Every relay binds port 0 and announces what it was given, every program writes down the part of the
// configuration only it knows, and `wait` names the state between listening and serving. So nothing
// here needs a port, a key or a timestamp agreed in advance — which is what lets two agents run the
// suite at the same time on one machine.
//
// ## The order, which is the whole difficulty
//
// A consensus is built from descriptors. A descriptor cannot name a port until its relay has bound
// one. So the relays necessarily exist before the document that describes them, and the description
// has to say so in three places: the ready marker is the *descriptor* line rather than the bind, so
// every relay has written one before the authority runs; the authority is a `run` between the nodes
// coming up and the client starting; and `wait` holds the client until each relay has found the
// documents and begun serving them.

import { buildApp } from "../../platform/build.ts";
import "../../../harness/spawnRetry.ts";

function assertContains(haystack: string, needle: string, msg?: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `expected output to contain ${JSON.stringify(needle)}${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got: ${haystack.slice(0, 4000)}`,
    );
  }
}

Deno.test("a Tor network with no C in it, stood up and fetched from", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wac-tornet-" });
  try {
    const launcher = `${dir}/network`;
    await buildApp("packages/tor/src/network.wac", launcher, { read: true, write: true, net: true });
    await buildApp("packages/tor/src/relayd.wac", `${dir}/relayd.worker.js`, {}, "deno", true);
    await buildApp("packages/tor/src/gendesc.wac", `${dir}/gendesc.worker.js`, {}, "deno", true);
    await buildApp("packages/tor/src/app.wac", `${dir}/torapp.worker.js`, {}, "deno", true);

    // Distinct seeds, so no two relays derive the same identity. Random rather than fixed because a
    // fixed one would make two concurrent runs of this suite share keys.
    for (const n of [1, 2, 3]) {
      await Deno.writeFile(`${dir}/s${n}`, crypto.getRandomValues(new Uint8Array(32)));
    }

    const docs = "-C v.consensus -K cert.cert -D r1.desc -D r2.desc -D r3.desc" +
      " -M v.consensus.micro -m v.consensus.mds";
    // The ready marker is the descriptor line, not the bind. A relay logs `listening on` before it
    // writes its descriptor, so a plan that waited on the bind would run the authority against
    // descriptors that did not exist yet.
    const relay = (n: number, extra = "") =>
      `node relay${n} | -byte descriptor for port | relayd.worker.js s${n} -p 0 -n wacnet${n} ` +
      `--descriptor r${n}.desc ${extra}${docs}`;

    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        // Generous: three RSA-1024 prime searches happen at once here, and a busy machine makes that
        // slow. A default tuned for a quiet one would turn load into a failure.
        "timeout 300000",
        relay(1, "--seedline seed.txt "),
        relay(2),
        relay(3),
        "run  vote   |                       | gendesc.worker.js keys.json cert vote v - r1.desc r2.desc r3.desc",
        "wait relay1 | serving the consensus |",
        "wait relay2 | serving the consensus |",
        "wait relay3 | serving the consensus |",
        "run  fetch  |                       | torapp.worker.js seed.txt cert.fingerprint /tor/status-vote/current/consensus",
        "",
      ].join("\n"),
    );

    const r = new Deno.Command(launcher, {
      args: ["net.txt"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    const dec = new TextDecoder();
    const out = dec.decode(r.stdout);
    const err = dec.decode(r.stderr);

    if (r.code !== 0) throw new Error(`the network did not come up or the fetch failed:\n${err}`);

    // Each stage was seen, by name. The launcher's whole claim is that none of these was assumed.
    assertContains(err, "all 3 nodes are up");
    assertContains(err, "relay1 says serving the consensus", "relay1 reached the serving state");
    assertContains(err, "relay3 says serving the consensus", "and so did the last one");
    assertContains(err, "circuit built", "the client built a circuit through them");

    // And the document came back through it. Checking the first keyword rather than a length: a
    // relay that answered 404 would give a short body, and a short body is not obviously wrong.
    assertContains(out, "network-status-version 3", "stdout is a consensus, fetched over the circuit");
    assertContains(out, "directory-signature ", "signed, and complete to the end of the document");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an onion service published on that network, and a page fetched from it", async () => {
  // The rest of design 0002's done condition: *publishes an onion service on it, fetches a page from
  // that service through a three-hop circuit, and tears it down.*
  //
  // The service is a `node` placed after the authority has run and the relays are serving, because it
  // bootstraps *through* them — it cannot exist before there is a consensus to bootstrap from. That is
  // what stages are for.
  //
  // Its address is not knowable in advance: it is derived from an identity seed inside the process.
  // The service logs it as the first thing it says, so a `wait` on `hsserviced: ` captures it — a
  // marker it has long since printed by the time the wait runs, which is the path that only started
  // capturing correctly one commit ago.
  const dir = await Deno.makeTempDir({ prefix: "wac-onion-" });
  try {
    const launcher = `${dir}/network`;
    await buildApp("packages/tor/src/network.wac", launcher, { read: true, write: true, net: true });
    await buildApp("packages/tor/src/relayd.wac", `${dir}/relayd.worker.js`, {}, "deno", true);
    await buildApp("packages/tor/src/gendesc.wac", `${dir}/gendesc.worker.js`, {}, "deno", true);
    await buildApp("packages/tor/src/hsserviced.wac", `${dir}/hsserviced.worker.js`, {}, "deno", true);
    await buildApp("packages/tor/src/hsconnect.wac", `${dir}/hsconnect.worker.js`, {}, "deno", true);

    for (const n of [1, 2, 3]) {
      await Deno.writeFile(`${dir}/s${n}`, crypto.getRandomValues(new Uint8Array(32)));
    }
    await Deno.writeFile(`${dir}/hs.seed`, crypto.getRandomValues(new Uint8Array(32)));

    const docs = "-C v.consensus -K cert.cert -D r1.desc -D r2.desc -D r3.desc" +
      " -M v.consensus.micro -m v.consensus.mds";
    const relay = (n: number, extra = "") =>
      `node relay${n} | -byte descriptor for port | relayd.worker.js s${n} -p 0 -n wacon${n} ` +
      `--descriptor r${n}.desc ${extra}${docs}`;

    await Deno.writeTextFile(
      `${dir}/net.txt`,
      [
        "timeout 300000",
        relay(1, "--seedline seed.txt "),
        relay(2),
        relay(3),
        "run  vote    |                       | gendesc.worker.js keys.json cert vote v - r1.desc r2.desc r3.desc",
        "wait relay1  | serving the consensus |",
        "wait relay2  | serving the consensus |",
        "wait relay3  | serving the consensus |",
        "node service | waiting for a client  | hsserviced.worker.js seed.txt cert.fingerprint hs.seed --testnet",
        // A node's own output never reaches the launcher's streams — only a `run`'s does — so the
        // service's stages are asserted the way the launcher can see them: as markers it was asked to
        // wait for and reports matching. All three are long since printed by the time the service is
        // ready, which is the point: they are stages it passed on the way there.
        "wait service | introduction point established |",
        "wait service | published to                   |",
        "wait service | hsserviced:                    |",
        "run  visit   |                       | hsconnect.worker.js seed.txt cert.fingerprint {service} 80 --testnet",
        "",
      ].join("\n"),
    );

    const r = new Deno.Command(launcher, {
      args: ["net.txt"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    const dec = new TextDecoder();
    const out = dec.decode(r.stdout);
    const err = dec.decode(r.stderr);

    if (r.code !== 0) throw new Error(`the onion service run failed:\n${err}`);

    assertContains(err, 'service had already said "introduction point established"',
                   "the service claimed an introduction point");
    assertContains(err, 'service had already said "published to"',
                   "and published its descriptor to the directories");
    assertContains(out, "hello from behind an onion", "and the page came back through the rendezvous");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
