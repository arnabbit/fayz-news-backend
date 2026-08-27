const test = require('node:test');
const assert = require('node:assert/strict');
const { DEK_CAP, dekFallback, dekFor } = require('../dek');

test('a short paragraph is the dek unchanged', () => {
  assert.equal(dekFallback(['Sugar prices rose by a rupee.']), 'Sugar prices rose by a rupee.');
});

test('paragraph one is used, never the rest', () => {
  assert.equal(dekFallback(['First.', 'Second.']), 'First.');
});

test('a long paragraph is cut at a sentence boundary', () => {
  const first = 'The State Department paused immigrant visas worldwide. ';
  const dek = dekFallback([first + 'x'.repeat(400)]);
  assert.equal(dek, first.trim());
  assert.ok(dek.length <= DEK_CAP);
});

test('a sentence boundary past the cap is not used', () => {
  // The only full stop sits well beyond 240 chars, so a word boundary wins.
  const dek = dekFallback(['word '.repeat(80) + 'end.']);
  assert.ok(dek.length <= DEK_CAP + 1, `got ${dek.length}`);
  assert.ok(dek.endsWith('…'));
  assert.ok(!dek.includes('  '));
});

test('a decimal point is not a sentence boundary', () => {
  // "Rs 65.50" must not end the dek: a boundary needs a following space.
  const head = 'Prices reached Rs 65.50 a kilogram in retail markets today. ';
  assert.equal(dekFallback([head + 'y'.repeat(400)]), head.trim());
});

test('an authored dek wins over the fallback', () => {
  assert.equal(dekFor({ dek: 'Authored.', body: ['Something else entirely.'] }), 'Authored.');
});

test('an over-long authored dek is still capped', () => {
  const dek = dekFor({ dek: 'z'.repeat(400), body: ['ignored'] });
  assert.ok(dek.length <= DEK_CAP + 1, `got ${dek.length}`);
});

test('dek is never null, even with no body at all', () => {
  assert.equal(dekFor({}), '');
  assert.equal(dekFor({ body: [] }), '');
  assert.equal(dekFor({ body: [null] }), '');
});
