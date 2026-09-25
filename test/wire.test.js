const test = require('node:test');
const assert = require('node:assert/strict');
const { toFeedItem, toArticle } = require('../wire');

const doc = {
  _id: 'mongo-oid',
  id: 'abc123',
  headline: 'A headline',
  category: 'Politics',
  body: ['Paragraph one.', 'Paragraph two.'],
  developments: [{ summary: 'One', sourcePostUrls: ['u'] }, { summary: '' }],
  sourcePosts: [{ postUrl: 'https://x/p/1', sourceHeadline: 'Src', postNumber: 3, slideCount: 2 }],
  _dateKey: '2026-08-27',
  published_date: 'August 27, 2026',
  _createdAt: new Date(0),
};

test('a feed item carries no body', () => {
  const item = toFeedItem(doc);
  assert.equal(item.body, undefined);
  assert.deepEqual(Object.keys(item).sort(), [
    'category', 'dek', 'developmentCount', 'edition', 'headline', 'id', 'sourceCount',
  ]);
});

test('edition is the only date on the wire', () => {
  const item = toFeedItem(doc);
  assert.equal(item.edition, '2026-08-27');
  assert.equal(item.published_date, undefined);
});

test('internal fields never reach the wire', () => {
  const article = toArticle(doc);
  for (const field of ['_id', '_dateKey', '_createdAt', 'published_date', 'hidden']) {
    assert.equal(article[field], undefined, field);
  }
});

test('counts come from the arrays, not from a stored number', () => {
  const item = toFeedItem(doc);
  assert.equal(item.developmentCount, 2);
  assert.equal(item.sourceCount, 1);
});

test('developments and sourcePosts are trimmed to what a screen renders', () => {
  const article = toArticle(doc);
  assert.deepEqual(article.developments, [{ summary: 'One' }]);
  assert.deepEqual(article.sourcePosts, [{ postUrl: 'https://x/p/1', sourceHeadline: 'Src' }]);
});

test('a missing array is an empty array, never undefined', () => {
  const article = toArticle({ id: 'x', headline: 'h', category: 'world', _dateKey: '2026-01-01' });
  assert.deepEqual(article.body, []);
  assert.deepEqual(article.developments, []);
  assert.deepEqual(article.sourcePosts, []);
  assert.equal(article.dek, '');
});

// ---- the period ----

const { toPeriod, toStory, storyArticleIds } = require('../wire');
const { parsePeriodId } = require('../period');

const entry = (threadId, articleIds, extra = {}) => ({
  threadId,
  kind: 'new',
  headline: `Headline ${threadId}`,
  paragraphs: [`Paragraph for ${threadId}.`],
  articleIds,
  continuesFrom: null,
  verification: 'sources',
  basis: 'A quoted order.',
  why: 'Three editions, four sources.',
  ...extra,
});

const storedStory = {
  _id: 'mongo-oid',
  periodId: '2026-W38',
  admitted: ['t2', 't1'],
  throughDate: '2026-09-16',
  seenUpTo: new Date(0),
  attempts: { '2026-09-17': 1 },
  sections: [
    {
      date: '2026-09-15',
      writtenAt: new Date(0),
      model: 'some/model',
      entries: [entry('t2', ['a3', 'a1']), entry('t1', ['a2'])],
    },
    {
      date: '2026-09-16',
      writtenAt: new Date(0),
      model: 'some/model',
      entries: [entry('t2', ['a4'], { kind: 'update', continuesFrom: '2026-09-15' })],
    },
  ],
};

const allVisible = new Set(['a1', 'a2', 'a3', 'a4']);

test('the story keeps stored order for sections and entries', () => {
  const story = toStory(storedStory, allVisible);
  assert.deepEqual(story.sections.map(s => s.date), ['2026-09-15', '2026-09-16']);
  assert.deepEqual(story.sections[0].entries.map(e => e.threadId), ['t2', 't1']);
  assert.deepEqual(story.sections[0].entries[0].articleIds, ['a3', 'a1']);
});

test('audit fields never reach the wire', () => {
  const story = toStory(storedStory, allVisible);
  assert.deepEqual(Object.keys(story), ['sections']);
  for (const section of story.sections) {
    assert.deepEqual(Object.keys(section).sort(), ['date', 'entries']);
    for (const e of section.entries) {
      assert.deepEqual(Object.keys(e).sort(), [
        'articleIds', 'continuesFrom', 'headline', 'kind', 'paragraphs', 'threadId',
      ]);
    }
  }
  assert.deepEqual(story.sections[1].entries[0], {
    threadId: 't2',
    kind: 'update',
    headline: 'Headline t2',
    paragraphs: ['Paragraph for t2.'],
    articleIds: ['a4'],
    continuesFrom: '2026-09-15',
  });
});

test('hidden article ids are removed, and an entry left with none is still served', () => {
  const story = toStory(storedStory, new Set(['a1', 'a4']));
  assert.deepEqual(story.sections[0].entries.map(e => e.articleIds), [['a1'], []]);
  assert.equal(story.sections[0].entries[1].headline, 'Headline t1');
  assert.deepEqual(story.sections[1].entries[0].articleIds, ['a4']);
});

test('a story with no run yet is an empty list of sections', () => {
  assert.deepEqual(toStory(null, new Set()), { sections: [] });
  assert.deepEqual(toStory({ sections: [] }, new Set()), { sections: [] });
});

test('the ids to check for visibility are every id the story cites, once', () => {
  assert.deepEqual(storyArticleIds(storedStory).sort(), ['a1', 'a2', 'a3', 'a4']);
  assert.deepEqual(storyArticleIds(null), []);
});

test('the period skeleton is unchanged, field for field', () => {
  const period = parsePeriodId('2026-W38');
  const facets = {
    byDay: [{ _id: '2026-09-16', count: 2 }, { _id: '2026-09-14', count: 3 }],
    byCategory: [
      { _id: 'world', count: 2 },
      { _id: 'business', count: 2 },
      { _id: 'politics', count: 1 },
    ],
  };
  const body = toPeriod({ period, facets, story: storedStory, visibleIds: allVisible, storyStatus: 'ready' });

  assert.deepEqual(Object.keys(body), [
    'id', 'kind', 'range', 'editionCount', 'articleCount', 'categories', 'timeline',
    'story', 'storyStatus',
  ]);
  assert.equal(body.prose, undefined);
  assert.equal(body.proseStatus, undefined);
  assert.equal(body.id, '2026-W38');
  assert.equal(body.kind, period.kind);
  assert.deepEqual(body.range, period.range);
  assert.equal(body.editionCount, 2);
  assert.equal(body.articleCount, 5);
  assert.deepEqual(body.categories, [
    { slug: 'business', name: 'Business', count: 2 },
    { slug: 'world', name: 'World', count: 2 },
    { slug: 'politics', name: 'Politics', count: 1 },
  ]);
  assert.equal(body.timeline.length, 7);
  assert.deepEqual(body.timeline.map(d => d.date), ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
  assert.deepEqual(body.timeline.map(d => d.count), [3, 0, 2, 0, 0, 0, 0]);
  assert.equal(body.storyStatus, 'ready');
  assert.equal(body.story.sections.length, 2);
});

test('an empty period serves the skeleton and an empty story', () => {
  const period = parsePeriodId('2026-W38');
  const body = toPeriod({ period, facets: undefined, story: null, visibleIds: new Set(), storyStatus: 'none' });
  assert.equal(body.editionCount, 0);
  assert.equal(body.articleCount, 0);
  assert.deepEqual(body.categories, []);
  assert.ok(body.timeline.every(d => d.count === 0));
  assert.deepEqual(body.story, { sections: [] });
  assert.equal(body.storyStatus, 'none');
});
