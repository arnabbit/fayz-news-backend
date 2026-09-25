const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STORY_DEFINITION,
  BARS,
  MIN_SOURCES,
  MIN_EDITIONS,
  MAX_PARAGRAPHS,
  admittedThreads,
  buildEvidence,
  buildStoryPrompt,
  validateSection,
} = require('../story');

const WEEK = { id: '2026-W38', kind: 'week', range: { from: '2026-09-14', to: '2026-09-20' } };

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

// T-cease: two editions, two sources in total. Passes both code checks.
// T-rupee: one edition, many sources. Fails "lasting".
// T-flood: two editions, one source in total. Fails "verified" without a basis.
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

const EMPTY_STORY = { sections: [] };

function evidenceFor(d, story = EMPTY_STORY, articles = ARTICLES, period = WEEK) {
  return buildEvidence(period, d, THREADS, articles, story);
}

const entry = (threadId, kind, extra = {}) => ({
  threadId,
  kind,
  headline: `About ${threadId}`,
  paragraphs: ['It happened.'],
  articleIds: [],
  why: 'verified, material, consequential, lasting',
  ...extra,
});

const reply = entries => JSON.stringify({ entries });

// ---- evidence ----

test('evidence counts sources and distinct editions per thread, up to d', () => {
  const ev = evidenceFor('2026-09-17');
  const byId = new Map(ev.map(t => [t.threadId, t]));
  assert.equal(byId.get('T-cease').totalSources, 2);
  assert.equal(byId.get('T-cease').editionCount, 2);
  assert.equal(byId.get('T-rupee').totalSources, 5);
  assert.equal(byId.get('T-rupee').editionCount, 1);
  assert.equal(byId.get('T-flood').totalSources, 1);

  const early = new Map(evidenceFor('2026-09-15').map(t => [t.threadId, t]));
  assert.deepEqual([...early.keys()], ['T-cease']);
  assert.equal(early.get('T-cease').editionCount, 1);
});

test('evidence leaves out threads with nothing in the period, hidden articles and articles after d', () => {
  const articles = [
    article('old', 'T-rupee', '2026-09-10'),
    article('h1', 'T-flood', '2026-09-15', { hidden: true }),
    article('late', 'T-court', '2026-09-19'),
    article('c1', 'T-cease', '2026-09-15'),
  ];
  const ev = evidenceFor('2026-09-17', EMPTY_STORY, articles);
  assert.deepEqual(ev.map(t => t.threadId), ['T-cease']);
});

test('a thread seen only in the grace window is not evidence; grace articles of a period thread are', () => {
  const articles = [
    article('c1', 'T-cease', '2026-09-19'),
    article('c2', 'T-cease', '2026-09-21'),
    article('g1', 'T-rupee', '2026-09-21'),
  ];
  const ev = evidenceFor('2026-09-22', EMPTY_STORY, articles);
  assert.deepEqual(ev.map(t => t.threadId), ['T-cease']);
  assert.equal(ev[0].editionCount, 2);
  const grace = ev[0].articles.find(a => a.id === 'c2');
  assert.equal(grace.inPeriod, false);
});

test('evidence keeps full bodies only for articles dated d', () => {
  const ev = evidenceFor('2026-09-17');
  const cease = ev.find(t => t.threadId === 'T-cease');
  assert.equal(cease.articles.find(a => a.id === 'c1').body, null);
  assert.deepEqual(cease.articles.find(a => a.id === 'c2').body, [
    'Body of c2, first paragraph.', 'Body of c2, second paragraph.',
  ]);
});

test('admitted threads come from the new entries of sections before d', () => {
  const story = {
    sections: [
      { date: '2026-09-16', entries: [entry('T-cease', 'new'), entry('T-flood', 'update')] },
      { date: '2026-09-17', entries: [entry('T-rupee', 'new')] },
    ],
  };
  assert.deepEqual([...admittedThreads(story, '2026-09-17')], ['T-cease']);
  assert.deepEqual([...admittedThreads(story, '2026-09-18')].sort(), ['T-cease', 'T-rupee']);
  assert.deepEqual([...admittedThreads(null, '2026-09-18')], []);
});

// ---- the prompt ----

test('the prompt carries the definition verbatim and the four checks', () => {
  const prompt = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17'), EMPTY_STORY);
  assert.ok(prompt.includes(STORY_DEFINITION));
  for (const check of ['verified', 'material change', 'consequences', 'lasting']) {
    assert.ok(prompt.toLowerCase().includes(check), check);
  }
  assert.ok(prompt.includes('2026-W38'));
  assert.ok(prompt.includes('2026-09-14') && prompt.includes('2026-09-20'));
});

test('the prompt carries full bodies only for articles dated d', () => {
  const prompt = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17'), EMPTY_STORY);
  assert.ok(prompt.includes('Body of c2, first paragraph.'));
  assert.ok(prompt.includes('Body of c2, second paragraph.'));
  assert.ok(!prompt.includes('Body of c1'));
  assert.ok(!prompt.includes('Body of f1'));
  // The rest of an earlier article's trail is still there.
  assert.ok(prompt.includes('Headline c1'));
  assert.ok(prompt.includes('Dek c1'));
  assert.ok(prompt.includes('Development of c1'));
});

test('the prompt never carries source posts', () => {
  const articles = [article('c1', 'T-cease', '2026-09-17', { sourcePosts: [{ postUrl: 'https://secret/1' }] })];
  const prompt = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17', EMPTY_STORY, articles), EMPTY_STORY);
  assert.ok(!prompt.includes('https://secret/1'));
});

test("the prompt's bar changes with the period kind", () => {
  const prompts = {};
  for (const kind of ['week', 'month', 'quarter', 'year']) {
    const period = { ...WEEK, kind };
    prompts[kind] = buildStoryPrompt(period, '2026-09-17', evidenceFor('2026-09-17', EMPTY_STORY, ARTICLES, period), EMPTY_STORY);
    assert.ok(prompts[kind].includes(BARS[kind]), kind);
  }
  assert.ok(!prompts.week.includes(BARS.year));
  assert.ok(!prompts.year.includes(BARS.week));
  assert.match(BARS.month, /most week-level stories do not qualify/);
  assert.match(BARS.year, /expect very few/);
});

test('the prompt shows what is already written for an admitted thread', () => {
  const story = {
    sections: [{
      date: '2026-09-15',
      entries: [entry('T-cease', 'new', { headline: 'Talks open in Doha', paragraphs: ['Envoys met on Monday.'] })],
    }],
  };
  const prompt = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17', story), story);
  assert.ok(prompt.includes('Talks open in Doha'));
  assert.ok(prompt.includes('Envoys met on Monday.'));
  assert.match(prompt, /admitted: yes/);
});

test('the prompt names the grace window only when d is after the period', () => {
  const inside = buildStoryPrompt(WEEK, '2026-09-17', evidenceFor('2026-09-17'), EMPTY_STORY);
  assert.ok(!inside.includes('the period is over'));
  const grace = buildStoryPrompt(WEEK, '2026-09-22', evidenceFor('2026-09-22'), EMPTY_STORY);
  assert.ok(grace.includes('the period is over; you may only admit stories whose events happened on or before 2026-09-20'));
  assert.ok(grace.includes('Later editions are evidence only'));
});

test('the prompt says so when there is no evidence', () => {
  const prompt = buildStoryPrompt(WEEK, '2026-09-14', [], EMPTY_STORY);
  assert.match(prompt, /no threads/i);
});

// ---- the validator: the code-enforced checks ----

test('a thread on one edition only is never admitted, whatever the model says', () => {
  const d = '2026-09-17';
  const section = validateSection(
    reply([entry('T-rupee', 'new', { articleIds: ['r1'], verification: 'official', basis: 'Headline r1' })]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.equal(section, null);
});

test('a thread with one source and no official basis is never admitted', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  assert.equal(validateSection(reply([entry('T-flood', 'new', { articleIds: ['f2'] })]), WEEK, d, ev, EMPTY_STORY), null);
  assert.equal(
    validateSection(reply([entry('T-flood', 'new', { articleIds: ['f2'], verification: 'official' })]), WEEK, d, ev, EMPTY_STORY),
    null
  );
  // A basis that quotes nothing in the thread's evidence is not a basis.
  assert.equal(
    validateSection(reply([entry('T-flood', 'new', {
      articleIds: ['f2'], verification: 'official', basis: 'The government confirmed the figures.',
    })]), WEEK, d, ev, EMPTY_STORY),
    null
  );
});

test('one source with an official basis quoted from the evidence is admitted', () => {
  const d = '2026-09-17';
  const section = validateSection(
    reply([entry('T-court', 'new', {
      articleIds: ['k1', 'k2'], verification: 'official',
      basis: '"the Supreme Court ordered the ministry to suspend the data rule"',
    })]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.equal(section.entries.length, 1);
  assert.equal(section.entries[0].verification, 'official');
  assert.match(section.entries[0].basis, /Supreme Court/);
});

test('two sources and two editions admit a thread', () => {
  const d = '2026-09-17';
  const section = validateSection(
    reply([entry('T-cease', 'new', { articleIds: ['c1', 'c2'] })]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.deepEqual(section, {
    date: d,
    entries: [{
      threadId: 'T-cease',
      kind: 'new',
      headline: 'About T-cease',
      paragraphs: ['It happened.'],
      articleIds: ['c1', 'c2'],
      continuesFrom: null,
      verification: 'sources',
      why: 'verified, material, consequential, lasting',
    }],
  });
});

// ---- the validator: admitted or not ----

const ADMITTED_STORY = {
  sections: [
    { date: '2026-09-15', entries: [entry('T-cease', 'new', { articleIds: ['c1'] })] },
    { date: '2026-09-16', entries: [entry('T-cease', 'update', { articleIds: ['c1'] })] },
  ],
};

test('update or correction for a non-admitted thread is dropped', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  for (const kind of ['update', 'correction']) {
    assert.equal(validateSection(reply([entry('T-court', kind, { articleIds: ['k2'] })]), WEEK, d, ev, EMPTY_STORY), null, kind);
  }
});

test('new for an admitted thread is dropped', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d, ADMITTED_STORY);
  assert.equal(validateSection(reply([entry('T-cease', 'new', { articleIds: ['c2'] })]), WEEK, d, ev, ADMITTED_STORY), null);
});

test('update and correction for an admitted thread are kept', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d, ADMITTED_STORY);
  for (const kind of ['update', 'correction']) {
    const section = validateSection(reply([entry('T-cease', kind, { articleIds: ['c2'] })]), WEEK, d, ev, ADMITTED_STORY);
    assert.equal(section.entries.length, 1, kind);
    assert.equal(section.entries[0].kind, kind);
  }
});

test('an unknown thread or kind is dropped', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  assert.equal(validateSection(reply([entry('T-made-up', 'new', { articleIds: ['c2'] })]), WEEK, d, ev, EMPTY_STORY), null);
  assert.equal(validateSection(reply([entry('T-cease', 'feature', { articleIds: ['c2'] })]), WEEK, d, ev, EMPTY_STORY), null);
});

test('a bad entry is dropped, never the whole section', () => {
  const d = '2026-09-17';
  const section = validateSection(
    reply([
      entry('T-rupee', 'new', { articleIds: ['r1'] }),
      entry('T-cease', 'new', { articleIds: ['c2'] }),
      entry('T-flood', 'update', { articleIds: ['f2'] }),
    ]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.deepEqual(section.entries.map(e => e.threadId), ['T-cease']);
});

test('stored order is the model order, and a second entry for one thread is dropped', () => {
  const d = '2026-09-17';
  const section = validateSection(
    reply([
      entry('T-court', 'new', { articleIds: ['k2'], verification: 'official', basis: 'the Supreme Court ordered the ministry' }),
      entry('T-cease', 'new', { articleIds: ['c2'] }),
      entry('T-court', 'new', { articleIds: ['k1'], headline: 'Again' }),
    ]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.deepEqual(section.entries.map(e => e.threadId), ['T-court', 'T-cease']);
  assert.deepEqual(section.entries[0].articleIds, ['k2']);
});

// ---- the validator: the grace window ----

test('grace-window runs keep only new entries', () => {
  const articles = [
    article('c1', 'T-cease', '2026-09-15', { sourcePosts: sources(2) }),
    article('c2', 'T-cease', '2026-09-21'),
    article('f1', 'T-flood', '2026-09-18', { sourcePosts: sources(2) }),
    article('f2', 'T-flood', '2026-09-19'),
  ];
  const story = { sections: [{ date: '2026-09-18', entries: [entry('T-flood', 'new', { articleIds: ['f1'] })] }] };
  const d = '2026-09-21';
  const ev = evidenceFor(d, story, articles);
  const section = validateSection(
    reply([
      entry('T-flood', 'update', { articleIds: ['f2'] }),
      entry('T-cease', 'new', { articleIds: ['c1', 'c2'] }),
      entry('T-flood', 'correction', { articleIds: ['f2'] }),
    ]),
    WEEK, d, ev, story
  );
  assert.deepEqual(section.entries.map(e => [e.threadId, e.kind]), [['T-cease', 'new']]);
  // The grace edition made it lasting, but is not cited: it is after the period.
  assert.deepEqual(section.entries[0].articleIds, ['c1']);
});

// ---- the validator: article ids ----

test('article ids outside the thread, after d or outside the period are removed', () => {
  const articles = [
    article('before', 'T-cease', '2026-09-10'),
    article('c1', 'T-cease', '2026-09-15', { sourcePosts: sources(2) }),
    article('c2', 'T-cease', '2026-09-17'),
    article('c3', 'T-cease', '2026-09-18'),
    article('f1', 'T-flood', '2026-09-16'),
  ];
  const d = '2026-09-17';
  const section = validateSection(
    reply([entry('T-cease', 'new', { articleIds: ['f1', 'c3', 'before', 'nope', 'c2', 'c1', 'c2'] })]),
    WEEK, d, evidenceFor(d, EMPTY_STORY, articles), EMPTY_STORY
  );
  assert.deepEqual(section.entries[0].articleIds, ['c2', 'c1']);
});

test('an entry whose article ids are all removed is dropped', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  assert.equal(validateSection(reply([entry('T-cease', 'new', { articleIds: ['f1', 'r1'] })]), WEEK, d, ev, EMPTY_STORY), null);
  assert.equal(validateSection(reply([entry('T-cease', 'new', { articleIds: [] })]), WEEK, d, ev, EMPTY_STORY), null);
  assert.equal(validateSection(reply([entry('T-cease', 'new', { articleIds: 'c1' })]), WEEK, d, ev, EMPTY_STORY), null);
});

// ---- the validator: text ----

test('no headline, or no non-empty paragraph, drops the entry', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  const base = { articleIds: ['c2'] };
  assert.equal(validateSection(reply([entry('T-cease', 'new', { ...base, headline: '  ' })]), WEEK, d, ev, EMPTY_STORY), null);
  assert.equal(validateSection(reply([entry('T-cease', 'new', { ...base, paragraphs: ['', '  ', 7] })]), WEEK, d, ev, EMPTY_STORY), null);
  assert.equal(validateSection(reply([entry('T-cease', 'new', { ...base, paragraphs: 'It happened.' })]), WEEK, d, ev, EMPTY_STORY), null);
});

test('paragraphs are trimmed, emptied ones removed, and capped at four', () => {
  const d = '2026-09-17';
  const section = validateSection(
    reply([entry('T-cease', 'new', { articleIds: ['c2'], paragraphs: [' One. ', '', 'Two.', 'Three.', 'Four.', 'Five.'] })]),
    WEEK, d, evidenceFor(d), EMPTY_STORY
  );
  assert.equal(MAX_PARAGRAPHS, 4);
  assert.deepEqual(section.entries[0].paragraphs, ['One.', 'Two.', 'Three.', 'Four.']);
});

// ---- the validator: continuesFrom ----

test('continuesFrom points at the thread\'s previous section date', () => {
  const story = {
    sections: [
      { date: '2026-09-15', entries: [entry('T-cease', 'new', { articleIds: ['c1'] })] },
      { date: '2026-09-16', entries: [entry('T-cease', 'update', { articleIds: ['c1'] }), entry('T-court', 'new')] },
      { date: '2026-09-17', entries: [entry('T-court', 'update')] },
    ],
  };
  const d = '2026-09-18';
  const articles = [...ARTICLES, article('c3', 'T-cease', d), article('k3', 'T-court', d)];
  const section = validateSection(
    reply([
      entry('T-cease', 'update', { articleIds: ['c3'] }),
      entry('T-court', 'correction', { articleIds: ['k3'] }),
    ]),
    WEEK, d, evidenceFor(d, story, articles), story
  );
  assert.deepEqual(section.entries.map(e => [e.threadId, e.continuesFrom]), [
    ['T-cease', '2026-09-16'],
    ['T-court', '2026-09-17'],
  ]);
});

test("a section already dated d is not the story so far, so today's section can be rewritten", () => {
  const d = '2026-09-17';
  const story = { sections: [{ date: d, entries: [entry('T-cease', 'new', { articleIds: ['c2'] })] }] };
  const ev = evidenceFor(d, story);
  assert.equal(ev.find(t => t.threadId === 'T-cease').admitted, false);
  const section = validateSection(reply([entry('T-cease', 'new', { articleIds: ['c2'] })]), WEEK, d, ev, story);
  assert.equal(section.entries[0].continuesFrom, null);
});

// ---- the validator: unusable replies ----

test('an empty or unusable reply yields no section', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  for (const bad of [null, undefined, '', 'no json here', '{"entries": "none"}', '{}', '[]', 42,
    reply([]), reply([null, 'x', 3])]) {
    assert.equal(validateSection(bad, WEEK, d, ev, EMPTY_STORY), null, String(bad));
  }
});

test('a fenced reply, or an already parsed one, is accepted', () => {
  const d = '2026-09-17';
  const ev = evidenceFor(d);
  const e = entry('T-cease', 'new', { articleIds: ['c2'] });
  const fenced = '```json\n' + reply([e]) + '\n```';
  assert.equal(validateSection(fenced, WEEK, d, ev, EMPTY_STORY).entries.length, 1);
  assert.equal(validateSection({ entries: [e] }, WEEK, d, ev, EMPTY_STORY).entries.length, 1);
});

test('the code-enforced thresholds are the ones the ticket names', () => {
  assert.equal(MIN_SOURCES, 2);
  assert.equal(MIN_EDITIONS, 2);
});
