# datetime

The proleptic Gregorian calendar, and RFC 3339 timestamps.

```wac
import { daysFromCivil, civilFromDays, Civil, weekday } from "../../datetime/src/civil.wac";
import { Parsed, parse, format } from "../../datetime/src/rfc3339.wac";

Parsed p = parse("2020-06-15T10:00:00+05:30".toBytes());
u8[] iso = format(p.millis);              // "2020-06-15T04:30:00.000Z"
Civil c = civilFromDays(p.millis / 86400000);
```

## Why it is a package

Because `Date` is an exact oracle in UTC, and for both halves independently. `Date.UTC(y, m-1, d)`
gives the epoch millisecond for a civil date, so the day-number arithmetic can be checked
*directly* rather than by round-tripping it against itself — which matters, because an encoder and
decoder wrong in opposite ways round-trip perfectly, and a calendar formula is exactly the kind of
thing that goes wrong symmetrically. `toISOString` produces the format `format` produces, so
formatting is a string comparison. `Date.parse` implements the ES subset of ISO 8601, which
contains RFC 3339's date-times.

The tests compare every day from 1600 to 2400 — about 292 000 of them — in both directions, plus
weekdays across four centuries and leap years from 2000 BCE to 4000 CE.

## Shape

**Hinnant's algorithms, no tables and no loops.** The trick is to shift the year so March is month
0. That puts the leap day at the *end* of the year, which makes the month-length pattern a single
linear formula — `(153*m + 2) / 5` — instead of a twelve-entry table with a special case, and
makes a 400-year era start on a fixed day. Exact for any year an `i32` holds, including negative
ones, which is where a formula that quietly assumed a positive year would break.

**Everything is UTC and civil.** No time zones and no `Local`: a day is exactly 86 400 seconds,
which is what makes epoch arithmetic reversible. A time zone database is a different package with
a different problem — it is data, updated several times a year, not arithmetic.

**RFC 3339, not ISO 8601.** ISO 8601 admits week dates, ordinal dates, two-digit years, comma
decimal separators and omitted separators. A parser that accepts all of them accepts a great deal
nobody meant to write, and `2020-W01-1` in a log file is more likely to be a bug than an
intention. RFC 3339 is the strict profile everything on the wire actually uses.

Trailing input is a rejection, which is worth saying because it is the common shortcut: a parser
that stops at the offset and ignores the rest accepts a truncated timestamp glued to whatever
followed it.

**Fractional seconds truncate, never round.** Rounding can move a timestamp into the next second,
and the RFC gives no licence to do that.

## Known divergence: leap seconds

RFC 3339 §5.7 permits `60` in the seconds field. This rejects it.

Representing one faithfully needs a leap-second table, which is maintained by hand, goes stale,
and would have to ship with the package. The alternatives are worse: mapping `:60` onto `:59`
makes two distinct instants equal, and mapping it onto the next second makes a timestamp that is
not what was written. Rejecting says so at the point of use.

Asserted in the tests rather than written down here alone — including that `Date.parse` rejects
them too, so this is not a case where the platform could have supplied the answer.

## Tests

`test/datetime.test.ts`, all against `Date`:

| what | how much |
|---|---|
| day number ↔ civil date | every day, 1600–2400, both directions |
| weekday | every day, 1800–2200 |
| leap years and month lengths | every year, −2000 to 4000, every month |
| far past and future | −271820 to 275759, the limits of `Date` itself |
| `format` | 20 000 random instants plus every hour either side of the epoch |
| `parse` | the RFC's shapes, offsets, fractional digits, lowercase `t`/`z` |
| `-00:00` | the unknown-offset spelling, against `Z` and `+00:00` — checked against the RFC, since `Date` maps all three to one instant and keeps nothing |
| rejection | 40 malformed timestamps, including a non-digit in each numeric field in turn |

`deno task coverage:datetime` reports 100% — and did not when that line was last checked. It said 92%,
because `cov.ts` and `test/datetime.test.ts` are two exercises of the same code and had drifted apart in
both directions: the tests reached `padYear`'s expanded years and `cov.ts` did not, and **neither of them
ever called `parseOffsetKnown`** — a probe export written for GitHub wac-mono#15, with a nine-line
rationale on the field it reports, called by nothing. A number in prose cannot fail; run the task.

## Not here yet

- **Time zones.** See above: data, not arithmetic.
- **Durations and arithmetic on dates** — "one month later", which is only well defined once you
  decide what 31 January plus a month is. Worth having, worth deciding deliberately.
- **ISO week dates** (`2020-W01-1`), which are a different calendar with their own year boundary.
- **Formatting other than RFC 3339.** A `strftime` needs a format-string parser and a locale
  story, and the locale story is where that stops being a small package.
