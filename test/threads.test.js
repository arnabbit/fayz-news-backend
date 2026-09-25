const test = require('node:test');
const assert = require('node:assert/strict');
const {
  THREAD_WINDOW_DAYS,
  RECENT_HEADLINES,
  TITLE_CAP,
  mintThreadId,
  threadWindowStart,
  recentHeadlines,
  buildGroupingPrompt,
  parseGroupingReply,
  validateGrouping,
} = require('../threads');

const ARTICLES = [
  {
    id: 'a1', headline: 'Ceasefire talks resume in Doha', dek: 'Delegations return after a week.',
    category: 'world', developments: [{ summary: 'Mediators propose a phased truce.' }],
  },
  {
    id: 'a2', headline: 'Rupee falls to a record low', dek: '', category: 'economy',
    developments: [],
  },
  {
    id: 'a3', headline: 'Monsoon floods close schools', dek: 'Three districts affected.',
    category: 'environment',
  },
];

const THREADS = [
  {
    threadId: 'T-ceasefire', title: 'Gaza ceasefire talks', category: 'world',
    lastDate: '2026-09-20', headlines: ['Talks stall', 'Talks planned', 'Envoys meet'],
  },
];

// A deterministic minter, so a test can name the ids it expects.
function counter() {
  let n = 0;
  return () => `NEW${++n}`;
}

// ---- ids ----

test('a thread id is 12 characters and a fresh one each time', () => {
  const a = mintThreadId();
  const b = mintThreadId();
  assert.equal(a.length, 12);
  assert.match(a, /^[A-Za-z0-9]{12}$/);
  assert.notEqual(a, b);
});

// ---- the window ----

test('the candidate window reaches 60 days back from the edition', () => {
  assert.equal(THREAD_WINDOW_DAYS, 60);
  assert.equal(threadWindowStart('2026-09-25'), '2026-07-27');
  assert.equal(threadWindowStart('2026-03-01'), '2025-12-31');
  assert.equal(threadWindowStart('2024-03-01'), '2024-01-01');
});

test('recent headlines keep the newest three per thread, newest first', () => {
  const rows = [
    { _threadId: 'T1', headline: 'one', _dateKey: '2026-09-01' },
    { _threadId: 'T1', headline: 'four', _dateKey: '2026-09-04' },
    { _threadId: 'T2', headline: 'other', _dateKey: '2026-09-02' },
    { _threadId: 'T1', headline: 'three', _dateKey: '2026-09-03' },
    { _threadId: 'T1', headline: 'two', _dateKey: '2026-09-02' },
  ];
  const out = recentHeadlines(rows);
  assert.equal(RECENT_HEADLINES, 3);
  assert.deepEqual(out.get('T1'), ['four', 'three', 'two']);
  assert.deepEqual(out.get('T2'), ['other']);
});

// ---- the prompt ----

test('the prompt carries each article\'s id, headline, dek, category and developments', () => {
  const prompt = buildGroupingPrompt('2026-09-25', ARTICLES, THREADS);
  for (const s of ['a1', 'Ceasefire talks resume in Doha', 'Delegations return after a week.',
    'world', 'Mediators propose a phased truce.', 'a2', 'Rupee falls to a record low', 'a3']) {
    assert.ok(prompt.includes(s), `missing ${s}`);
  }
  assert.ok(prompt.includes('2026-09-25'));
});

test('the prompt carries each candidate thread with its last headlines', () => {
  const prompt = buildGroupingPrompt('2026-09-25', ARTICLES, THREADS);
  for (const s of ['T-ceasefire', 'Gaza ceasefire talks', '2026-09-20', 'Talks stall', 'Envoys meet']) {
    assert.ok(prompt.includes(s), `missing ${s}`);
  }
});

test('the prompt leans towards a new thread and asks for sameness only', () => {
  const prompt = buildGroupingPrompt('2026-09-25', ARTICLES, THREADS);
  assert.match(prompt, /new thread/i);
  assert.match(prompt, /when in doubt/i);
  assert.match(prompt, /not.*importan/i);
  assert.ok(prompt.includes('"threadId"'));
  assert.ok(prompt.includes('"articleId"'));
});

test('with no candidate threads the prompt says so rather than listing nothing', () => {
  const prompt = buildGroupingPrompt('2026-09-25', ARTICLES, []);
  assert.match(prompt, /no existing threads/i);
});

test('article bodies and source posts never reach the prompt', () => {
  const prompt = buildGroupingPrompt('2026-09-25', [
    { ...ARTICLES[0], body: ['BODY TEXT'], sourcePosts: [{ sourceHeadline: 'OTHER OUTLET' }] },
  ], []);
  assert.equal(prompt.includes('BODY TEXT'), false);
  assert.equal(prompt.includes('OTHER OUTLET'), false);
});

// ---- the parser ----

test('a fenced reply parses to its assignments', () => {
  const reply = '```json\n{"assignments":[{"articleId":"a1","threadId":"T-ceasefire"}]}\n```';
  assert.deepEqual(parseGroupingReply(reply), [{ articleId: 'a1', threadId: 'T-ceasefire' }]);
});

test('a bare array reply is accepted too', () => {
  const reply = 'Here:\n[{"articleId":"a1","threadId":null,"title":"X"}]';
  assert.deepEqual(parseGroupingReply(reply), [{ articleId: 'a1', threadId: null, title: 'X' }]);
});

test('an unusable reply parses to null rather than throwing', () => {
  assert.equal(parseGroupingReply(''), null);
  assert.equal(parseGroupingReply(null), null);
  assert.equal(parseGroupingReply('no json here'), null);
  assert.equal(parseGroupingReply('{"assignments": "nope"}'), null);
  assert.equal(parseGroupingReply('{"something":"else"}'), null);
  assert.equal(parseGroupingReply('[broken'), null);
});

// ---- the validator ----

function byArticle(result) {
  return Object.fromEntries(result.assignments.map(a => [a.articleId, a.threadId]));
}

test('a well-formed reply joins and starts threads as asked', () => {
  const out = validateGrouping([
    { articleId: 'a1', threadId: 'T-ceasefire' },
    { articleId: 'a2', threadId: null, title: '  Rupee slide  ' },
    { articleId: 'a3', threadId: null, title: 'Monsoon floods' },
  ], ARTICLES, THREADS, counter());
  assert.deepEqual(byArticle(out), { a1: 'T-ceasefire', a2: 'NEW1', a3: 'NEW2' });
  assert.deepEqual(out.newThreads, [
    { threadId: 'NEW1', title: 'Rupee slide', category: 'economy' },
    { threadId: 'NEW2', title: 'Monsoon floods', category: 'environment' },
  ]);
});

test('every article ends with exactly one thread, in input order', () => {
  const out = validateGrouping([], ARTICLES, THREADS, counter());
  assert.deepEqual(out.assignments.map(a => a.articleId), ['a1', 'a2', 'a3']);
  assert.ok(out.assignments.every(a => typeof a.threadId === 'string' && a.threadId));
});

test('an article the model leaves out gets a new thread of its own, titled by its headline', () => {
  const out = validateGrouping([
    { articleId: 'a1', threadId: 'T-ceasefire' },
  ], ARTICLES, THREADS, counter());
  assert.deepEqual(byArticle(out), { a1: 'T-ceasefire', a2: 'NEW1', a3: 'NEW2' });
  assert.deepEqual(out.newThreads.map(t => t.title), [
    'Rupee falls to a record low', 'Monsoon floods close schools',
  ]);
});

test('an unknown thread id is corrected to a new thread, never stored', () => {
  const out = validateGrouping([
    { articleId: 'a1', threadId: 'INVENTED', title: 'Ceasefire' },
  ], ARTICLES, THREADS, counter());
  assert.equal(byArticle(out).a1, 'NEW1');
  assert.ok(out.assignments.every(a => a.threadId !== 'INVENTED'));
  assert.ok(out.newThreads.every(t => t.threadId !== 'INVENTED'));
});

test('an unknown article id is dropped', () => {
  const out = validateGrouping([
    { articleId: 'ghost', threadId: 'T-ceasefire' },
    { articleId: 'ghost2', threadId: null, title: 'Ghost story' },
  ], ARTICLES, THREADS, counter());
  assert.deepEqual(out.assignments.map(a => a.articleId), ['a1', 'a2', 'a3']);
  assert.ok(out.newThreads.every(t => t.title !== 'Ghost story'));
});

test('an article named twice keeps its first assignment', () => {
  const out = validateGrouping([
    { articleId: 'a1', threadId: 'T-ceasefire' },
    { articleId: 'a1', threadId: null, title: 'Second' },
  ], ARTICLES, THREADS, counter());
  assert.equal(byArticle(out).a1, 'T-ceasefire');
  assert.ok(out.newThreads.every(t => t.title !== 'Second'));
});

test('the model can never mint an id: a new thread always gets a backend id', () => {
  const out = validateGrouping([
    { articleId: 'a1', threadId: 'T-ceasefire' },
    { articleId: 'a2', threadId: null, title: 'Rupee', newThreadId: 'MODEL-ID' },
  ], ARTICLES, THREADS, counter());
  assert.equal(byArticle(out).a2, 'NEW1');
});

test('two articles starting new threads get two threads, never one', () => {
  const out = validateGrouping([
    { articleId: 'a2', threadId: null, title: 'Same title' },
    { articleId: 'a3', threadId: null, title: 'Same title' },
  ], ARTICLES, THREADS, counter());
  assert.notEqual(byArticle(out).a2, byArticle(out).a3);
});

test('a blank or overlong title is repaired', () => {
  const out = validateGrouping([
    { articleId: 'a1', threadId: 'T-ceasefire' },
    { articleId: 'a2', threadId: null, title: '   ' },
    { articleId: 'a3', threadId: null, title: 'x'.repeat(500) },
  ], ARTICLES, THREADS, counter());
  assert.equal(out.newThreads[0].title, 'Rupee falls to a record low');
  assert.equal(out.newThreads[1].title.length, TITLE_CAP);
});

test('junk entries are ignored, not thrown on', () => {
  const out = validateGrouping([
    null, 42, 'a1', { articleId: 5, threadId: 'T-ceasefire' }, { threadId: 'T-ceasefire' },
    { articleId: 'a1', threadId: 7 },
  ], ARTICLES, THREADS, counter());
  assert.equal(out.assignments.length, 3);
  // A threadId that is not a string is not a thread; it is corrected to a new one.
  assert.equal(byArticle(out).a1, 'NEW1');
});

test('an unusable reply still groups every article, each on its own', () => {
  for (const reply of [null, undefined, 'text', {}, { assignments: [] }]) {
    const out = validateGrouping(reply, ARTICLES, THREADS, counter());
    assert.deepEqual(byArticle(out), { a1: 'NEW1', a2: 'NEW2', a3: 'NEW3' });
  }
});

test('an article with no category starts a thread filed under world', () => {
  const out = validateGrouping([], [{ id: 'x', headline: 'H' }], [], counter());
  assert.deepEqual(out.newThreads, [{ threadId: 'NEW1', title: 'H', category: 'world' }]);
});

test('no articles means nothing to do', () => {
  assert.deepEqual(validateGrouping([{ articleId: 'a1', threadId: 'T-ceasefire' }], [], THREADS),
    { assignments: [], newThreads: [] });
});
