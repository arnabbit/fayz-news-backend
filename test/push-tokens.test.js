const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isExpoPushToken,
  pushTokenDocument,
  staleTokenCutoff,
  STALE_TOKEN_DAYS,
} = require('../pushTokens');

const NOW = new Date('2026-08-28T04:30:00.000Z');
const VALID = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

test('a real Expo push token is accepted', () => {
  assert.equal(isExpoPushToken(VALID), true);
  assert.equal(isExpoPushToken('ExponentPushToken[AbC-123_dEf]'), true);
});

test('surrounding whitespace does not make a valid token invalid', () => {
  assert.equal(isExpoPushToken(`  ${VALID}\n`), true);
});

test('a malformed token is refused', () => {
  assert.equal(isExpoPushToken('ExponentPushToken[]'), false);
  assert.equal(isExpoPushToken('ExponentPushToken[abc'), false);
  assert.equal(isExpoPushToken('abc]'), false);
});

test('a near-miss that is almost the right shape is refused', () => {
  // FCM's own token form, and the two casings a hand-written client gets wrong.
  assert.equal(isExpoPushToken('ExpoPushToken[abc]'), false);
  assert.equal(isExpoPushToken('exponentpushtoken[abc]'), false);
  assert.equal(isExpoPushToken('ExponentPushToken[abc] '.repeat(2).trim()), false);
});

test('a non-string is refused rather than coerced', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.equal(isExpoPushToken(value), false);
  }
});

test('an empty string is refused', () => {
  assert.equal(isExpoPushToken(''), false);
  assert.equal(isExpoPushToken('   '), false);
});

test('a valid registration produces exactly six fields', () => {
  const doc = pushTokenDocument({ token: VALID, platform: 'android' }, NOW);
  assert.deepEqual(Object.keys(doc).sort(), [
    'appVersion', 'createdAt', 'lastSeen', 'platform', 'token', 'updateId',
  ]);
});

test('nothing joinable to a person is stored, whatever the client sends', () => {
  const doc = pushTokenDocument(
    { token: VALID, platform: 'android', email: 'someone@example.com', deviceId: 'abc', userId: 7 },
    NOW
  );
  assert.equal('email' in doc, false);
  assert.equal('deviceId' in doc, false);
  assert.equal('userId' in doc, false);
});

test('an invalid token yields no document at all', () => {
  assert.equal(pushTokenDocument({ token: 'nope' }, NOW), null);
  assert.equal(pushTokenDocument({}, NOW), null);
  assert.equal(pushTokenDocument(null, NOW), null);
});

test('a build with no update channel still registers', () => {
  // Expo Go and development builds have no update id. That is not an error.
  const doc = pushTokenDocument({ token: VALID, platform: 'android', appVersion: '1' }, NOW);
  assert.equal(doc.updateId, '');
  assert.equal(doc.appVersion, '1');
});

test('both version axes are kept, because appVersion alone cannot answer the question', () => {
  const a = pushTokenDocument({ token: VALID, appVersion: '3', updateId: 'bundle-a' }, NOW);
  const b = pushTokenDocument({ token: VALID, appVersion: '3', updateId: 'bundle-b' }, NOW);
  assert.equal(a.appVersion, b.appVersion);
  assert.notEqual(a.updateId, b.updateId);
});

test('platform defaults to android and is capped', () => {
  assert.equal(pushTokenDocument({ token: VALID }, NOW).platform, 'android');
  assert.equal(pushTokenDocument({ token: VALID, platform: 'ios' }, NOW).platform, 'ios');
  assert.equal(pushTokenDocument({ token: VALID, platform: 'x'.repeat(50) }, NOW).platform.length, 16);
});

test('an over-long version string is capped rather than rejected', () => {
  const doc = pushTokenDocument({ token: VALID, updateId: 'u'.repeat(500) }, NOW);
  assert.equal(doc.updateId.length, 120);
});

test('the token is stored trimmed, so a stray newline cannot create a second row', () => {
  assert.equal(pushTokenDocument({ token: `  ${VALID}  ` }, NOW).token, VALID);
});

test('the stale cutoff is ninety days before now', () => {
  const cutoff = staleTokenCutoff(NOW);
  assert.equal(STALE_TOKEN_DAYS, 90);
  assert.equal(NOW.getTime() - cutoff.getTime(), 90 * 24 * 60 * 60 * 1000);
  assert.ok(cutoff < NOW);
});
