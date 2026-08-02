// Directory refresh scheduling and expiry.
//
// The refresh *time* is worth testing because getting it wrong is not a crash: fetch too
// late and the client runs on an expired consensus, fetch at a fixed offset and every client
// hits the caches together, which is both a herd and a fingerprint.

import { refreshAt, validUntil } from "../host/dirclient.ts";

function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  got:  ${got}\n  want: ${want}`);
  }
}

const doc = (after: string, fresh: string, until: string) =>
  `network-status-version 3\nvalid-after ${after}\nfresh-until ${fresh}\nvalid-until ${until}\n`;

// A typical hour-long consensus: fresh for one hour, valid for three.
const HOURLY = doc("2026-08-02 10:00:00", "2026-08-02 11:00:00", "2026-08-02 13:00:00");
const FRESH = Date.UTC(2026, 7, 2, 11, 0, 0) / 1000;
const VALID = Date.UTC(2026, 7, 2, 13, 0, 0) / 1000;

Deno.test("valid-until is read as UTC, not as local time", () => {
  // The directory's timestamps carry no zone. Handing them to `new Date()` reads them as
  // local, which shifts every validity window by the host's offset — silently, and
  // differently on different machines.
  assertEquals(validUntil(HOURLY), VALID);
});

Deno.test("the refresh window opens at fresh-until and leaves a quarter of the slack", () => {
  assertEquals(refreshAt(HOURLY, () => 0), FRESH, "at the very start of the window");
  const latest = refreshAt(HOURLY, () => 0.999999)!;
  assert(latest < VALID, "and never later than the consensus is valid");
  const span = VALID - FRESH;
  assert(
    latest <= FRESH + span * 0.75,
    "the last quarter of the interval is left as slack, so a failed download can be " +
      "retried before anything expires",
  );
});

Deno.test("the refresh time is spread across the window, not fixed", () => {
  // Every client refreshing at the same instant is a thundering herd on the caches and a
  // fingerprint on the client — downloading at a distinctive moment is distinguishing.
  const times = new Set<number>();
  for (let i = 0; i < 20; i++) times.add(refreshAt(HOURLY, () => i / 20)!);
  assert(times.size > 15, `expected a spread of refresh times, got ${times.size} distinct`);
  for (const t of times) {
    assert(t >= FRESH && t < VALID, `${t} is outside the window`);
  }
});

Deno.test("a consensus with no schedule gives no refresh time rather than a guessed one", () => {
  assertEquals(refreshAt("network-status-version 3\n"), null);
  assertEquals(refreshAt(doc("2026-08-02 10:00:00", "2026-08-02 11:00:00", "x")), null);
  // fresh-until after valid-until is nonsense; refusing beats computing a negative window.
  assertEquals(
    refreshAt(doc("2026-08-02 10:00:00", "2026-08-02 13:00:00", "2026-08-02 11:00:00")),
    null,
  );
});

Deno.test("a short-lived consensus still gets a window inside its life", () => {
  // Chutney's are forty seconds long, and that is the case where an off-by-a-factor in the
  // window arithmetic shows up as a refresh scheduled after expiry.
  const short = doc("2026-08-02 10:00:00", "2026-08-02 10:00:20", "2026-08-02 10:00:40");
  const open = Date.UTC(2026, 7, 2, 10, 0, 20) / 1000;
  const close = Date.UTC(2026, 7, 2, 10, 0, 40) / 1000;
  for (let i = 0; i <= 10; i++) {
    const t = refreshAt(short, () => i / 10)!;
    assert(t >= open && t < close, `refresh at ${t} is outside [${open}, ${close})`);
  }
});
