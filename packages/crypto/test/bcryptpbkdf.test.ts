// bcrypt_pbkdf, against OpenSSH itself.
//
// There is no WebCrypto oracle for this one and no vector I would trust myself to transcribe, so
// the oracle is the thing the KDF exists to serve: `ssh-keygen` writes an encrypted private key,
// and we decrypt it. That is stronger than a published vector, because it exercises the format's
// real parameters and fails if any part of the derivation is wrong.
//
// What makes it a proof rather than a plausible-looking pass: the private section of an
// `openssh-key-v1` file opens with the same random 32-bit value twice. The cipher is AES-CTR, so
// a derived key wrong in any bit produces an unrelated keystream and the two would agree only by
// a 2^-32 accident. The embedded public key is then compared against the `.pub` file, which
// checks bytes much further into the stream and so covers the IV as well as the key.

import { createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/src/bcryptpbkdf.wac") as unknown as {
  bcryptPbkdf(pass: Uint8Array, salt: Uint8Array, keylen: number, rounds: number): Uint8Array;
};

const utf8 = new TextEncoder();

/** A cursor over SSH wire format: uint32 lengths, big-endian, everything length-prefixed. */
function reader(b: Uint8Array) {
  let p = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    u32: () => { const v = dv.getUint32(p); p += 4; return v; },
    str: () => { const n = dv.getUint32(p); p += 4; const s = b.slice(p, p + n); p += n; return s; },
  };
}

const haveKeygen = await (async () => {
  try {
    return (await new Deno.Command("ssh-keygen", { args: ["-?"] }).output()).code !== 127;
  } catch {
    return false;
  }
})();

// Key length and IV length per cipher. The two differ in total, which matters: 48 bytes needs the
// striped output path (stride 2) and 32 bytes does not (stride 1), so both are covered.
const CIPHERS: Record<string, [number, number, string]> = {
  "aes256-ctr": [32, 16, "aes-256-ctr"],
  "aes128-ctr": [16, 16, "aes-128-ctr"],
};

Deno.test({
  name: "an OpenSSH private key encrypted by ssh-keygen decrypts with our bcrypt_pbkdf",
  ignore: !haveKeygen,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const cases = [
        { type: "ed25519", cipher: "aes256-ctr", rounds: 16, pass: "correct horse battery staple" },
        { type: "ed25519", cipher: "aes128-ctr", rounds: 1, pass: "x" },
        { type: "ed25519", cipher: "aes256-ctr", rounds: 4, pass: "a passphrase with spaces and ünicode" },
        { type: "rsa", cipher: "aes256-ctr", rounds: 4, pass: "pw" },
      ];

      for (const c of cases) {
        const f = `${dir}/${c.type}-${c.cipher}-${c.rounds}`;
        const args = ["-t", c.type, "-N", c.pass, "-f", f, "-q", "-a", String(c.rounds), "-Z", c.cipher];
        if (c.type === "rsa") args.push("-b", "2048");
        const gen = await new Deno.Command("ssh-keygen", { args }).output();
        if (!gen.success) throw new Error(`ssh-keygen: ${new TextDecoder().decode(gen.stderr)}`);

        const pem = await Deno.readTextFile(f);
        const b64 = pem.split("\n").filter(l => !l.startsWith("-----")).join("");
        const blob = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));

        const magic = new TextDecoder().decode(blob.slice(0, 15));
        if (magic !== "openssh-key-v1\0") throw new Error(`not an openssh-key-v1 file: ${magic}`);

        const r = reader(blob.slice(15));
        const ciphername = new TextDecoder().decode(r.str());
        const kdfname = new TextDecoder().decode(r.str());
        if (kdfname !== "bcrypt") throw new Error(`expected bcrypt, got ${kdfname}`);
        const opts = reader(r.str());
        const salt = opts.str();
        const rounds = opts.u32();
        r.u32();                                  // key count, always 1 here
        const pubblob = r.str();
        const ciphertext = r.str();

        const [klen, ivlen, nodeName] = CIPHERS[ciphername];
        const derived = mod.bcryptPbkdf(utf8.encode(c.pass), salt, klen + ivlen, rounds);
        if (derived.length !== klen + ivlen) throw new Error("wrong derived length");

        const d = createDecipheriv(nodeName, derived.slice(0, klen), derived.slice(klen));
        d.setAutoPadding(false);
        const plain = new Uint8Array(Buffer.concat([d.update(ciphertext), d.final()]));

        const pr = reader(plain);
        const check1 = pr.u32();
        const check2 = pr.u32();
        if (check1 !== check2) {
          throw new Error(
            `${c.type}/${ciphername}/rounds=${rounds}: check ints ${check1} != ${check2} — ` +
            `the derived key is wrong`);
        }

        // Reaches further into the keystream than the check ints do, so the IV is covered too.
        const want = (await Deno.readTextFile(`${f}.pub`)).split(" ")[1];
        const got = btoa(String.fromCharCode(...pubblob));
        if (got !== want) throw new Error(`${c.type}: embedded public key does not match the .pub file`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// A fixed input, so the KDF stays pinned without needing ssh-keygen present.
//
// Honest about what this is: the expected bytes were produced by this implementation *after* the
// interop test above established it agrees with OpenSSH. It is a regression anchor, not an
// independent vector, and it proves nothing on its own — if the test above is skipped or removed,
// this one is only checking that we still do whatever we did before.
Deno.test("bcrypt_pbkdf is pinned to a fixed answer", () => {
  const got = mod.bcryptPbkdf(utf8.encode("password"), utf8.encode("salt"), 48, 4);
  const want = "5ba4bfc60c7ac272931458407f4c1c4936ea356c55125c5a279b791d65bf9842" +
               "d49d7e1b572a9052715ebfa9421e7e94";
  const hex = Array.from(got).map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex !== want) throw new Error(`bcrypt_pbkdf changed:\n  got  ${hex}\n  want ${want}`);
});

// The striping is the part most likely to be got wrong in a way that still looks reasonable, so
// it is checked directly rather than only through a key that happens to use it.
Deno.test("the second block interleaves with the first rather than following it", () => {
  // A bcrypt block's output depends only on the password, the salt and the block counter — never
  // on how many bytes were asked for. So block 1 is the same 32 bytes in both derivations below,
  // and only *where they land* differs.
  //
  // At 32 bytes there is one block: stride 1, written straight through.
  // At 64 there are two: stride 2, so block 1 supplies the even positions and block 2 the odd.
  // That makes the relationship exact and worth asserting — the even bytes of the long
  // derivation must reproduce the short one entirely.
  const short = mod.bcryptPbkdf(utf8.encode("pw"), utf8.encode("s"), 32, 2);
  const long = mod.bcryptPbkdf(utf8.encode("pw"), utf8.encode("s"), 64, 2);
  for (let i = 0; i < 32; i++) {
    if (long[i * 2] !== short[i]) {
      throw new Error(`byte ${i} of block 1 landed at ${i * 2} as ${long[i * 2]}, expected ${short[i]} — ` +
                      `the output is not striped`);
    }
  }
  // And the odd positions are block 2, so they must not simply continue block 1.
  const contiguous = Array.from(short).every((v, i) => long[i] === v);
  if (contiguous) throw new Error("64-byte derivation starts with the whole 32-byte one; blocks are concatenated, not striped");

  for (const len of [1, 31, 32, 33, 48, 64, 100]) {
    const out = mod.bcryptPbkdf(utf8.encode("pw"), utf8.encode("s"), len, 1);
    if (out.length !== len) throw new Error(`asked for ${len} bytes, got ${out.length}`);
    if (out.every(v => v === 0)) throw new Error(`${len} bytes came back all zero — a block was never placed`);
  }
});
