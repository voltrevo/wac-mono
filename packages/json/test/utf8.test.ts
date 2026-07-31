// UTF-8 validity inside strings, against a strict TextDecoder.
//
// This exists because JSONTestSuite does not cover it. Its invalid-UTF-8 documents
// are all rejected for structural reasons — `[\xff]` fails because 0xFF cannot
// start a value, not because it is not UTF-8 — and the cases that would test it
// (`["\x81"]`, a CESU-8 surrogate) are classified `i_`, where either answer
// conforms. So the corpus passed while the parser accepted every malformed
// sequence there is.
//
// RFC 8259 §8.1 requires JSON text to be valid UTF-8, so it is rejected here.

import { canon, errorOfBytes, ERR } from "./util.ts";

/** A one-string document containing exactly these bytes. */
function doc(...body: number[]): Uint8Array {
  return new Uint8Array([0x22, ...body, 0x22]);
}

/** Whether a strict decoder accepts the bytes — the oracle. */
function hostAccepts(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

Deno.test("utf8: malformed sequences are rejected", async () => {
  const bad: [string, number[]][] = [
    ["lone continuation byte", [0x81]],
    ["continuation after ASCII", [0x61, 0xBF]],
    ["truncated two-byte lead", [0xC3]],
    ["two-byte lead then ASCII", [0xC3, 0x28]],
    ["overlong NUL", [0xC0, 0x80]],
    ["overlong slash", [0xC0, 0xAF]],
    ["overlong three-byte", [0xE0, 0x80, 0x80]],
    ["overlong four-byte", [0xF0, 0x80, 0x80, 0x80]],
    ["truncated three-byte", [0xE6, 0x97]],
    ["truncated four-byte", [0xF0, 0x9F, 0x98]],
    ["high surrogate U+D800", [0xED, 0xA0, 0x80]],
    ["low surrogate U+DFFF", [0xED, 0xBF, 0xBF]],
    ["past U+10FFFF", [0xF4, 0x90, 0x80, 0x80]],
    ["F5 lead", [0xF5, 0x80, 0x80, 0x80]],
    ["FE", [0xFE]],
    ["FF", [0xFF]],
    ["five-byte form", [0xF8, 0x88, 0x80, 0x80, 0x80]],
  ];
  const wrong: string[] = [];
  for (const [label, body] of bad) {
    // Confirm the oracle agrees this is invalid, so the corpus cannot rot.
    if (hostAccepts(new Uint8Array(body))) {
      throw new Error(`${label}: the host considers these bytes valid — bad test case`);
    }
    const err = await errorOfBytes(doc(...body));
    if (err !== ERR.UTF8) wrong.push(`${label}: got code ${err}, want ${ERR.UTF8}`);
  }
  if (wrong.length) throw new Error(`${wrong.length} not rejected as UTF-8:\n  ${wrong.join("\n  ")}`);
});

Deno.test("utf8: a sequence cut off by the end of input is rejected", async () => {
  // Distinct from a sequence followed by a wrong byte: here the string never
  // terminates, so the length check fires rather than the range check. Branch
  // coverage found this path unexercised — every existing case had a closing quote,
  // which supplies a byte for the range check to reject.
  const cases: [string, number[]][] = [
    ["two-byte lead at EOF", [0x22, 0xC3]],
    ["three-byte lead at EOF", [0x22, 0xE6]],
    ["three-byte, one continuation, at EOF", [0x22, 0xE6, 0x97]],
    ["four-byte lead at EOF", [0x22, 0xF0]],
    ["four-byte, two continuations, at EOF", [0x22, 0xF0, 0x9F, 0x98]],
  ];
  for (const [label, bytes] of cases) {
    const err = await errorOfBytes(new Uint8Array(bytes));
    // Either verdict is defensible — the input is both truncated UTF-8 and an
    // unterminated string — but it must be one of them and never accepted.
    if (err !== ERR.UTF8 && err !== ERR.EOF) {
      throw new Error(`${label}: got code ${err}, want UTF8 or EOF`);
    }
  }
});

Deno.test("utf8: a valid lead with a bad later continuation byte", async () => {
  // The loop that checks continuation bytes after the first. A sequence whose first
  // continuation is in range but whose second is not only reaches it here.
  const cases: [string, number[]][] = [
    ["three-byte, second continuation bad", [0xE6, 0x97, 0x41]],
    ["four-byte, second continuation bad", [0xF0, 0x9F, 0x41, 0x80]],
    ["four-byte, third continuation bad", [0xF0, 0x9F, 0x98, 0x41]],
  ];
  for (const [label, body] of cases) {
    if (hostAccepts(new Uint8Array(body))) {
      throw new Error(`${label}: the host considers these valid — bad test case`);
    }
    const err = await errorOfBytes(doc(...body));
    if (err !== ERR.UTF8) throw new Error(`${label}: got code ${err}, want ${ERR.UTF8}`);
  }
});

Deno.test("utf8: well-formed sequences at every width are accepted", async () => {
  const good: [string, number[]][] = [
    ["two-byte, lowest", [0xC2, 0x80]],
    ["two-byte é", [0xC3, 0xA9]],
    ["two-byte, highest", [0xDF, 0xBF]],
    ["three-byte, lowest", [0xE0, 0xA0, 0x80]],
    ["three-byte 日", [0xE6, 0x97, 0xA5]],
    ["just below the surrogates", [0xED, 0x9F, 0xBF]],
    ["just above the surrogates", [0xEE, 0x80, 0x80]],
    ["three-byte, highest", [0xEF, 0xBF, 0xBF]],
    ["four-byte, lowest", [0xF0, 0x90, 0x80, 0x80]],
    ["four-byte 😀", [0xF0, 0x9F, 0x98, 0x80]],
    ["four-byte, highest U+10FFFF", [0xF4, 0x8F, 0xBF, 0xBF]],
  ];
  for (const [label, body] of good) {
    if (!hostAccepts(new Uint8Array(body))) {
      throw new Error(`${label}: the host rejects these bytes — bad test case`);
    }
    const err = await errorOfBytes(doc(...body));
    if (err !== ERR.NONE) throw new Error(`${label}: rejected with code ${err}`);
  }
});

Deno.test("utf8: multi-byte content survives the round trip intact", async () => {
  // Validation must not disturb the bytes it passes through.
  const src = '{"日本":"café 😀","k":"ÿĀ"}';
  const got = await canon(src);
  if (got.err !== ERR.NONE) throw new Error(`rejected with code ${got.err}`);
  const want = JSON.stringify(JSON.parse(src));
  if (got.text !== want) throw new Error(`got ${got.text}, want ${want}`);
});

Deno.test("utf8: random byte sequences agree with a strict decoder", async () => {
  // The real check. Random bytes weighted towards lead and continuation ranges,
  // so most sequences are nearly-valid rather than obviously junk — that is where
  // an off-by-one in a range bound lives.
  let seed = 0x6d2b79f5;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed;
  };
  const pick = (): number => {
    const r = next() % 100;
    if (r < 30) return 0x80 + (next() % 0x40);   // continuation range
    if (r < 60) return 0xC0 + (next() % 0x40);   // lead range, valid and not
    if (r < 80) return next() % 0x80;            // ASCII
    return next() % 0x100;                        // anything
  };

  const disagreements: string[] = [];
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const len = 1 + (next() % 5);
    const body: number[] = [];
    for (let j = 0; j < len; j++) body.push(pick());
    // A quote or a backslash would end the string or start an escape, and a
    // control byte has its own error; none of those are this test's subject.
    if (body.some(b => b === 0x22 || b === 0x5C || b < 0x20)) continue;
    checked++;

    const want = hostAccepts(new Uint8Array(body));
    const err = await errorOfBytes(doc(...body));
    const got = err === ERR.NONE;
    if (got !== want) {
      disagreements.push(
        `[${body.map(b => b.toString(16).padStart(2, "0")).join(" ")}] ` +
        `host ${want ? "accepts" : "rejects"}, wac ${got ? "accepts" : `rejects(${err})`}`);
      if (disagreements.length > 15) break;
    }
  }
  if (disagreements.length) {
    throw new Error(`${disagreements.length} of ${checked} disagreed:\n  ${disagreements.join("\n  ")}`);
  }
  console.log(`  ${checked} random sequences agreed with the host decoder`);
});
