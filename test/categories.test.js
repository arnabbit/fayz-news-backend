const test = require('node:test');
const assert = require('node:assert/strict');
const { slugifyCategory, categoryName, editionCategories } = require('../categories');

test('a stored Title-cased category becomes a slug', () => {
  assert.equal(slugifyCategory('Politics'), 'politics');
  assert.equal(slugifyCategory('  World  '), 'world');
});

test('multi-word categories hyphenate', () => {
  assert.equal(slugifyCategory('Human Interest'), 'human-interest');
  // Underscores are word separators too — the LLM has emitted both forms.
  assert.equal(slugifyCategory('law_and_order'), 'law-and-order');
});

test('slugifying is idempotent, so the backfill can be re-run', () => {
  for (const value of ['Politics', 'Human Interest', 'ECONOMY']) {
    assert.equal(slugifyCategory(slugifyCategory(value)), slugifyCategory(value));
  }
});

test('an empty or junk category slugifies to nothing', () => {
  assert.equal(slugifyCategory(''), '');
  assert.equal(slugifyCategory(null), '');
  assert.equal(slugifyCategory('!!!'), '');
});

test('an unknown slug is title-cased rather than dropped', () => {
  assert.equal(categoryName('education'), 'Education');
  assert.equal(categoryName('human-interest'), 'Human Interest');
});

test('home is injected first even when no article carries it', () => {
  const list = editionCategories(['Politics', 'Sports']);
  assert.equal(list[0].slug, 'home');
  assert.equal(list.length, 3);
});

test('known categories follow the canonical order, not the input order', () => {
  const slugs = editionCategories(['Health', 'Politics', 'World']).map(c => c.slug);
  assert.deepEqual(slugs, ['home', 'politics', 'world', 'health']);
});

test('unknown slugs are appended after the canonical order — the Education bug', () => {
  const list = editionCategories(['Education', 'Politics']);
  assert.deepEqual(list.map(c => c.slug), ['home', 'politics', 'education']);
  assert.equal(list[2].name, 'Education');
});

test('duplicates and a stored "home" collapse', () => {
  const slugs = editionCategories(['Politics', 'politics', 'home', 'Home']).map(c => c.slug);
  assert.deepEqual(slugs, ['home', 'politics']);
});
