// Periods: the ids `/api/v2/periods/:id` accepts and the calendar ranges they
// cover. Ported from the app's `src/lib/period.ts`, which had it first.
//
// **Only the arithmetic is here.** The app's module also names periods
// ("August 2026", "24–30 August") and buckets a loaded archive into them; both
// are presentation the app owns, and the period response carries no label, so
// porting them would put the same copy in two repositories with nothing holding
// them equal. `dek.js` states the same rule for the same reason. What is shared
// is the arithmetic, and `test/period-agreement.json` — generated from the app's
// module — is what holds the two implementations to the same answers.
//
// **Every date operation is on IST calendar digits.** `Date.UTC` plus the
// `getUTC*` readers is arithmetic on the digits themselves, never a timezone
// conversion. Nothing here builds a Date from a string and reads it back in
// local time: that is the exact bug that filed a third of all late-night
// stories under the previous day, and cost a re-dating backfill of 310
// documents and every affected article id.

// The paper cannot have published outside this, and an id outside it is a typo
// rather than a period.
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

const DAY_MS = 86400000;

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// A calendar date as a number of milliseconds. Arithmetic, not a conversion.
const utc = (y, m, d) => Date.UTC(y, m - 1, d);

function fromUtc(ms) {
  const at = new Date(ms);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

function isoDate(ms) {
  const { y, m, d } = fromUtc(ms);
  return iso(y, m, d);
}

// ISO weekday: Monday 1 through Sunday 7.
function isoWeekday(y, m, d) {
  const day = new Date(utc(y, m, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

// The Monday of ISO week 1 of a year — the week containing 4 January.
function isoWeek1Monday(year) {
  return utc(year, 1, 4) - (isoWeekday(year, 1, 4) - 1) * DAY_MS;
}

// How many ISO weeks a year has: 52, or 53 when it reaches that far.
function isoWeeksInYear(year) {
  return Math.round((isoWeek1Monday(year + 1) - isoWeek1Monday(year)) / (7 * DAY_MS));
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value));
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

const inYearRange = y => y >= MIN_YEAR && y <= MAX_YEAR;

// `2026-W35`, `2026-08`, `2026-Q3` or `2026`, into a kind and an inclusive
// calendar range. `null` for anything malformed or out of range, which the
// endpoint answers as a 404.
//
// Deliberately strict about shape: `2026-W5` and `2026-8` are refused rather
// than guessed at. A lenient parser would let two different strings name one
// period, and both the app's cache and this endpoint's would then hold it twice.
function parsePeriodId(id) {
  const value = String(id == null ? '' : id);

  const week = /^(\d{4})-W(\d{2})$/.exec(value);
  if (week) {
    const y = Number(week[1]);
    const n = Number(week[2]);
    if (!inYearRange(y) || n < 1 || n > isoWeeksInYear(y)) return null;
    const monday = isoWeek1Monday(y) + (n - 1) * 7 * DAY_MS;
    return {
      id: value,
      kind: 'week',
      range: { from: isoDate(monday), to: isoDate(monday + 6 * DAY_MS) },
    };
  }

  const quarter = /^(\d{4})-Q([1-4])$/.exec(value);
  if (quarter) {
    const y = Number(quarter[1]);
    const q = Number(quarter[2]);
    if (!inYearRange(y)) return null;
    const first = q * 3 - 2;
    const last = q * 3;
    return {
      id: value,
      kind: 'quarter',
      range: { from: iso(y, first, 1), to: iso(y, last, daysInMonth(y, last)) },
    };
  }

  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (!inYearRange(y) || m < 1 || m > 12) return null;
    return {
      id: value,
      kind: 'month',
      range: { from: iso(y, m, 1), to: iso(y, m, daysInMonth(y, m)) },
    };
  }

  const year = /^(\d{4})$/.exec(value);
  if (year) {
    const y = Number(year[1]);
    if (!inYearRange(y)) return null;
    return { id: value, kind: 'year', range: { from: iso(y, 1, 1), to: iso(y, 12, 31) } };
  }

  return null;
}

// Which period of a given kind a date falls in.
//
// The week case is the one with a trap in it: a date in early January can
// belong to the *previous* ISO year's last week, and one in late December to
// the next ISO year's first. The Thursday of the date's own week decides, which
// is the definition rather than a correction to it.
function periodIdFor(date, kind) {
  const p = parseDate(date);
  if (!p || !inYearRange(p.y)) return null;

  if (kind === 'year') return String(p.y);
  if (kind === 'month') return `${p.y}-${pad(p.m)}`;
  if (kind === 'quarter') return `${p.y}-Q${Math.floor((p.m - 1) / 3) + 1}`;
  if (kind !== 'week') return null;

  const thursday = utc(p.y, p.m, p.d) + (4 - isoWeekday(p.y, p.m, p.d)) * DAY_MS;
  const isoYear = fromUtc(thursday).y;
  const week = Math.round((thursday - isoWeek1Monday(isoYear)) / (7 * DAY_MS)) + 1;
  return `${isoYear}-W${pad(week)}`;
}

// Whether a date falls inside a period. ISO dates sort lexicographically, which
// is the cheapest correct comparison there is.
function isWithin(date, range) {
  return date >= range.from && date <= range.to;
}

// Every day in a range, inclusive — the timeline's spine, so a day with no
// edition is a tick rather than a gap.
function daysBetween(range) {
  const from = parseDate(range.from);
  const to = parseDate(range.to);
  if (!from || !to) return [];
  const days = [];
  for (let ms = utc(from.y, from.m, from.d); ms <= utc(to.y, to.m, to.d); ms += DAY_MS) {
    days.push(isoDate(ms));
  }
  return days;
}

// IST is UTC+5:30 with no daylight saving, ever. A fixed offset is arithmetic,
// not the timezone conversion the house rule forbids — what that rule bans is
// reading a *date string* back through the host's zone. `now` is a parameter so
// the boundary is testable at a time other than whenever the suite runs.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istDate(now) {
  const { y, m, d } = fromUtc(now + IST_OFFSET_MS);
  return iso(y, m, d);
}

module.exports = {
  MIN_YEAR,
  MAX_YEAR,
  daysInMonth,
  parsePeriodId,
  periodIdFor,
  isWithin,
  daysBetween,
  istDate,
};
