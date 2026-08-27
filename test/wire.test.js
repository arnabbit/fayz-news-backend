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
