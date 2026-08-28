const test = require('node:test');
const assert = require('node:assert/strict');
const { searchQuery, searchLimit, DEFAULT_LIMIT, MAX_LIMIT } = require('../search');

test('a one-character query is refused', () => {
  assert.equal(searchQuery('a'), null);
  assert.equal(searchQuery(''), null);
});

test('the lower boundary at two characters is accepted', () => {
  assert.equal(searchQuery('ai'), 'ai');
});

test('the upper boundary at a hundred characters is accepted', () => {
  const q = 'x'.repeat(100);
  assert.equal(searchQuery(q), q);
});

test('a hundred-and-one character query is refused', () => {
  assert.equal(searchQuery('x'.repeat(101)), null);
});

test('a query is trimmed and its internal whitespace collapsed', () => {
  // The bounds are on what gets searched, not on what got typed.
  assert.equal(searchQuery('  monsoon   floods \n'), 'monsoon floods');
  assert.equal(searchQuery(`  a${' '.repeat(200)}b  `), 'a b');
});

test('whitespace alone is not a query', () => {
  assert.equal(searchQuery('     '), null);
  assert.equal(searchQuery('\n\t'), null);
});

test('a non-string is refused rather than coerced', () => {
  for (const value of [null, undefined, 42, {}, ['ab']]) {
    assert.equal(searchQuery(value), null);
  }
});

test('a missing limit falls back to twenty', () => {
  assert.equal(searchLimit(undefined), DEFAULT_LIMIT);
  assert.equal(searchLimit(''), DEFAULT_LIMIT);
  assert.equal(searchLimit('not a number'), DEFAULT_LIMIT);
});

test('a limit above fifty is capped rather than refused', () => {
  assert.equal(searchLimit('500'), MAX_LIMIT);
  assert.equal(searchLimit('51'), MAX_LIMIT);
  assert.equal(searchLimit('50'), 50);
});

test('a zero or negative limit becomes one', () => {
  assert.equal(searchLimit('0'), 1);
  assert.equal(searchLimit('-10'), 1);
});
