// What a new-edition notification says, kept pure so the copy is testable
// without a device, a network or a token.
//
// **No headline.** Article order is newest-inserted-first, which is arbitrary —
// there is no importance signal anywhere in the data — so naming one story
// would present a random article as *the* story of the day, every day. The
// count is the one thing that is both true and interesting.

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

// `_dateKey` is already an IST calendar date (see editionDate.js), so the
// weekday is arithmetic on its digits and never a timezone conversion.
// `Date.UTC` + `getUTCDay` is the arithmetic; a local-time constructor here
// would name Saturday's edition Friday for anyone west of Greenwich.
function weekdayOf(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return null;
  const [, y, m, d] = match;
  const at = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  // Round-tripped, so 2026-02-30 is refused rather than silently becoming March.
  if (at.getUTCFullYear() !== Number(y) || at.getUTCMonth() !== Number(m) - 1
      || at.getUTCDate() !== Number(d)) {
    return null;
  }
  return WEEKDAYS[at.getUTCDay()];
}

// The payload carries the edition and nothing else — no article id, no URL. The
// app's tap handler prefetches that edition and routes to the feed; a URL would
// be a second routing surface saying the same thing.
function editionNotification(dateKey, count) {
  const weekday = weekdayOf(dateKey);
  if (!weekday) return null;
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return null;
  return {
    title: 'The Chronicle',
    body: `${weekday}'s edition — ${n} ${n === 1 ? 'article' : 'articles'}`,
    data: { edition: dateKey },
  };
}

module.exports = { WEEKDAYS, weekdayOf, editionNotification };
