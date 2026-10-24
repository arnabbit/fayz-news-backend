const test = require('node:test');
const assert = require('node:assert/strict');
const { postShortcode, seenShortcodes } = require('../seenPosts');

test('a post, a reel and a tv URL each give their shortcode', () => {
  assert.equal(postShortcode('https://www.instagram.com/p/DAbc123/'), 'DAbc123');
  assert.equal(postShortcode('https://www.instagram.com/reel/DXyz789/'), 'DXyz789');
  assert.equal(postShortcode('https://www.instagram.com/tv/CTv0001/'), 'CTv0001');
});

test('a profile-prefixed URL gives the same shortcode as the bare one', () => {
  assert.equal(
    postShortcode('https://www.instagram.com/fayedsouza/p/DAbc123/'),
    postShortcode('https://www.instagram.com/p/DAbc123/')
  );
});

test('a query string, a hash and a comment permalink do not change the shortcode', () => {
  assert.equal(postShortcode('https://www.instagram.com/p/DAbc123/?img_index=2#x'), 'DAbc123');
  assert.equal(postShortcode('https://www.instagram.com/p/DAbc123/c/1789/'), 'DAbc123');
});

test('a URL that names no post gives null', () => {
  for (const url of [
    'https://www.instagram.com/fayedsouza/',
    'https://www.instagram.com/p/',
    '',
    '   ',
    null,
    undefined,
    42,
  ]) {
    assert.equal(postShortcode(url), null);
  }
});

test('seen shortcodes are distinct and sorted', () => {
  assert.deepEqual(
    seenShortcodes([
      'https://www.instagram.com/reel/B2/',
      'https://www.instagram.com/p/A1/',
      'https://www.instagram.com/fayedsouza/p/A1/',
      'https://www.instagram.com/p/B2/',
      'https://www.instagram.com/fayedsouza/',
      '',
    ]),
    ['A1', 'B2']
  );
});

test('a non-array gives no shortcodes rather than throwing', () => {
  assert.deepEqual(seenShortcodes(null), []);
  assert.deepEqual(seenShortcodes('https://www.instagram.com/p/A1/'), []);
});
