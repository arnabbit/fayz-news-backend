// The edition an article belongs to is an editorial decision, not a property of
// whichever machine happens to run the process. Render runs in UTC, and pushes
// cluster at 18:00-20:00 UTC — 23:30-01:30 IST — so deriving the day from
// server-local time filed a third of all late-night stories under the previous
// day. Every date here is computed in IST explicitly: no reliance on the host
// timezone, and none on the TZ env var either.
const EDITION_TIME_ZONE = 'Asia/Kolkata';

const DATE_KEY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: EDITION_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

const DATE_LABEL_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: EDITION_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric'
});

const MIN_EDITION_YEAR = 1900;
const MAX_EDITION_YEAR = 2999;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function daysInMonth(year, month) {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// Parse calendar digits directly. Turning a YYYY-MM-DD string into a Date first
// would let the host timezone move it to an adjacent day.
function parseEditionDateKey(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_EDITION_YEAR || year > MAX_EDITION_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function editionDateLabelFromKey(dateKey) {
  const parsed = parseEditionDateKey(dateKey);
  if (!parsed) return null;
  return `${MONTH_NAMES[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
}

// YYYY-MM-DD, the `_dateKey` form. Assembled from the parts rather than from a
// locale's formatted string, so the field order can't depend on ICU's idea of
// how en-CA writes a date.
function editionDateKey(date = new Date()) {
  const parts = {};
  for (const part of DATE_KEY_FORMAT.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The `published_date` form, e.g. "March 25, 2026".
function editionDateLabel(date = new Date()) {
  return DATE_LABEL_FORMAT.format(date);
}

// Resolve the optional date accepted by POST /api/articles. Omitting it keeps
// old clients on today's IST edition; providing it is an explicit filing
// decision and therefore strict. Future editions are never accepted.
function resolveEditionDate(requestedDate, now = new Date()) {
  const currentDateKey = editionDateKey(now);
  if (requestedDate === undefined) {
    return {
      dateKey: currentDateKey,
      dateLabel: editionDateLabel(now),
      currentDateKey,
      historical: false,
    };
  }

  const parsed = parseEditionDateKey(requestedDate);
  if (!parsed || requestedDate > currentDateKey) return null;
  return {
    dateKey: requestedDate,
    dateLabel: editionDateLabelFromKey(requestedDate),
    currentDateKey,
    historical: requestedDate < currentDateKey,
  };
}

module.exports = {
  EDITION_TIME_ZONE,
  MIN_EDITION_YEAR,
  MAX_EDITION_YEAR,
  editionDateKey,
  editionDateLabel,
  parseEditionDateKey,
  editionDateLabelFromKey,
  resolveEditionDate,
};
