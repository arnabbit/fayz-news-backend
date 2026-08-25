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

module.exports = {
  EDITION_TIME_ZONE,
  editionDateKey,
  editionDateLabel,
};
