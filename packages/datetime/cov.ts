// Branch coverage for datetime.
//
// The same exercises the tests run: four centuries of days, the far-out years, the malformed
// timestamps — which are the only things that reach the rejection paths — and a spread of
// instants either side of the epoch, which is where the floor-division cases are.
//
// **That sentence was not true when it was checked.** This file and `test/datetime.test.ts` had drifted
// apart in both directions: the tests reached `padYear`'s expanded form and this did not, and neither of
// them ever called `parseOffsetKnown`. The README said 100% and the tool said 92. Two exercises of the
// same code will drift unless something compares them, and nothing does — so when you add a case to one,
// add it here too, and read the branch report rather than trusting this comment.
//
//   deno task coverage:datetime
//   deno task coverage:datetime --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/datetime/test/probe.wac");
const m = run.mod as unknown as {
  toDays(y: number, mo: number, d: number): bigint;
  fromDaysYear(days: bigint): number;
  fromDaysMonth(days: bigint): number;
  fromDaysDay(days: bigint): number;
  dayOfWeek(days: bigint): number;
  leap(y: number): boolean;
  monthLength(y: number, mo: number): number;
  validDate(y: number, mo: number, d: number): boolean;
  yearDay(y: number, mo: number, d: number): number;
  accepts(s: Uint8Array): boolean;
  parseMillis(s: Uint8Array): bigint;
  parseOffset(s: Uint8Array): number;
  parseOffsetKnown(s: Uint8Array): number;
  formatMillis(ms: bigint): Uint8Array;
};

/** Every day across four centuries, thinned: the branches repeat, the years do not. */
for (const far of [-800000n, -719469n, -719468n, -1000000n, 1000000n]) {
  m.fromDaysYear(far);
  m.fromDaysMonth(far);
  m.fromDaysDay(far);
  m.dayOfWeek(far);
}
for (let dayNum = -135140; dayNum < 157000; dayNum += 7) {
  const n = BigInt(dayNum);
  m.fromDaysYear(n);
  m.fromDaysMonth(n);
  m.fromDaysDay(n);
  m.dayOfWeek(n);
}
for (const y of [-271820, -100000, -4713, -1, 0, 1, 100, 1969, 1970, 1971, 2100, 275759]) {
  for (const mo of [1, 2, 3, 12]) {
    for (const d of [1, 28, 31]) {
      m.toDays(y, mo, d);
      m.validDate(y, mo, d);
      m.yearDay(y, mo, 1);
    }
  }
}
for (let y = 1890; y <= 2110; y++) {
  m.leap(y);
  for (let mo = 1; mo <= 12; mo++) m.monthLength(y, mo);
}
for (
  const [y, mo, d] of [
    [2020, 0, 1], [2020, 13, 1], [2020, 1, 0], [2020, 1, 32], [2020, 2, 30], [2019, 2, 29],
    [2020, 4, 31], [2020, 2, 29],
  ] as Array<[number, number, number]>
) m.validDate(y, mo, d);

let x = 0x1f2e3d4c | 0;
const next = (): number => {
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return x;
};
for (let h = -48; h <= 48; h++) m.formatMillis(BigInt(h) * 3600000n);
for (const ms of [0n, 1n, -1n, 999n, 1000n, -1000n, -999n]) m.formatMillis(ms);
for (let i = 0; i < 5000; i++) {
  const ms = BigInt(next() % 4000000) * 100000n - 200000000000n;
  const text = m.formatMillis(ms);
  m.accepts(text);
  m.parseMillis(text);
}

for (
  const s of [
    "1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000Z", "2020-02-29T12:34:56Z",
    "2000-01-01T00:00:00+00:00", "2020-06-15T10:00:00+05:30", "2020-06-15T10:00:00-08:00",
    "2020-06-15T10:00:00.5Z", "2020-06-15T10:00:00.123456789Z", "2020-06-15t10:00:00z",
    "2020-06-15 10:00:00Z", "2020-01-01T00:00:00+23:59", "2020-01-01T00:00:00-23:59",
    "", "2020", "2020-01", "2020-01-01", "2020-01-01T00:00", "2020-01-01T00:00:00",
    "2020-1-01T00:00:00Z", "2020-01-1T00:00:00Z", "20-01-01T00:00:00Z",
    "2020/01/01T00:00:00Z", "2020-01-01X00:00:00Z", "2020-01-01T00-00-00Z",
    "2020-13-01T00:00:00Z", "2020-00-01T00:00:00Z", "2020-01-32T00:00:00Z",
    "2020-02-30T00:00:00Z", "2019-02-29T00:00:00Z", "2020-01-01T24:00:00Z",
    "2020-01-01T00:60:00Z", "2016-12-31T23:59:60Z", "2020-01-01T00:00:00+5:30",
    "2020-01-01T00:00:00+0530", "2020-01-01T00:00:00+24:00", "2020-01-01T00:00:00+00:60",
    "2020-01-01T00:00:00.Z", "2020-01-01T00:00:00Z ", " 2020-01-01T00:00:00Z",
    "2020-01-01T00:00:00Zx", "2020-01-01T00:00:00.5", "2020-01-01T00:00:00.5+",
    "2020-01-01T00:00:00!00:00", "202x-01-01T00:00:00Z",
    "2020-0x-01T00:00:00Z", "2020-01-0xT00:00:00Z", "2020-01-01T00:0x:00Z", "2020-01-01T00:00:0xZ", "2020-01-01T00:00:00+00:0x", "2020-01-01T00:00:00+0x:00",
  ]
) {
  m.accepts(enc.encode(s));
  m.parseMillis(enc.encode(s));
  m.parseOffset(enc.encode(s));
  m.parseOffsetKnown(enc.encode(s));
}

// `-00:00` against the other two spellings of zero — the branch `offsetKnown` exists for, which nothing
// here reached: this file's header says it runs "the same exercises the tests run" and it had drifted
// out of that. So had the tests, in the other direction, which is how a probe export written for
// GitHub wac-mono#15 came to be called by neither.
for (const s of ["2020-06-15T10:00:00-00:00", "2020-06-15T10:00:00+00:00", "2020-06-15T10:00:00Z"]) {
  m.parseOffsetKnown(enc.encode(s));
}

// Years outside 0000..9999, where `padYear` writes a sign and six digits. The spread above covers about
// 1963 to 1976 and cannot reach it; `test/datetime.test.ts` does reach it, which is exactly the drift
// this file's header denies.
for (
  const ms of [
    253402300800000n,   // +010000-01-01, the first year needing the expanded form
    253402300799999n,   // and the last that does not
    -62167219200000n,   // 0000-01-01
    -62167219200001n,   // -000001-12-31
    8640000000000000n,  // +275760-09-13, the largest instant Date supports
    -8640000000000000n, // -271821-04-20, the smallest
  ]
) {
  m.formatMillis(ms);
}

report([run], "packages/datetime/", { verbose });
