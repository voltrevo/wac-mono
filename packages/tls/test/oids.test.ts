// Every OID constant in `src/asn1.wac`, against OpenSSL's encoder.
//
// Eighteen byte strings typed from memory, and until this file existed **four of them were consulted by
// nothing**: mutation testing replaced the bodies of `oidRsaPss`, `oidRsaSha384`, `oidRsaSha512` and
// `oidAnyExtKeyUsage` with constants and the whole suite stayed green. The rest were "tested" only in the
// sense that a certificate happened to use them — nothing ever said what they should be.
//
// A wrong OID does not look like a bug. `1.2.840.113549.1.1.12` with one byte off is a signature algorithm
// nobody recognises, so a valid certificate is rejected; the other direction, an OID that collides with a
// real one, accepts a signature computed under a different hash. Neither shows up as a parse error.
//
// So the check is against a third party that has never seen this code: each constant's **doc comment**
// carries its dotted form, and `openssl asn1parse -genstr` encodes that dotted form into DER. The bytes
// have to match. That makes the comment binding rather than decorative — get either the comment or the
// bytes wrong and this fails — and it covers every constant, including ones added later, because the two
// lists have to be the same length.

import { wacBind } from "../../../harness/wacBind.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const probe = await wacBind("packages/tls/test/wac/oids_probe.wac") as Record<string, () => Uint8Array>;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The `oidX` constants and the dotted OID each one's doc comment claims it is. */
function documented(): [string, string][] {
  const src = Deno.readTextFileSync(new URL("../src/asn1.wac", import.meta.url));
  const out: [string, string][] = [];
  // Each declaration with the comment block immediately above it, and the first dotted number in that
  // block. `oidSecp384r1` and `oidAnyExtKeyUsage` have several paragraphs, so it cannot be anchored to the
  // opening `/**`.
  const re = /\/\*\*([\s\S]*?)\*\/\s*\nexport u8\[\] (oid[A-Za-z0-9]+)\(\)/g;
  for (const m of src.matchAll(re)) {
    const dotted = m[1].match(/\b\d+(?:\.\d+)+\b/);
    if (dotted === null) throw new Error(`${m[2]}'s doc comment does not say which OID it is`);
    out.push([m[2], dotted[0]]);
  }
  const declared = [...src.matchAll(/export u8\[\] (oid[A-Za-z0-9]+)\(\)/g)].map((m) => m[1]);
  if (declared.length !== out.length) {
    const undocumented = declared.filter((n) => !out.some(([k]) => k === n));
    throw new Error(`these OIDs have no dotted form in a doc comment: ${undocumented.join(", ")}`);
  }
  return out;
}

/** What OpenSSL encodes a dotted OID as: the contents of the OBJECT IDENTIFIER, tag and length removed. */
function opensslOid(dotted: string): Uint8Array {
  const der = Deno.makeTempFileSync({ prefix: "wac-oid-" });
  try {
    const r = new Deno.Command("openssl", {
      args: ["asn1parse", "-genstr", `OID:${dotted}`, "-noout", "-out", der],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (r.code !== 0) {
      throw new Error(`openssl could not encode ${dotted}: ${new TextDecoder().decode(r.stderr)}`);
    }
    const bytes = Deno.readFileSync(der);
    // `06 <len> <contents>`, and a short-form length because no OID here is anywhere near 128 bytes.
    if (bytes[0] !== 0x06) throw new Error(`openssl produced tag ${bytes[0]} for ${dotted}, not an OID`);
    if (bytes[1] !== bytes.length - 2) throw new Error(`unexpected length encoding for ${dotted}`);
    return bytes.subarray(2);
  } finally {
    Deno.removeSync(der);
  }
}

Deno.test("every OID is the one its comment says, byte for byte", () => {
  const pairs = documented();
  assertEquals(pairs.length >= 18, true, `only ${pairs.length} OIDs found — did the parse break?`);
  for (const [name, dotted] of pairs) {
    const fn = probe[`p_${name}`];
    if (fn === undefined) {
      throw new Error(`${name} is not in test/wac/oids_probe.wac — add it, so it is checked`);
    }
    assertEquals(hex(fn()), hex(opensslOid(dotted)), `${name} claims to be ${dotted}`);
  }
});

Deno.test("and the encoder being checked against is really doing the work", () => {
  // The control. If `opensslOid` returned the same bytes for everything — a stub, an empty file, a tool
  // that silently ignored `-genstr` — the test above would pass for eighteen identical constants.
  const a = opensslOid("1.2.840.113549.1.1.11");
  const b = opensslOid("1.2.840.113549.1.1.12");
  assertEquals(hex(a) === hex(b), false, "openssl gave two different OIDs the same encoding");
  assertEquals(hex(a), "2a864886f70d01010b", "sha256WithRSAEncryption is a published constant");
  // And a dotted form nothing here uses, to show the encoder is general rather than a lookup of ours.
  assertEquals(hex(opensslOid("1.3.6.1.4.1.311.20.2")), "2b0601040182371402");
});
