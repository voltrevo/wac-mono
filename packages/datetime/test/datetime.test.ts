// The civil calendar and RFC 3339, judged against `Date`.
//
// `Date` is an exact oracle for both halves, in UTC:
//
//   - `Date.UTC(y, m - 1, d)` is the epoch millisecond for a civil date, so the day-number
//     arithmetic can be checked directly rather than by round-tripping it against itself;
//   - `new Date(ms).toISOString()` produces exactly the format `format` produces, so formatting
//     is a string comparison;
//   - `Date.parse` implements the ES subset of ISO 8601, which contains RFC 3339's date-times.
//
// Round-tripping alone would not do: an encoder and decoder that are wrong in opposite ways
// round-trip perfectly, and the day-number formula is exactly the kind of thing that goes wrong
// symmetrically. Every test here compares against `Date`, and the round-trip is extra.
//
// `Date` is only reliable within ±100 000 000 days of the epoch, so year coverage stops around
// ±275 760. The formula has no such limit and the tests say where the checking stops.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/datetime/test/probe.wac") as unknown as {
  toDays(y: number, m: number, d: number): bigint;
  fromDaysYear(days: bigint): number;
  fromDaysMonth(days: bigint): number;
  fromDaysDay(days: bigint): number;
  dayOfWeek(days: bigint): number;
  leap(y: number): boolean;
  monthLength(y: number, m: number): number;
  validDate(y: number, m: number, d: number): boolean;
  yearDay(y: number, m: number, d: number): number;
  accepts(s: Uint8Array): boolean;
  parseMillis(s: Uint8Array): bigint;
  parseOffset(s: Uint8Array): number;
  parseOffsetKnown(s: Uint8Array): number;
  formatMillis(ms: bigint): Uint8Array;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string): Uint8Array => enc.encode(s);

const DAY_MS = 86400000;

Deno.test("day numbers agree with Date.UTC over four centuries", () => {
  // Every day from 1600 to 2400, which covers all four leap-year rules many times over —
  // including 1700, 1800 and 1900 (not leap) and 1600, 2000, 2400 (leap).
  const start = Date.UTC(1600, 0, 1) / DAY_MS;
  const end = Date.UTC(2400, 0, 1) / DAY_MS;
  let checked = 0;
  for (let dayNum = start; dayNum < end; dayNum++) {
    const d = new Date(dayNum * DAY_MS);
    const got = mod.toDays(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (got !== BigInt(dayNum)) {
      throw new Error(`${d.toISOString().slice(0, 10)}: got day ${got}, Date says ${dayNum}`);
    }
    checked++;
  }
  if (checked < 290000) throw new Error(`only checked ${checked} days`);
});

Deno.test("civilFromDays inverts daysFromCivil over the same range", () => {
  const start = Date.UTC(1600, 0, 1) / DAY_MS;
  const end = Date.UTC(2400, 0, 1) / DAY_MS;
  for (let dayNum = start; dayNum < end; dayNum++) {
    const d = new Date(dayNum * DAY_MS);
    const n = BigInt(dayNum);
    const y = mod.fromDaysYear(n);
    const m = mod.fromDaysMonth(n);
    const day = mod.fromDaysDay(n);
    if (y !== d.getUTCFullYear() || m !== d.getUTCMonth() + 1 || day !== d.getUTCDate()) {
      throw new Error(
        `day ${dayNum}: got ${y}-${m}-${day}, Date says ${d.toISOString().slice(0, 10)}`,
      );
    }
  }
});

Deno.test("the far past and far future, where Date still works", () => {
  // Well outside the range anything realistic uses, and where a formula that quietly assumed a
  // positive year would break. Year 1 and the BCE side included.
  const cases: Array<[number, number, number]> = [];
  for (const y of [-271820, -100000, -4713, -1, 0, 1, 100, 1000, 1969, 1970, 1971, 2100, 100000, 275759]) {
    for (const [m, d] of [[1, 1], [2, 28], [3, 1], [12, 31]] as Array<[number, number]>) {
      cases.push([y, m, d]);
    }
  }
  for (const [y, m, d] of cases) {
    const want = Date.UTC(y, m - 1, d);
    // Date.UTC maps years 0-99 to 1900-1999; use setUTCFullYear to say what we mean.
    const fixed = new Date(0);
    fixed.setUTCFullYear(y, m - 1, d);
    fixed.setUTCHours(0, 0, 0, 0);
    const wantDays = Math.floor(fixed.getTime() / DAY_MS);
    if (!Number.isFinite(wantDays)) continue;
    const got = mod.toDays(y, m, d);
    if (got !== BigInt(wantDays)) {
      throw new Error(`${y}-${m}-${d}: got ${got}, Date says ${wantDays} (raw UTC ${want})`);
    }
    const back = [mod.fromDaysYear(got), mod.fromDaysMonth(got), mod.fromDaysDay(got)];
    if (back[0] !== y || back[1] !== m || back[2] !== d) {
      throw new Error(`${y}-${m}-${d} round-tripped to ${back.join("-")}`);
    }
  }
});

Deno.test("weekday agrees with Date", () => {
  const start = Date.UTC(1800, 0, 1) / DAY_MS;
  const end = Date.UTC(2200, 0, 1) / DAY_MS;
  for (let dayNum = start; dayNum < end; dayNum += 1) {
    const want = new Date(dayNum * DAY_MS).getUTCDay();
    const got = mod.dayOfWeek(BigInt(dayNum));
    if (got !== want) throw new Error(`day ${dayNum}: weekday ${got}, Date says ${want}`);
  }
});

Deno.test("leap years and month lengths", () => {
  for (let y = -2000; y <= 4000; y++) {
    // The oracle: February has 29 days in a leap year, and Date knows.
    const feb = new Date(0);
    feb.setUTCFullYear(y, 1, 29);
    feb.setUTCHours(0, 0, 0, 0);
    const isLeap = feb.getUTCMonth() === 1;
    if (mod.leap(y) !== isLeap) throw new Error(`${y}: leap ${mod.leap(y)}, Date says ${isLeap}`);
    if (mod.monthLength(y, 2) !== (isLeap ? 29 : 28)) throw new Error(`${y}: February length wrong`);
    for (let m = 1; m <= 12; m++) {
      const next = new Date(0);
      next.setUTCFullYear(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
      next.setUTCHours(0, 0, 0, 0);
      const first = new Date(0);
      first.setUTCFullYear(y, m - 1, 1);
      first.setUTCHours(0, 0, 0, 0);
      const want = Math.round((next.getTime() - first.getTime()) / DAY_MS);
      if (mod.monthLength(y, m) !== want) {
        throw new Error(`${y}-${m}: length ${mod.monthLength(y, m)}, Date says ${want}`);
      }
    }
  }
});

Deno.test("day of year agrees with Date", () => {
  for (const y of [1900, 1970, 1999, 2000, 2001, 2020, 2024, 2100]) {
    for (let m = 1; m <= 12; m++) {
      for (const d of [1, 15, mod.monthLength(y, m)]) {
        const first = Date.UTC(y, 0, 1);
        const here = Date.UTC(y, m - 1, d);
        const want = Math.round((here - first) / DAY_MS) + 1;
        const got = mod.yearDay(y, m, d);
        if (got !== want) throw new Error(`${y}-${m}-${d}: day of year ${got}, want ${want}`);
      }
    }
  }
});

Deno.test("invalid dates are rejected", () => {
  const bad: string[] = [];
  for (
    const [y, m, d] of [
      [2020, 0, 1], [2020, 13, 1], [2020, 1, 0], [2020, 1, 32], [2020, 2, 30],
      [2019, 2, 29], [1900, 2, 29], [2020, 4, 31], [2020, 6, 31], [2020, 9, 31], [2020, 11, 31],
    ] as Array<[number, number, number]>
  ) {
    if (mod.validDate(y, m, d)) bad.push(`${y}-${m}-${d} was accepted`);
  }
  for (
    const [y, m, d] of [
      [2020, 2, 29], [2000, 2, 29], [1900, 2, 28], [2020, 1, 31], [2020, 4, 30],
    ] as Array<[number, number, number]>
  ) {
    if (!mod.validDate(y, m, d)) bad.push(`${y}-${m}-${d} was rejected`);
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("format matches Date.toISOString", () => {
  const cases: bigint[] = [0n, 1n, -1n, 999n, 1000n, -1000n, -999n];
  // Every hour of a day either side of the epoch, where the floor-division cases live.
  for (let h = -48; h <= 48; h++) cases.push(BigInt(h) * 3600000n);
  // And a spread across the whole range Date supports.
  let x = 0x1f2e3d4c | 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  for (let i = 0; i < 20000; i++) {
    const ms = BigInt(next() % 4000000) * 100000n - 200000000000n;
    cases.push(ms);
  }
  // Outside 0000..9999, where the year needs a sign and six digits. The random spread above cannot
  // reach here — it covers about 1963 to 1976 — so a four-digit year that silently took the value
  // modulo ten thousand passed for as long as it existed: year 10000 printed `0000`.
  // GitHub wac-mono#1.
  cases.push(
    253402300800000n,   // +010000-01-01, the first year that needs the expanded form
    253402300799999n,   // and the last that does not
    -62167219200000n,   // 0000-01-01
    -62167219200001n,   // -000001-12-31, one millisecond before year zero
    8640000000000000n,  // +275760-09-13, the largest instant Date supports
    -8640000000000000n, // -271821-04-20, the smallest
  );

  for (const ms of cases) {
    const want = new Date(Number(ms)).toISOString();
    const got = dec.decode(mod.formatMillis(ms));
    if (got !== want) throw new Error(`${ms}: got ${got}, Date says ${want}`);
  }
});

Deno.test("parse matches Date.parse", () => {
  const stamps: string[] = [
    "1970-01-01T00:00:00Z",
    "1970-01-01T00:00:00.000Z",
    "2020-02-29T12:34:56Z",
    "1999-12-31T23:59:59.999Z",
    "2000-01-01T00:00:00+00:00",
    "2020-06-15T10:00:00+05:30",
    "2020-06-15T10:00:00-08:00",
    "2020-06-15T10:00:00.5Z",
    "2020-06-15T10:00:00.25Z",
    "2020-06-15T10:00:00.125Z",
    "2020-06-15T10:00:00.123456789Z",
    "1969-07-20T20:17:00Z",
    "1900-01-01T00:00:00Z",
    "2100-12-31T23:59:59Z",
    "2020-06-15t10:00:00z",
    "2020-01-01T00:00:00+23:59",
    "2020-01-01T00:00:00-23:59",
  ];
  for (const s of stamps) {
    const want = Date.parse(s);
    if (Number.isNaN(want)) throw new Error(`the oracle rejected ${s}, so it is a bad test case`);
    const got = mod.parseMillis(b(s));
    if (!mod.accepts(b(s))) throw new Error(`${s} was rejected`);
    if (got !== BigInt(want)) throw new Error(`${s}: got ${got}, Date.parse says ${want}`);
  }
});

Deno.test("the offset is kept, since the instant does not carry it", () => {
  // `+05:30` and `Z` can name the same instant, and a formatter that only has the instant cannot
  // tell you which was written. That is why `parse` reports the offset separately.
  const bad: string[] = [];
  for (
    const [s, mins] of [
      ["2020-01-01T00:00:00Z", 0],
      ["2020-01-01T00:00:00+00:00", 0],
      ["2020-01-01T00:00:00+05:30", 330],
      ["2020-01-01T00:00:00-08:00", -480],
      ["2020-01-01T00:00:00-00:30", -30],
    ] as Array<[string, number]>
  ) {
    const got = mod.parseOffset(b(s));
    if (got !== mins) bad.push(`${s}: offset ${got}, want ${mins}`);
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("malformed timestamps are rejected", () => {
  const bad: string[] = [];
  for (
    const s of [
      "", "2020", "2020-01", "2020-01-01", "2020-01-01T00:00", "2020-01-01T00:00:00",
      "2020-1-01T00:00:00Z", "2020-01-1T00:00:00Z", "20-01-01T00:00:00Z",
      "2020/01/01T00:00:00Z", "2020-01-01X00:00:00Z", "2020-01-01T00-00-00Z",
      "2020-13-01T00:00:00Z", "2020-00-01T00:00:00Z", "2020-01-32T00:00:00Z",
      "2020-02-30T00:00:00Z", "2019-02-29T00:00:00Z",
      "2020-01-01T24:00:00Z", "2020-01-01T00:60:00Z",
      "2020-01-01T00:00:00", "2020-01-01T00:00:00+5:30", "2020-01-01T00:00:00+0530",
      "2020-01-01T00:00:00+24:00", "2020-01-01T00:00:00+00:60",
      "2020-01-01T00:00:00.Z", "2020-01-01T00:00:00Z ", " 2020-01-01T00:00:00Z",
      "2020-01-01T00:00:00Zx", "2020-01-01T00:00:00.5", "2020-01-01T00:00:00.5+",
      // A non-digit in each numeric field in turn, since each has its own rejection.
      "2020-0x-01T00:00:00Z", "2020-01-0xT00:00:00Z", "2020-01-01T00:0x:00Z", "2020-01-01T00:00:0xZ", "2020-01-01T00:00:00+00:0x", "2020-01-01T00:00:00+0x:00",
    ]
  ) {
    if (mod.accepts(b(s))) bad.push(`accepted ${JSON.stringify(s)}`);
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("known divergence: a leap second is rejected", () => {
  // RFC 3339 §5.7 allows `60` in the seconds field. Representing it faithfully needs a
  // leap-second table that has to be maintained by hand; mapping it onto :59 or the next day is
  // silently wrong. Asserted, so that if it is ever implemented this says the note can go.
  const leapSeconds = ["2016-12-31T23:59:60Z", "2015-06-30T23:59:60Z"];
  for (const s of leapSeconds) {
    if (mod.accepts(b(s))) {
      throw new Error(`${s} was accepted, so leap seconds may now be supported`);
    }
    // The oracle rejects them too, for its own reasons, so this is not a case where the platform
    // could have served as the answer.
    if (!Number.isNaN(Date.parse(s))) {
      throw new Error(`Date.parse now accepts ${s}, so it could be the oracle after all`);
    }
  }
});

Deno.test("parse and format round-trip", () => {
  let x = 0x77aa55cc | 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  for (let i = 0; i < 20000; i++) {
    const ms = BigInt(next() % 4000000) * 100000n - 200000000000n;
    const text = mod.formatMillis(ms);
    if (!mod.accepts(text)) throw new Error(`${dec.decode(text)} did not parse back`);
    const back = mod.parseMillis(text);
    if (back !== ms) throw new Error(`${dec.decode(text)}: parsed back as ${back}, want ${ms}`);
  }
});

Deno.test("-00:00 is an unknown offset, not zero", () => {
  // RFC 3339 §4.3: `-00:00` says the instant is known and the local offset is not. `Z` and `+00:00`
  // both assert zero. All three used to arrive as offsetMin == 0 and were indistinguishable, so the
  // one thing `offsetMin` exists to preserve was the thing lost. GitHub wac-mono#15.
  const enc = new TextEncoder();
  const known = (s: string) => mod.parseOffsetKnown(enc.encode(s));
  const offset = (s: string) => mod.parseOffset(enc.encode(s));

  if (known("1970-01-01T00:00:00-00:00") !== 0) throw new Error("-00:00 should be unknown");
  if (known("1970-01-01T00:00:00+00:00") !== 1) throw new Error("+00:00 asserts zero");
  if (known("1970-01-01T00:00:00Z") !== 1) throw new Error("Z asserts zero");
  if (known("1970-01-01T00:00:00+05:30") !== 1) throw new Error("a real offset is known");

  // And all of them still describe the same instant, which is the part that was never wrong.
  for (const s of ["1970-01-01T00:00:00-00:00", "1970-01-01T00:00:00+00:00", "1970-01-01T00:00:00Z"]) {
    if (offset(s) !== 0) throw new Error(`${s}: offset should be 0, got ${offset(s)}`);
  }
});
