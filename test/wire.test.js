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

const part = (date, kind, articleIds, extra = {}) => ({
  date,
  kind,
  paragraphs: [`${kind} on ${date}.`],
  articleIds,
  verification: 'sources',
  basis: 'A quoted order.',
  why: 'Three editions, four sources.',
  writtenAt: new Date(0),
  model: 'some/model',
  ...extra,
});

const storedStory = {
  _id: 'mongo-oid',
  periodId: '2026-W38',
  throughDate: '2026-09-17',
  seenUpTo: new Date(0),
  attempts: { '2026-09-18': 1 },
  late: null,
  stories: [
    { threadId: 't1', headline: 'Headline t1', parts: [part('2026-09-15', 'backstory', ['a2'])] },
    {
      threadId: 't2',
      headline: 'Headline t2',
      parts: [part('2026-09-15', 'backstory', ['a3', 'a1']), part('2026-09-16', 'update', ['a4']), part('2026-09-17', 'correction', ['a4'])],
    },
    // Dropped out of the ranking: kept, never served.
    { threadId: 't3', headline: 'Headline t3', parts: [part('2026-09-16', 'backstory', ['a5'])] },
  ],
  ranking: ['t2', 't1'],
};

const allVisible = new Set(['a1', 'a2', 'a3', 'a4', 'a5']);

test('the story serves the ranked stories in ranking order, parts in stored order', () => {
  const story = toStory(storedStory, allVisible);
  assert.deepEqual(story.stories.map(s => s.threadId), ['t2', 't1']);
  assert.deepEqual(story.stories[0].parts.map(p => [p.date, p.kind]), [
    ['2026-09-15', 'backstory'], ['2026-09-16', 'update'], ['2026-09-17', 'correction'],
  ]);
  assert.deepEqual(story.stories[0].parts[0].articleIds, ['a3', 'a1']);
});

test('a story out of the ranking, or a ranked id with no story, is not served', () => {
  const story = toStory({ ...storedStory, ranking: ['t9', 't1', 't1'] }, allVisible);
  assert.deepEqual(story.stories.map(s => s.threadId), ['t1']);
  assert.equal(JSON.stringify(story).includes('t3'), false);
});

test('audit fields never reach the wire', () => {
  const story = toStory(storedStory, allVisible);
  assert.deepEqual(Object.keys(story), ['stories']);
  for (const s of story.stories) {
    assert.deepEqual(Object.keys(s), ['threadId', 'headline', 'parts']);
    for (const p of s.parts) assert.deepEqual(Object.keys(p), ['date', 'kind', 'paragraphs', 'articleIds']);
  }
  assert.deepEqual(story.stories[1], {
    threadId: 't1',
    headline: 'Headline t1',
    parts: [{ date: '2026-09-15', kind: 'backstory', paragraphs: ['backstory on 2026-09-15.'], articleIds: ['a2'] }],
  });
});

test('hidden article ids are removed, and a part left with none is still served', () => {
  const story = toStory(storedStory, new Set(['a1', 'a4']));
  assert.deepEqual(story.stories[0].parts.map(p => p.articleIds), [['a1'], ['a4'], ['a4']]);
  assert.deepEqual(story.stories[1].parts[0].articleIds, []);
  assert.equal(story.stories[1].parts[0].paragraphs.length, 1);
});

test('a story with no run yet is an empty list of stories', () => {
  assert.deepEqual(toStory(null, new Set()), { stories: [] });
  assert.deepEqual(toStory({ stories: [], ranking: [] }, new Set()), { stories: [] });
});

test('the ids to check for visibility are every id the served stories cite, once', () => {
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
  assert.deepEqual(body.story.stories.map(x => x.threadId), ['t2', 't1']);
});

test('an empty period serves the skeleton and an empty story', () => {
  const period = parsePeriodId('2026-W38');
  const body = toPeriod({ period, facets: undefined, story: null, visibleIds: new Set(), storyStatus: 'none' });
  assert.equal(body.editionCount, 0);
  assert.equal(body.articleCount, 0);
  assert.deepEqual(body.categories, []);
  assert.ok(body.timeline.every(d => d.count === 0));
  assert.deepEqual(body.story, { stories: [] });
  assert.equal(body.storyStatus, 'none');
});
