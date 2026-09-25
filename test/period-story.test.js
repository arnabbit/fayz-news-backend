const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GRACE_DAYS,
  MAX_ATTEMPTS,
  storyWindow,
  editionFacts,
  lateFilings,
  withoutLateFilings,
  dueRuns,
  claimUpdate,
  storeUpdate,
  storyStatus,
  emptyStory,
} = require('../periodStory');

const WEEK = { id: '2026-W38', kind: 'week', range: { from: '2026-09-14', to: '2026-09-20' } };
const t = iso => new Date(iso);

function story(extra = {}) {
  return { ...emptyStory(), periodId: WEEK.id, ...extra };
}

const edition = (date, newest) => ({ date, newest: newest ? t(newest) : null });

const written = (threadId, dates, headline = `Story ${threadId}`) => ({
  threadId,
  headline,
  parts: dates.map((date, i) => ({
    date, kind: i ? 'update' : 'backstory', paragraphs: [`P ${threadId} ${date}`], articleIds: ['a'], why: 'w',
    writtenAt: t('2026-09-01T00:00:00Z'), model: 'm',
  })),
});

// ---- dates ----

test('the window runs from the first day to three days after the last, capped at today', () => {
  assert.equal(GRACE_DAYS, 3);
  assert.deepEqual(storyWindow(WEEK, '2026-10-30'), { from: '2026-09-14', to: '2026-09-23' });
  assert.deepEqual(storyWindow(WEEK, '2026-09-16'), { from: '2026-09-14', to: '2026-09-16' });
});

test('edition facts fold rows into one entry per date with the newest filing time', () => {
  const facts = editionFacts([
    { _dateKey: '2026-09-15', _createdAt: t('2026-09-15T05:00:00Z') },
    { _dateKey: '2026-09-14', _createdAt: t('2026-09-14T05:00:00Z') },
    { _dateKey: '2026-09-15', _createdAt: t('2026-09-15T09:00:00Z') },
    { _dateKey: '2026-09-16' },
  ]);
  assert.deepEqual(facts, [
    edition('2026-09-14', '2026-09-14T05:00:00Z'),
    edition('2026-09-15', '2026-09-15T09:00:00Z'),
    edition('2026-09-16', null),
  ]);
});

// ---- which runs are due ----

test('every edition after throughDate is due, oldest first', () => {
  const editions = [edition('2026-09-17'), edition('2026-09-14'), edition('2026-09-15')];
  assert.deepEqual(dueRuns(WEEK, '2026-09-25', editions, story()), ['2026-09-14', '2026-09-15', '2026-09-17']);
  assert.deepEqual(
    dueRuns(WEEK, '2026-09-25', editions, story({ throughDate: '2026-09-15' })),
    ['2026-09-17']
  );
});

test('editions in the 3-day grace window run; the 4th day after the end does not', () => {
  const editions = [
    edition('2026-09-20'), edition('2026-09-21'), edition('2026-09-23'), edition('2026-09-24'),
  ];
  assert.deepEqual(dueRuns(WEEK, '2026-10-01', editions, story({ throughDate: '2026-09-19' })),
    ['2026-09-20', '2026-09-21', '2026-09-23']);
});

test('an edition after today or before the period is never due', () => {
  const editions = [edition('2026-09-13'), edition('2026-09-15'), edition('2026-09-17')];
  assert.deepEqual(dueRuns(WEEK, '2026-09-16', editions, story()), ['2026-09-15']);
});

test('nothing new since the last run means nothing is due', () => {
  const editions = [edition('2026-09-14', '2026-09-14T05:00:00Z'), edition('2026-09-15', '2026-09-15T05:00:00Z')];
  const caughtUp = story({ throughDate: '2026-09-15', seenUpTo: t('2026-09-15T05:00:00Z') });
  assert.deepEqual(dueRuns(WEEK, '2026-09-25', editions, caughtUp), []);
});

test('a same-day re-push re-runs today', () => {
  const editions = [edition('2026-09-16', '2026-09-16T08:00:00Z')];
  const done = story({
    throughDate: '2026-09-16', seenUpTo: t('2026-09-16T05:00:00Z'), stories: [written('T1', ['2026-09-16'])],
  });
  assert.deepEqual(dueRuns(WEEK, '2026-09-16', editions, done), ['2026-09-16']);
});

test('a late filing into a past edition is one run dated today, even after the grace window', () => {
  const editions = [edition('2026-09-14', '2026-10-20T08:00:00Z'), edition('2026-09-15', '2026-09-15T05:00:00Z')];
  const done = story({ throughDate: '2026-09-15', seenUpTo: t('2026-09-15T05:00:00Z') });
  assert.deepEqual(dueRuns(WEEK, '2026-10-20', editions, done), ['2026-10-20']);
});

test('a late filing into a grace-window day is not a run of its own', () => {
  const editions = [edition('2026-09-15', '2026-09-15T05:00:00Z'), edition('2026-09-22', '2026-10-20T08:00:00Z')];
  const done = story({ throughDate: '2026-09-22', seenUpTo: t('2026-09-22T05:00:00Z') });
  assert.deepEqual(dueRuns(WEEK, '2026-10-20', editions, done), []);
});

test('a late filing while edition runs are still due adds one run dated today, after them', () => {
  const editions = [edition('2026-09-14', '2026-09-18T08:00:00Z'), edition('2026-09-17', '2026-09-17T05:00:00Z')];
  const done = story({ throughDate: '2026-09-15', seenUpTo: t('2026-09-15T05:00:00Z') });
  assert.deepEqual(dueRuns(WEEK, '2026-09-18', editions, done), ['2026-09-17', '2026-09-18']);
  // After the period too: the edition runs first, then the run dated today.
  assert.deepEqual(dueRuns(WEEK, '2026-10-20', editions, done), ['2026-09-17', '2026-10-20']);
});

test('a late filing while today\'s edition is due adds no second run for today', () => {
  const editions = [edition('2026-09-14', '2026-09-17T08:00:00Z'), edition('2026-09-17', '2026-09-17T05:00:00Z')];
  const done = story({ throughDate: '2026-09-15', seenUpTo: t('2026-09-15T05:00:00Z') });
  assert.deepEqual(dueRuns(WEEK, '2026-09-17', editions, done), ['2026-09-17']);
});

test('late filings are marked by the watermark they were filed after', () => {
  const editions = [edition('2026-09-14', '2026-09-18T08:00:00Z'), edition('2026-09-17', '2026-09-17T05:00:00Z')];
  const done = story({ throughDate: '2026-09-15', seenUpTo: t('2026-09-15T05:00:00Z') });
  assert.deepEqual(lateFilings(WEEK, '2026-09-18', editions, done), [{ through: '2026-09-15', after: t('2026-09-15T05:00:00Z') }]);
  const caughtUp = story({ throughDate: '2026-09-17', seenUpTo: t('2026-09-18T08:00:00Z') });
  assert.equal(lateFilings(WEEK, '2026-09-18', editions, caughtUp), null);
  assert.equal(lateFilings(WEEK, '2026-09-18', editions, story()), null);
});

test('a stored late mark keeps the run dated today due after seenUpTo has moved past it', () => {
  const editions = [edition('2026-09-14', '2026-09-18T08:00:00Z'), edition('2026-09-17', '2026-09-17T05:00:00Z')];
  const mark = [{ through: '2026-09-15', after: t('2026-09-15T05:00:00Z') }];
  const afterEditionRun = story({ throughDate: '2026-09-17', seenUpTo: t('2026-09-18T08:00:00Z'), late: mark });
  assert.deepEqual(lateFilings(WEEK, '2026-09-18', editions, afterEditionRun), mark);
  assert.deepEqual(dueRuns(WEEK, '2026-09-18', editions, afterEditionRun), ['2026-09-18']);
});

test('an edition run before today leaves the late filings out; the run dated today reads them', () => {
  const mark = [{ through: '2026-09-15', after: t('2026-09-15T05:00:00Z') }];
  const rows = [
    { id: 'old', _dateKey: '2026-09-14', _createdAt: t('2026-09-14T05:00:00Z') },
    { id: 'late', _dateKey: '2026-09-14', _createdAt: t('2026-09-18T08:00:00Z') },
    { id: 'undated', _dateKey: '2026-09-15' },
    { id: 'new', _dateKey: '2026-09-17', _createdAt: t('2026-09-17T05:00:00Z') },
  ];
  const ids = out => out.map(r => r.id);
  assert.deepEqual(ids(withoutLateFilings(rows, mark, '2026-09-17', '2026-09-18')), ['old', 'undated', 'new']);
  assert.deepEqual(ids(withoutLateFilings(rows, mark, '2026-09-18', '2026-09-18')), ['old', 'late', 'undated', 'new']);
  assert.deepEqual(ids(withoutLateFilings(rows, null, '2026-09-17', '2026-09-18')), ['old', 'late', 'undated', 'new']);
});

test('a filing noticed after an edition run is merged into the stored mark', () => {
  // Marked at through=15th; the 16th then ran and moved seenUpTo on. Another
  // article is filed into the 16th before the run dated today.
  const first = { through: '2026-09-15', after: t('2026-09-15T05:00:00Z') };
  const editions = [
    edition('2026-09-14', '2026-09-18T08:00:00Z'),
    edition('2026-09-16', '2026-09-18T09:00:00Z'),
    edition('2026-09-17', '2026-09-17T05:00:00Z'),
  ];
  const s = story({ throughDate: '2026-09-16', seenUpTo: t('2026-09-18T08:00:00Z'), late: [first] });
  const second = { through: '2026-09-16', after: t('2026-09-18T08:00:00Z') };
  const late = lateFilings(WEEK, '2026-09-19', editions, s);
  assert.deepEqual(late, [first, second]);
  assert.deepEqual(dueRuns(WEEK, '2026-09-19', editions, s), ['2026-09-17', '2026-09-19']);
  // Read again with nothing new, the marks do not grow.
  assert.deepEqual(lateFilings(WEEK, '2026-09-19', editions, { ...s, late }), late);

  const rows = [
    { id: 'late14', _dateKey: '2026-09-14', _createdAt: t('2026-09-18T08:00:00Z') },
    { id: 'read16', _dateKey: '2026-09-16', _createdAt: t('2026-09-16T05:00:00Z') },
    { id: 'late16', _dateKey: '2026-09-16', _createdAt: t('2026-09-18T09:00:00Z') },
    { id: 'new17', _dateKey: '2026-09-17', _createdAt: t('2026-09-17T05:00:00Z') },
  ];
  // The 17th's run leaves both late filings out and keeps what the 16th read.
  assert.deepEqual(withoutLateFilings(rows, late, '2026-09-17', '2026-09-19').map(r => r.id), ['read16', 'new17']);
});

test('a mark with no watermark leaves no row out', () => {
  // throughDate set, seenUpTo null: no run has read a filing time yet.
  const editions = [edition('2026-09-14', '2026-09-18T08:00:00Z'), edition('2026-09-17', '2026-09-17T05:00:00Z')];
  const s = story({ throughDate: '2026-09-15', seenUpTo: null });
  const late = lateFilings(WEEK, '2026-09-18', editions, s);
  assert.deepEqual(late, [{ through: '2026-09-15', after: null }]);
  assert.deepEqual(dueRuns(WEEK, '2026-09-18', editions, s), ['2026-09-17', '2026-09-18']);
  const rows = [
    { id: 'old', _dateKey: '2026-09-14', _createdAt: t('2026-09-14T05:00:00Z') },
    { id: 'undated', _dateKey: '2026-09-15' },
    { id: 'newer', _dateKey: '2026-09-15', _createdAt: t('2026-09-18T08:00:00Z') },
  ];
  assert.deepEqual(withoutLateFilings(rows, late, '2026-09-17', '2026-09-18').map(r => r.id), ['old', 'undated', 'newer']);
});

test('an unknown filing time never makes a run due on its own', () => {
  const editions = [edition('2026-09-14', null)];
  assert.deepEqual(dueRuns(WEEK, '2026-09-25', editions, story({ throughDate: '2026-09-14' })), []);
});

// ---- attempts ----

test('a run claims an attempt, guarded on the progress it read', () => {
  const s = story({ throughDate: '2026-09-14', stories: [written('T1', ['2026-09-14'])], attempts: { '2026-09-15': 1 } });
  const claim = claimUpdate(s, '2026-09-15');
  assert.equal(claim.attempt, 2);
  assert.deepEqual(claim.filter, { periodId: WEEK.id, throughDate: '2026-09-14', stories: { $size: 1 } });
  assert.deepEqual(claim.update, { $inc: { 'attempts.2026-09-15': 1 } });
});

test('after three attempts a date is not claimed again', () => {
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(claimUpdate(story({ attempts: { '2026-09-15': 3 } }), '2026-09-15'), null);
  assert.notEqual(claimUpdate(story({ attempts: { '2026-09-14': 3 } }), '2026-09-15'), null);
});

// ---- the store guard ----

const NOW = t('2026-09-25T10:00:00Z');

const admit = threadId => ({ threadId, headline: `About ${threadId}`, part: { kind: 'backstory', paragraphs: ['New.'], articleIds: ['b'], verification: 'sources', why: 'w' } });
const add = (threadId, kind = 'update') => ({ threadId, part: { kind, paragraphs: ['More.'], articleIds: ['c'], why: 'w' } });
const result = (ranking, backstories = [], updates = []) => ({ ranking, backstories, updates });

function store(s, d, today, out, consumed = t('2026-09-16T05:00:00Z')) {
  return storeUpdate({ story: s, date: d, today, result: out, consumed, model: 'm', now: NOW });
}

test('a store is guarded on throughDate and the story count, and adds a backstory as a new story', () => {
  const s = story({ throughDate: '2026-09-14', seenUpTo: t('2026-09-14T05:00:00Z'), stories: [written('T1', ['2026-09-14'])], ranking: ['T1'] });
  const out = store(s, '2026-09-15', '2026-09-25', result(['T2', 'T1'], [admit('T2')]));
  assert.equal(out.outcome, 'appended');
  assert.deepEqual(out.filter, { periodId: WEEK.id, throughDate: '2026-09-14', stories: { $size: 1 } });
  assert.deepEqual(out.update.$set.stories, [
    written('T1', ['2026-09-14']),
    {
      threadId: 'T2',
      headline: 'About T2',
      parts: [{ date: '2026-09-15', kind: 'backstory', paragraphs: ['New.'], articleIds: ['b'], verification: 'sources', why: 'w', writtenAt: NOW, model: 'm' }],
    },
  ]);
  assert.deepEqual(out.update.$set.ranking, ['T2', 'T1']);
  assert.equal(out.update.$set.throughDate, '2026-09-15');
  assert.deepEqual(out.update.$set.seenUpTo, t('2026-09-16T05:00:00Z'));
  assert.deepEqual(out.update.$unset, { 'attempts.2026-09-15': '' });
});

test('an update is one part at the end of its story, and earlier parts are left as they were', () => {
  const frozen = [written('T1', ['2026-09-14', '2026-09-15']), written('T2', ['2026-09-15'])];
  const before = structuredClone(frozen);
  const s = story({ throughDate: '2026-09-15', stories: frozen, ranking: ['T1', 'T2'] });
  const out = store(s, '2026-09-16', '2026-09-25', result(['T1', 'T2'], [], [add('T1', 'correction')]));
  assert.equal(out.outcome, 'appended');
  assert.deepEqual(frozen, before);
  const [t1, t2] = out.update.$set.stories;
  assert.deepEqual(t1.parts.slice(0, 2), before[0].parts);
  assert.deepEqual(t1.parts[2], { date: '2026-09-16', kind: 'correction', paragraphs: ['More.'], articleIds: ['c'], why: 'w', writtenAt: NOW, model: 'm' });
  assert.deepEqual(t2, before[1]);
});

test('at most one part per story per run date', () => {
  const s = story({ throughDate: '2026-09-15', stories: [written('T1', ['2026-09-15'])], ranking: ['T1'] });
  const out = store(s, '2026-09-16', '2026-09-25', result(['T1', 'T2'], [admit('T2'), admit('T1')], [add('T1'), add('T1', 'correction'), add('T2')]));
  const [t1, t2] = out.update.$set.stories;
  assert.deepEqual(t1.parts.map(p => [p.date, p.kind]), [['2026-09-15', 'backstory'], ['2026-09-16', 'update']]);
  assert.deepEqual(t2.parts.map(p => [p.date, p.kind]), [['2026-09-16', 'backstory']]);
});

test('a story that drops out of the ranking keeps its text, and continues from it when it comes back', () => {
  const s = story({ throughDate: '2026-09-15', stories: [written('T1', ['2026-09-14']), written('T2', ['2026-09-15'])], ranking: ['T1', 'T2'] });
  const dropped = store(s, '2026-09-16', '2026-09-25', result(['T2']));
  assert.equal(dropped.outcome, 'ranked');
  assert.deepEqual(dropped.update.$set.ranking, ['T2']);
  assert.deepEqual(dropped.update.$set.stories.map(x => x.threadId), ['T1', 'T2']);
  assert.deepEqual(dropped.update.$set.stories[0], s.stories[0]);

  const later = story({ throughDate: '2026-09-16', stories: dropped.update.$set.stories, ranking: ['T2'] });
  const back = store(later, '2026-09-17', '2026-09-25', result(['T1', 'T2'], [admit('T1')], [add('T1')]));
  // No new backstory: T1 continues from the text it had.
  assert.deepEqual(back.update.$set.stories[0].parts.map(p => [p.date, p.kind]), [['2026-09-14', 'backstory'], ['2026-09-17', 'update']]);
  assert.equal(back.update.$set.stories[0].headline, 'Story T1');
  assert.deepEqual(back.update.$set.ranking, ['T1', 'T2']);
});

test('the ranking holds only stories that exist, each once', () => {
  const s = story({ throughDate: '2026-09-15', stories: [written('T1', ['2026-09-15'])], ranking: ['T1'] });
  const out = store(s, '2026-09-16', '2026-09-25', result(['T9', 'T1', 'T1']));
  assert.equal(out.outcome, 'none');
  assert.equal(out.update.$set.ranking, undefined);
});

test('a run with no result still advances throughDate and seenUpTo, and changes no text', () => {
  const s = story({ throughDate: '2026-09-14', seenUpTo: t('2026-09-14T05:00:00Z'), stories: [written('T1', ['2026-09-14'])], ranking: ['T1'] });
  const out = store(s, '2026-09-15', '2026-09-25', null);
  assert.equal(out.outcome, 'none');
  assert.equal(out.update.$set.stories, undefined);
  assert.equal(out.update.$set.ranking, undefined);
  assert.equal(out.update.$set.throughDate, '2026-09-15');
  assert.deepEqual(out.update.$set.seenUpTo, t('2026-09-16T05:00:00Z'));
});

test('seenUpTo and throughDate never move backwards', () => {
  const s = story({ throughDate: '2026-09-16', seenUpTo: t('2026-09-20T05:00:00Z') });
  const out = store(s, '2026-09-16', '2026-09-16', null, t('2026-09-18T05:00:00Z'));
  assert.equal(out.update.$set.throughDate, '2026-09-16');
  assert.deepEqual(out.update.$set.seenUpTo, t('2026-09-20T05:00:00Z'));
});

test("a run dated today replaces today's parts and today's ranking, and only those", () => {
  // Today's run admitted T3 and updated T1, and ranked T3 first.
  const s = story({
    throughDate: '2026-09-16',
    stories: [written('T1', ['2026-09-15', '2026-09-16']), written('T2', ['2026-09-15']), written('T3', ['2026-09-16'])],
    ranking: ['T3', 'T1', 'T2'],
  });
  const before = structuredClone(s.stories);
  const out = store(s, '2026-09-16', '2026-09-16', result(['T2', 'T4', 'T1'], [admit('T4')], [add('T2')]));
  assert.equal(out.outcome, 'replaced');
  assert.deepEqual(out.filter, { periodId: WEEK.id, throughDate: '2026-09-16', stories: { $size: 3 } });
  const next = out.update.$set.stories;
  // T1 loses today's update and keeps yesterday's backstory. T3, admitted
  // today and not ranked again, goes with its backstory. T2 gets today's part.
  assert.deepEqual(next.map(x => [x.threadId, x.parts.map(p => p.date)]), [
    ['T1', ['2026-09-15']], ['T2', ['2026-09-15', '2026-09-16']], ['T4', ['2026-09-16']],
  ]);
  assert.deepEqual(next[0].parts[0], before[0].parts[0]);
  assert.deepEqual(next[1].parts[0], before[1].parts[0]);
  assert.deepEqual(out.update.$set.ranking, ['T2', 'T4', 'T1']);
});

test('a same-day re-run with no result keeps what today already wrote', () => {
  const s = story({ throughDate: '2026-09-16', stories: [written('T1', ['2026-09-16'])], ranking: ['T1'] });
  const out = store(s, '2026-09-16', '2026-09-16', null);
  assert.equal(out.outcome, 'none');
  assert.equal(out.update.$set.stories, undefined);
});

test('a part dated before today is never rewritten, by any path', () => {
  const s = story({ throughDate: '2026-09-16', stories: [written('T1', ['2026-09-16'])], ranking: ['T1'] });
  // The same date, but today has moved on.
  const late = store(s, '2026-09-16', '2026-09-17', result(['T9'], [admit('T9')]));
  assert.equal(late.outcome, 'none');
  assert.equal(late.update.$set.stories, undefined);
  assert.equal(late.update.$set.ranking, undefined);
  // An earlier date than the last part.
  const earlier = store(s, '2026-09-15', '2026-09-25', result([], [], [add('T1')]));
  assert.equal(earlier.outcome, 'none');
  assert.equal(earlier.update.$set.stories, undefined);
});

test('an edition run stores the late mark, and the run dated today clears it', () => {
  const mark = [{ through: '2026-09-15', after: t('2026-09-15T05:00:00Z') }];
  const s = story({ throughDate: '2026-09-15', seenUpTo: t('2026-09-15T05:00:00Z'), stories: [written('T1', ['2026-09-15'])] });
  const edition17 = storeUpdate({ story: s, date: '2026-09-17', today: '2026-09-18', result: null, consumed: t('2026-09-18T08:00:00Z'), model: 'm', now: NOW, late: mark });
  assert.deepEqual(edition17.update.$set.late, mark);
  assert.deepEqual(edition17.filter, { periodId: WEEK.id, throughDate: '2026-09-15', stories: { $size: 1 } });

  const marked = story({ throughDate: '2026-09-17', seenUpTo: t('2026-09-18T08:00:00Z'), stories: [written('T1', ['2026-09-15'])], late: mark });
  const todayRun = storeUpdate({ story: marked, date: '2026-09-18', today: '2026-09-18', result: result(['T4'], [admit('T4')]), consumed: t('2026-09-18T08:00:00Z'), model: 'm', now: NOW, late: mark });
  assert.equal(todayRun.outcome, 'appended');
  assert.equal(todayRun.update.$set.late, null);
  assert.equal(todayRun.update.$set.throughDate, '2026-09-18');
});

test('the first store is guarded on an empty story', () => {
  const out = store(story(), '2026-09-14', '2026-09-25', null);
  assert.deepEqual(out.filter, { periodId: WEEK.id, throughDate: null, stories: { $size: 0 } });
  assert.deepEqual(emptyStory(), { stories: [], ranking: [], throughDate: null, seenUpTo: null, attempts: {}, late: null });
});

// ---- status ----

test('status: none for an empty period, writing while anything is due or queued, else ready', () => {
  assert.equal(storyStatus({ articleCount: 0, due: ['2026-09-14'], queued: true, enabled: true }), 'none');
  assert.equal(storyStatus({ articleCount: 3, due: ['2026-09-14'], queued: false, enabled: true }), 'writing');
  assert.equal(storyStatus({ articleCount: 3, due: [], queued: true, enabled: true }), 'writing');
  assert.equal(storyStatus({ articleCount: 3, due: [], queued: false, enabled: false }), 'writing');
  assert.equal(storyStatus({ articleCount: 3, due: [], queued: false, enabled: true }), 'ready');
});
