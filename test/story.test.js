const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STORY_DEFINITION,
  BARS,
  BUDGETS,
  MIN_EDITIONS,
  MIN_SOURCES,
  MAX_PARAGRAPHS,
  TRAIL_ARTICLES,
  storySoFar,
  buildEvidence,
  buildStoryPrompt,
  validateRanking,
} = require('../story');

const WEEK = { id: '2026-W38', kind: 'week', range: { from: '2026-09-14', to: '2026-09-20' } };
const MONTH = { id: '2026-09', kind: 'month', range: { from: '2026-09-01', to: '2026-09-30' } };

const sources = n => Array.from({ length: n }, (_, i) => ({ postUrl: `https://x/${i}` }));

function article(id, threadId, date, extra = {}) {
  return {
    id,
    _threadId: threadId,
    _dateKey: date,
    headline: `Headline ${id}`,
    dek: `Dek ${id}`,
    body: [`Body of ${id}, first paragraph.`, `Body of ${id}, second paragraph.`],
    developments: [{ summary: `Development of ${id}` }],
    sourcePosts: sources(1),
    ...extra,
  };
}

const THREADS = [
  { threadId: 'T-cease', title: 'Ceasefire talks', category: 'world' },
  { threadId: 'T-rupee', title: 'Rupee slide', category: 'economy' },
  { threadId: 'T-flood', title: 'Monsoon floods', category: 'environment' },
  { threadId: 'T-court', title: 'Court ruling on data law', category: 'law' },
];

// T-cease: two editions, two sources in total. A candidate, verified by sources.
// T-rupee: one edition, many sources. Not lasting, so not a candidate.
// T-flood: two editions, one source in total. Not verified without a basis.
// T-court: two editions, one source, with an official text to quote.
const ARTICLES = [
  article('c1', 'T-cease', '2026-09-15'),
  article('c2', 'T-cease', '2026-09-17'),
  article('r1', 'T-rupee', '2026-09-17', { sourcePosts: sources(5) }),
  article('f1', 'T-flood', '2026-09-16', { sourcePosts: [] }),
  article('f2', 'T-flood', '2026-09-17'),
  article('k1', 'T-court', '2026-09-16', {
    sourcePosts: [],
    developments: [{ summary: 'The Supreme Court ordered the ministry to suspend the data rule.' }],
  }),
  article('k2', 'T-court', '2026-09-17'),
];

const EMPTY_STORY = { stories: [], ranking: [] };

function evidenceFor(d, story = EMPTY_STORY, articles = ARTICLES, period = WEEK) {
  return buildEvidence(period, d, THREADS, articles, story);
}

const part = (date, kind = 'backstory', extra = {}) => ({
  date, kind, paragraphs: [`Written ${kind} on ${date}.`], articleIds: ['c1'], why: 'w', writtenAt: new Date(0), model: 'm', ...extra,
});

const written = (threadId, parts, headline = `Story of ${threadId}`) => ({ threadId, headline, parts });

const backstory = (threadId, extra = {}) => ({
  threadId,
  headline: `About ${threadId}`,
  paragraphs: ['It happened.'],
  articleIds: [],
  why: 'verified, material, consequential, lasting',
  ...extra,
});

const update = (threadId, extra = {}) => ({
  threadId, kind: 'update', paragraphs: ['Then more happened.'], articleIds: [], why: 'new facts', ...extra,
});

const reply = (ranking, backstories = [], updates = []) => JSON.stringify({ ranking, backstories, updates });

// ---- the budget and the lasting test ----

test('the budgets and the minimum editions are the ones the design names', () => {
  assert.deepEqual(BUDGETS, { week: 5, month: 20, quarter: 60, year: 240 });
  assert.deepEqual(MIN_EDITIONS, { week: 2, month: 3, quarter: 5, year: 10 });
  assert.equal(MIN_SOURCES, 2);
  assert.equal(TRAIL_ARTICLES, 8);
});

test('a thread on fewer than the minimum editions of the period is not a candidate', () => {
  const ev = evidenceFor('2026-09-17');
  assert.deepEqual(ev.map(t => t.threadId).sort(), ['T-cease', 'T-court', 'T-flood']);
  // A month needs three editions: none of these threads has them.
  assert.deepEqual(evidenceFor('2026-09-17', EMPTY_STORY, ARTICLES, MONTH), []);
  const three = [...ARTICLES, article('c3', 'T-cease', '2026-09-18')];
  assert.deepEqual(evidenceFor('2026-09-18', EMPTY_STORY, three, MONTH).map(t => t.threadId), ['T-cease']);
});

test('the editions counted are distinct, up to d and inside the period', () => {
  const articles = [
    article('c1', 'T-cease', '2026-09-15'),
    article('c1b', 'T-cease', '2026-09-15'),
    article('c2', 'T-cease', '2026-09-19'),
  ];
  // Two articles on one edition are one edition.
  assert.deepEqual(evidenceFor('2026-09-18', EMPTY_STORY, articles), []);
  assert.equal(evidenceFor('2026-09-19', EMPTY_STORY, articles)[0].editionCount, 2);

  // A grace-window edition is evidence, but not an edition of the period.
  const grace = [article('c1', 'T-cease', '2026-09-19'), article('c2', 'T-cease', '2026-09-21')];
  assert.deepEqual(evidenceFor('2026-09-22', EMPTY_STORY, grace), []);
  const lasting = [...grace, article('c0', 'T-cease', '2026-09-18')];
  const ev = evidenceFor('2026-09-22', EMPTY_STORY, lasting);
  assert.equal(ev[0].editionCount, 2);
  assert.equal(ev[0].articles.find(a => a.id === 'c2').inPeriod, false);
});

test('evidence counts sources over the whole trail and leaves out hidden articles and articles after d', () => {
  const articles = [
    article('old', 'T-rupee', '2026-09-10'),
    article('h1', 'T-flood', '2026-09-15', { hidden: true }),
    article('f2', 'T-flood', '2026-09-16'),
    article('late', 'T-court', '2026-09-19'),
    article('k1', 'T-court', '2026-09-16'),
    article('c1', 'T-cease', '2026-09-15'),
    article('c2', 'T-cease', '2026-09-16', { sourcePosts: sources(3) }),
  ];
  const ev = evidenceFor('2026-09-17', EMPTY_STORY, articles);
  assert.deepEqual(ev.map(t => t.threadId), ['T-cease']);
  assert.equal(ev[0].totalSources, 4);
});

test('the trail is cut to its most recent articles; every in-period id stays citable', () => {
  const days = Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const articles = days.map((date, i) => article(`c${i + 1}`, 'T-cease', date));
  const [thread] = evidenceFor('2026-09-12', EMPTY_STORY, articles, MONTH);
  assert.deepEqual(thread.articles.map(a => a.id), ['c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12']);
  assert.equal(thread.omitted, 4);
  assert.equal(thread.editionCount, 12);
  assert.equal(thread.citable.length, 12);
  const prompt = buildStoryPrompt(MONTH, '2026-09-12', [thread], EMPTY_STORY);
  assert.ok(!prompt.includes('Headline c4\n'));
  assert.ok(prompt.includes('4 earlier ones left out'));
});

test('evidence keeps full bodies only for articles dated d', () => {
  const cease = evidenceFor('2026-09-17').find(t => t.threadId === 'T-cease');
  assert.equal(cease.articles.find(a => a.id === 'c1').body, null);
  assert.deepEqual(cease.articles.find(a => a.id === 'c2').body, [
    'Body of c2, first paragraph.', 'Body of c2, second paragraph.',
  ]);
});

test('ranked threads come first, in ranking order, then by first appearance', () => {
  const story = {
    stories: [written('T-court', [part('2026-09-16')]), written('T-flood', [part('2026-09-16')])],
    ranking: ['T-flood', 'T-court'],
  };
  const ev = evidenceFor('2026-09-17', story);
  assert.deepEqual(ev.map(t => [t.threadId, t.written]), [['T-flood', true], ['T-court', true], ['T-cease', false]]);
});

// ---- the story so far ----

test('the story so far has only parts dated before d, and only stories left with one', () => {
  const story = {
    stories: [
      written('T-cease', [part('2026-09-15'), part('2026-09-17', 'update')]),
      written('T-court', [part('2026-09-17')]),
    ],
    ranking: ['T-court', 'T-cease'],
  };
  const sofar = storySoFar(story, '2026-09-17');
  assert.deepEqual(sofar.stories.map(s => [s.threadId, s.parts.map(p => p.date)]), [['T-cease', ['2026-09-15']]]);
  assert.deepEqual(sofar.ranking, ['T-cease']);
  assert.equal(storySoFar(story, '2026-09-18').stories.length, 2);
  assert.deepEqual(storySoFar(null, '2026-09-18'), { stories: [], ranking: [] });
  // The input is not touched.
  assert.equal(story.stories[0].parts.length, 2);
});

// ---- the prompt ----

test('the prompt carries the definition verbatim, the four checks, the budget and the minimum', () => {
  const prompt = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17'), EMPTY_STORY);
  assert.ok(prompt.includes(STORY_DEFINITION));
  for (const check of ['verified', 'material change', 'consequences', 'lasting']) {
    assert.ok(prompt.toLowerCase().includes(check), check);
  }
  assert.ok(prompt.includes('2026-W38'));
  assert.ok(prompt.includes('2026-09-14') && prompt.includes('2026-09-20'));
  assert.ok(prompt.includes('at most 5'));
  assert.ok(prompt.includes('The budget is a ceiling, not a target: rank fewer when fewer qualify'));
  const month = buildStoryPrompt(MONTH, '2026-09-17', [], EMPTY_STORY);
  assert.ok(month.includes('at most 20'));
  assert.ok(month.includes('3 or more editions'));
});

test('the prompt carries the writing rules', () => {
  const prompt = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17'), EMPTY_STORY);
  assert.ok(prompt.includes('Plain past-tense newspaper English. No markdown'));
  assert.ok(prompt.includes('Only facts present in the evidence'));
  assert.match(prompt, /backstory: .*told from its start in the period up to this edition/);
  assert.match(prompt, /update: .*Tell only what is new, and open by joining to the story so far/);
});

test('the prompt carries full bodies only for articles dated d, and never source posts', () => {
  const prompt = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17'), EMPTY_STORY);
  assert.ok(prompt.includes('Body of c2, first paragraph.'));
  assert.ok(!prompt.includes('Body of c1'));
  assert.ok(prompt.includes('Headline c1'));
  assert.ok(prompt.includes('Dek c1'));
  assert.ok(prompt.includes('Development of c1'));
  assert.ok(!prompt.includes('https://x/0'));
});

test("the prompt's bar changes with the period kind", () => {
  const prompts = {};
  for (const kind of ['week', 'month', 'quarter', 'year']) {
    prompts[kind] = buildStoryPrompt({ ...WEEK, kind }, '2026-09-17', [], EMPTY_STORY);
    assert.ok(prompts[kind].includes(BARS[kind]), kind);
    assert.ok(prompts[kind].includes(`at most ${BUDGETS[kind]}`), kind);
  }
  assert.ok(!prompts.week.includes(BARS.year));
  assert.match(BARS.month, /most week-level stories do not qualify/);
  assert.match(BARS.year, /expect very few/);
});

test('the prompt shows the current ranking and the text already written for each story', () => {
  const story = {
    stories: [written('T-cease', [
      part('2026-09-15', 'backstory', { paragraphs: ['Envoys met on Monday.'] }),
      part('2026-09-16', 'update', { paragraphs: ['Talks resumed on Tuesday.'] }),
    ], 'Talks open in Doha')],
    ranking: ['T-cease'],
  };
  const prompt = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17', story), story);
  assert.ok(prompt.includes('1. T-cease: Talks open in Doha'));
  assert.ok(prompt.includes('Envoys met on Monday.'));
  assert.ok(prompt.includes('[2026-09-16] update:'));
  assert.ok(prompt.includes('Talks resumed on Tuesday.'));
  assert.match(prompt, /ranked now: #1\nwritten: yes/);
  assert.match(prompt, /threadId: T-court\n[\s\S]*?ranked now: no\nwritten: no/);
  assert.ok(buildStoryPrompt(WEEK, '2026-09-17', [], EMPTY_STORY).includes('No story is ranked yet.'));
});

test('the prompt names the grace window only when d is after the period', () => {
  const inside = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17'), EMPTY_STORY);
  assert.ok(!inside.includes('the period is over'));
  const grace = buildStoryPrompt(WEEK, '2026-09-22', evidenceFor('2026-09-22'), EMPTY_STORY);
  assert.ok(grace.includes('the period is over; you may only admit stories whose events happened on or before 2026-09-20'));
  assert.ok(grace.includes('Do not write any "update" or "correction"'));
});

test('the prompt says so when there is no candidate', () => {
  assert.match(buildStoryPrompt(WEEK, '2026-09-14', [], EMPTY_STORY), /no candidate threads/i);
});

// ---- the validator: the ranking ----

test('ranking ids must be candidates, each once, cut to the budget', () => {
  const days = ['2026-09-14', '2026-09-15'];
  const threads = Array.from({ length: 7 }, (_, i) => ({ threadId: `T${i}`, title: `T${i}`, category: 'world' }));
  const articles = threads.flatMap(t => days.map(date => article(`${t.threadId}-${date}`, t.threadId, date, { sourcePosts: sources(2) })));
  const ev = buildEvidence(WEEK, '2026-09-15', threads, articles, EMPTY_STORY);
  const ids = ['T6', 'T6', 'nope', 'T0', 'T1', 'T2', 'T3', 'T4', 'T5'];
  const out = validateRanking(
    reply(ids, ids.map(id => backstory(id, { articleIds: [`${id}-2026-09-15`] }))),
    WEEK, '2026-09-15', ev, EMPTY_STORY
  );
  assert.deepEqual(out.ranking, ['T6', 'T0', 'T1', 'T2', 'T3']);
  assert.deepEqual(out.backstories.map(b => b.threadId), out.ranking);
});

test('a thread on too few editions is never ranked, whatever the model says', () => {
  const out = validateRanking(
    reply(['T-rupee'], [backstory('T-rupee', { articleIds: ['r1'] })]),
    WEEK, '2026-09-17', evidenceFor('2026-09-17'), EMPTY_STORY
  );
  assert.deepEqual(out, { ranking: [], backstories: [], updates: [] });
});

test('a ranked thread with no written story and no valid backstory leaves the ranking', () => {
  const d = '2026-09-17';
  const out = validateRanking(
    reply(['T-cease', 'T-court'], [backstory('T-court', { articleIds: ['k1'], verification: 'official', basis: 'the Supreme Court ordered the ministry' })]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.deepEqual(out.ranking, ['T-court']);
});

test('a written story stays ranked with no backstory, and a backstory offered for it is ignored', () => {
  const d = '2026-09-17';
  const story = { stories: [written('T-cease', [part('2026-09-15')])], ranking: [] };
  const out = validateRanking(
    reply(['T-cease'], [backstory('T-cease', { articleIds: ['c2'] })]),
    WEEK, d, evidenceFor(d, story), story
  );
  // A story that dropped out comes back with its own text; no new backstory.
  assert.deepEqual(out, { ranking: ['T-cease'], backstories: [], updates: [] });
});

test('a backstory for a thread that is not ranked is dropped', () => {
  const d = '2026-09-17';
  const out = validateRanking(reply([], [backstory('T-cease', { articleIds: ['c2'] })]), WEEK, d, evidenceFor(d), EMPTY_STORY);
  assert.deepEqual(out, { ranking: [], backstories: [], updates: [] });
});

// ---- the validator: verified ----

test('one source and no official basis is never admitted', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  for (const extra of [{}, { verification: 'official' }, { verification: 'official', basis: 'The government confirmed the figures.' }, { verification: 'official', basis: 'Supreme Court' }]) {
    const out = validateRanking(reply(['T-flood'], [backstory('T-flood', { articleIds: ['f2'], ...extra })]), WEEK, d, ev, EMPTY_STORY);
    assert.deepEqual(out.ranking, [], JSON.stringify(extra));
  }
});

test('one source with an official basis quoted from the evidence is admitted', () => {
  const d = '2026-09-17';
  const out = validateRanking(
    reply(['T-court'], [backstory('T-court', {
      articleIds: ['k1', 'k2'], verification: 'official',
      basis: '"the Supreme Court ordered the ministry to suspend the data rule"',
    })]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.equal(out.backstories[0].part.verification, 'official');
  assert.match(out.backstories[0].part.basis, /Supreme Court/);
});

test('two sources verify a backstory, and what is stored is exactly this', () => {
  const d = '2026-09-17';
  const out = validateRanking(reply(['T-cease'], [backstory('T-cease', { articleIds: ['c1', 'c2'] })]), WEEK, d, evidenceFor(d), EMPTY_STORY);
  assert.deepEqual(out, {
    ranking: ['T-cease'],
    backstories: [{
      threadId: 'T-cease',
      headline: 'About T-cease',
      part: {
        kind: 'backstory',
        paragraphs: ['It happened.'],
        articleIds: ['c1', 'c2'],
        verification: 'sources',
        why: 'verified, material, consequential, lasting',
      },
    }],
    updates: [],
  });
});

// ---- the validator: updates ----

const STORY = {
  stories: [written('T-cease', [part('2026-09-15')]), written('T-court', [part('2026-09-16')])],
  ranking: ['T-cease', 'T-court'],
};

test('update and correction are kept for a ranked thread with a written story', () => {
  const d = '2026-09-17';
  for (const kind of ['update', 'correction']) {
    const out = validateRanking(reply(['T-cease'], [], [update('T-cease', { kind, articleIds: ['c2'] })]), WEEK, d, evidenceFor(d, STORY), STORY);
    assert.deepEqual(out.updates, [{ threadId: 'T-cease', part: { kind, paragraphs: ['Then more happened.'], articleIds: ['c2'], why: 'new facts' } }], kind);
  }
});

test('an update for an unranked, unwritten or unknown thread, or of an unknown kind, is dropped', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d, STORY);
  const drop = (ranking, u) => validateRanking(reply(ranking, [], [u]), WEEK, d, ev, STORY).updates;
  assert.deepEqual(drop(['T-cease'], update('T-court', { articleIds: ['k2'] })), []);
  assert.deepEqual(drop(['T-flood'], update('T-flood', { articleIds: ['f2'] })), []);
  assert.deepEqual(drop(['T-cease'], update('T-made-up', { articleIds: ['c2'] })), []);
  assert.deepEqual(drop(['T-cease'], update('T-cease', { kind: 'backstory', articleIds: ['c2'] })), []);
  assert.deepEqual(drop(['T-cease'], update('T-cease', { kind: 'feature', articleIds: ['c2'] })), []);
});

test('at most one update per thread; the first valid one wins', () => {
  const d = '2026-09-17';
  const out = validateRanking(
    reply(['T-cease'], [], [
      update('T-cease', { articleIds: ['nope'] }),
      update('T-cease', { kind: 'correction', articleIds: ['c2'] }),
      update('T-cease', { articleIds: ['c2'], paragraphs: ['Again.'] }),
    ]),
    WEEK, d, evidenceFor(d, STORY), STORY
  );
  assert.deepEqual(out.updates.map(u => u.part.kind), ['correction']);
});

test('a grace-window run may rank and admit, but writes no update or correction', () => {
  const articles = [
    article('c1', 'T-cease', '2026-09-15', { sourcePosts: sources(2) }),
    article('c2', 'T-cease', '2026-09-19'),
    article('c3', 'T-cease', '2026-09-21'),
    article('f1', 'T-flood', '2026-09-18', { sourcePosts: sources(2) }),
    article('f2', 'T-flood', '2026-09-19'),
  ];
  const story = { stories: [written('T-flood', [part('2026-09-18')])], ranking: ['T-flood'] };
  const d = '2026-09-21';
  const out = validateRanking(
    reply(['T-cease', 'T-flood'], [backstory('T-cease', { articleIds: ['c1', 'c3'] })], [
      update('T-flood', { articleIds: ['f2'] }),
      update('T-flood', { kind: 'correction', articleIds: ['f2'] }),
    ]),
    WEEK, d, evidenceFor(d, story, articles), story
  );
  assert.deepEqual(out.ranking, ['T-cease', 'T-flood']);
  assert.deepEqual(out.updates, []);
  // The grace edition is evidence, but is not cited: it is after the period.
  assert.deepEqual(out.backstories[0].part.articleIds, ['c1']);
});

// ---- the validator: article ids and text ----

test('article ids outside the thread, after d or outside the period are removed', () => {
  const articles = [
    article('before', 'T-cease', '2026-09-10'),
    article('c1', 'T-cease', '2026-09-15', { sourcePosts: sources(2) }),
    article('c2', 'T-cease', '2026-09-17'),
    article('c3', 'T-cease', '2026-09-18'),
    article('f1', 'T-flood', '2026-09-16'),
  ];
  const d = '2026-09-17';
  const out = validateRanking(
    reply(['T-cease'], [backstory('T-cease', { articleIds: ['f1', 'c3', 'before', 'nope', 'c2', 'c1', 'c2'] })]),
    WEEK, d, evidenceFor(d, EMPTY_STORY, articles), EMPTY_STORY
  );
  assert.deepEqual(out.backstories[0].part.articleIds, ['c2', 'c1']);
});

test('a backstory or update whose article ids are all removed is dropped', () => {
  const d = '2026-09-17';
  for (const ids of [['f1', 'r1'], [], 'c1']) {
    const out = validateRanking(reply(['T-cease'], [backstory('T-cease', { articleIds: ids })]), WEEK, d, evidenceFor(d), EMPTY_STORY);
    assert.deepEqual(out.ranking, [], JSON.stringify(ids));
    const up = validateRanking(reply(['T-cease'], [], [update('T-cease', { articleIds: ids })]), WEEK, d, evidenceFor(d, STORY), STORY);
    assert.deepEqual(up.updates, [], JSON.stringify(ids));
  }
});

test('no headline, or no non-empty paragraph, drops a backstory', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  for (const extra of [{ headline: '  ' }, { paragraphs: ['', '  ', 7] }, { paragraphs: 'It happened.' }]) {
    const out = validateRanking(reply(['T-cease'], [backstory('T-cease', { articleIds: ['c2'], ...extra })]), WEEK, d, ev, EMPTY_STORY);
    assert.deepEqual(out.ranking, [], JSON.stringify(extra));
  }
});

test('paragraphs are trimmed, emptied ones removed, and capped at four', () => {
  const d = '2026-09-17';
  const out = validateRanking(
    reply(['T-cease'], [backstory('T-cease', { articleIds: ['c2'], paragraphs: [' One. ', '', 'Two.', 'Three.', 'Four.', 'Five.'] })]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.equal(MAX_PARAGRAPHS, 4);
  assert.deepEqual(out.backstories[0].part.paragraphs, ['One.', 'Two.', 'Three.', 'Four.']);
});

test("a story admitted by today's run is not written yet, so a re-run today writes its backstory again", () => {
  const d = '2026-09-17';
  const story = { stories: [written('T-cease', [part(d)])], ranking: ['T-cease'] };
  const ev = evidenceFor(d, story);
  assert.equal(ev.find(t => t.threadId === 'T-cease').written, false);
  const out = validateRanking(reply(['T-cease'], [backstory('T-cease', { articleIds: ['c2'] })]), WEEK, d, ev, story);
  assert.equal(out.backstories.length, 1);
});

// ---- the validator: unusable replies ----

test('a reply with no ranking is unusable; an empty ranking is a normal answer', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  for (const bad of [null, undefined, '', 'no json here', '{"ranking": "none"}', '{}', '[]', 42, '{"entries": []}']) {
    assert.equal(validateRanking(bad, WEEK, d, ev, EMPTY_STORY), null, String(bad));
  }
  assert.deepEqual(validateRanking('{"ranking": []}', WEEK, d, ev, EMPTY_STORY), { ranking: [], backstories: [], updates: [] });
  assert.deepEqual(validateRanking(reply([null, 3, {}], [null, 'x'], [7]), WEEK, d, ev, EMPTY_STORY), { ranking: [], backstories: [], updates: [] });
});

test('a fenced reply, or an already parsed one, is accepted', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  const text = reply(['T-cease'], [backstory('T-cease', { articleIds: ['c2'] })]);
  assert.deepEqual(validateRanking('```json\n' + text + '\n```', WEEK, d, ev, EMPTY_STORY).ranking, ['T-cease']);
  assert.deepEqual(validateRanking(JSON.parse(text), WEEK, d, ev, EMPTY_STORY).ranking, ['T-cease']);
});
