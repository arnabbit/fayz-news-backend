// The period story's progress rules: which runs are due, and the guarded
// updates that store a run. Pure: no database, no network. storyCatchUp.js
// reads the rows, makes the calls and applies these updates.
//
//   periodStories { periodId (unique), sections: [{ date, entries[], writtenAt, model }],
//                   admitted: [threadId], throughDate, seenUpTo, attempts: { <date>: n },
//                   late: [{ through, after }] | null }
//   throughDate   the last run date that has completed
//   seenUpTo      the newest articles._createdAt the last run read. A later
//                 filing into a date already run is how a late article is seen
//   late          which articles are late filings still owed a run dated
//                 today: per mark, filed into a date up to `through` after
//                 `after`.
//                 Stored by an edition run that leaves them out, cleared by
//                 the run dated today that reads them
//
// The guard is the contract. A store matches only the throughDate and the
// section count it read, so a retried or doubled run cannot add twice. Only
// the section dated today may be replaced; an earlier one is never addressed.
//
// Dates are IST `YYYY-MM-DD` strings and compare as strings.

const { admittedThreads } = require('./story');
const { addDays } = require('./period');

// Editions this many days after a period's last day still count for it.
const GRACE_DAYS = 3;
// Then the date is skipped: throughDate moves past it. Its articles still
// reach later runs as evidence.
const MAX_ATTEMPTS = 3;

// What one run did: stored a section after the last one, stored one over
// today's, stored none, spent its attempts, or lost the race to another writer.
const OUTCOME = Object.freeze({
  APPENDED: 'appended',
  REPLACED: 'replaced',
  NONE: 'none',
  SKIPPED: 'skipped',
  LOST: 'lost',
});

const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

// A time as epoch milliseconds, or null when it is missing or not a time.
function toMillis(value) {
  if (value === null || value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// The later of two times as a Date, or null when neither is a time.
function laterDate(a, b) {
  const x = toMillis(a);
  const y = toMillis(b);
  if (x === null) return y === null ? null : new Date(y);
  if (y === null) return new Date(x);
  return new Date(Math.max(x, y));
}

// The editions a period's story reads: its own days and the grace window
// after them, never past today.
function storyWindow(period, today) {
  return { from: period.range.from, to: minDate(addDays(period.range.to, GRACE_DAYS), today) };
}

// Article rows `{ _dateKey, _createdAt }` to one entry per edition, oldest
// first, with the newest filing time on it (null when none is known).
function editionFacts(rows) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row._dateKey !== 'string') continue;
    byDate.set(row._dateKey, laterDate(byDate.get(row._dateKey), row._createdAt));
  }
  return [...byDate.keys()].sort().map(date => ({ date, newest: byDate.get(date) }));
}

const lastSection = story => {
  const sections = (story && story.sections) || [];
  return sections.length ? sections[sections.length - 1] : null;
};

function editionsInWindow(period, today, editions) {
  const window = storyWindow(period, today);
  return (Array.isArray(editions) ? editions : [])
    .filter(e => e.date >= window.from && e.date <= window.to);
}

// A stored `late` is a list of marks; one written as a single mark reads as one.
const marksOf = late => (!late ? [] : Array.isArray(late) ? late : [late]);

// The late filings owed a run dated today, as a list of marks
// `{ through, after }`, or null. An edition already run with an article filed
// after seenUpTo is a late filing into the period, or a same-day re-push of
// today. Its mark is added to the marks already stored, so a filing noticed
// after an edition run is left out of the later edition runs too. A mark
// covers only what was filed after the watermark it was noticed at, so no
// row an edition run has already read normally becomes late.
//
// A filing into a grace-window day that has already run is not a run of its
// own; the next run reads it.
function lateFilings(period, today, editions, story) {
  const stored = marksOf(story && story.late);
  const current = stored.length ? stored : null;
  const through = (story && story.throughDate) || null;
  if (!through) return current;
  const seen = toMillis(story.seenUpTo);
  const late = editionsInWindow(period, today, editions).some(e => e.date <= through
    && (e.date <= period.range.to || e.date === today)
    && toMillis(e.newest) !== null
    && (seen === null || toMillis(e.newest) > seen));
  if (!late) return current;
  const mark = { through, after: story.seenUpTo || null };
  const known = stored.some(m => m.through === through && toMillis(m.after) === seen);
  return known ? current : [...stored, mark];
}

// The rows a run for `d` reads. An edition run before today leaves the late
// filings out, so they are read once, by the run dated today, and never go
// into a section dated in the past. A mark with no `after` has no watermark
// to tell a late row from an old one, so it leaves nothing out; the run dated
// today is still due.
function withoutLateFilings(rows, late, d, today) {
  const list = Array.isArray(rows) ? rows : [];
  const marks = marksOf(late)
    .map(m => ({ through: m.through, after: toMillis(m.after) }))
    .filter(m => typeof m.through === 'string' && m.after !== null);
  if (!marks.length || d === today) return list;
  return list.filter(row => {
    if (!row || typeof row._dateKey !== 'string') return true;
    const at = toMillis(row._createdAt);
    if (at === null) return true;
    return !marks.some(m => row._dateKey <= m.through && at > m.after);
  });
}

// The run dates due for a period, oldest first.
//
//  - Every edition in the window dated after throughDate.
//  - Then, when there are late filings (lateFilings), one run dated today,
//    at the end, unless today's edition is already the last run due.
//
// `editions` is editionFacts over the visible articles in storyWindow.
function dueRuns(period, today, editions, story) {
  const through = (story && story.throughDate) || null;
  const due = editionsInWindow(period, today, editions)
    .filter(e => !through || e.date > through).map(e => e.date).sort();
  if (lateFilings(period, today, editions, story) && due[due.length - 1] !== today) due.push(today);
  return due;
}

// The filter every claim and store matches: the story as this run read it.
function guardFilter(story) {
  return {
    periodId: story.periodId,
    throughDate: story.throughDate || null,
    sections: { $size: ((story && story.sections) || []).length },
  };
}

// The update that records one attempt at date `d`, or null when the date has
// had its three. Guarded like a store, so an attempt is never counted against
// progress another run has already made.
function claimUpdate(story, d) {
  const done = Number((story.attempts || {})[d]) || 0;
  if (done >= MAX_ATTEMPTS) return null;
  return { filter: guardFilter(story), update: { $inc: { [`attempts.${d}`]: 1 } }, attempt: done + 1 };
}

// The update that stores the run for date `d`, whatever it found.
//
//  - `section` null (nothing qualified, or the date was skipped): throughDate
//    and seenUpTo still advance.
//  - A section after the last one is appended.
//  - A section dated today, when the last section is dated today, replaces it.
//  - Any other section is not stored. A section dated before today is frozen.
//
// `consumed` is the newest _createdAt the run read. `admitted` is recomputed
// from the sections as they will be, so a replaced section cannot leave a
// thread admitted that no longer has its `new` entry.
//
// `late` is lateFilings as the run read it. An edition run before today
// stores it, so the run dated today stays due after seenUpTo has moved past
// the late filings. The run dated today clears it.
function storeUpdate({ story, date: d, today, section, consumed, model, now, late }) {
  const sections = (story && story.sections) || [];
  const last = lastSection(story);
  const filter = guardFilter(story);

  let outcome = OUTCOME.NONE;
  let next = sections;
  const stored = section && { date: d, entries: section.entries, writtenAt: now, model };
  if (stored && (!last || d > last.date)) {
    outcome = OUTCOME.APPENDED;
    next = [...sections, stored];
  } else if (stored && last.date === d && d === today) {
    outcome = OUTCOME.REPLACED;
    next = [...sections.slice(0, -1), stored];
  }

  const $set = {
    throughDate: maxDate(story.throughDate || null, d),
    seenUpTo: laterDate(story.seenUpTo, consumed),
    late: d === today ? null : (late || story.late || null),
    updatedAt: now,
  };
  const update = { $set, $unset: { [`attempts.${d}`]: '' } };

  if (outcome === OUTCOME.APPENDED) update.$push = { sections: stored };
  if (outcome === OUTCOME.REPLACED) {
    filter[`sections.${sections.length - 1}.date`] = today;
    $set[`sections.${sections.length - 1}`] = stored;
  }
  if (outcome !== OUTCOME.NONE) {
    $set.admitted = [...admittedThreads({ sections: next }, '9999-12-31')];
  }

  return { filter, update, outcome };
}

// What the period endpoint can say about the story. `due` is dueRuns,
// `queued` whether a pass is queued or running for it, `enabled` whether the
// model key is set.
function storyStatus({ articleCount, due, queued, enabled }) {
  if (!articleCount) return 'none';
  if (!enabled || queued || (due && due.length)) return 'writing';
  return 'ready';
}

// A period's story before any run. `periodId` comes from the upsert filter.
function emptyStory() {
  return { sections: [], admitted: [], throughDate: null, seenUpTo: null, attempts: {}, late: null };
}

module.exports = {
  GRACE_DAYS,
  MAX_ATTEMPTS,
  OUTCOME,
  laterDate,
  storyWindow,
  editionFacts,
  lateFilings,
  withoutLateFilings,
  dueRuns,
  claimUpdate,
  storeUpdate,
  storyStatus,
  emptyStory,
};
