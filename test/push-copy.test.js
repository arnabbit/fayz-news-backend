const test = require('node:test');
const assert = require('node:assert/strict');
const { weekdayOf, editionNotification } = require('../pushCopy');

test('every weekday is named from the edition date alone', () => {
  // 2026-08-24 is a Monday. Seven consecutive days name seven weekdays.
  const week = ['24', '25', '26', '27', '28', '29', '30']
    .map(d => weekdayOf(`2026-08-${d}`));
  assert.deepEqual(week, [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  ]);
});

test('the weekday comes from the IST calendar digits, not the host timezone', () => {
  // The date key is already IST. Whatever TZ the process runs in — Render is
  // UTC, this machine is not — the answer must be the same, which is what
  // arithmetic on the digits buys.
  const before = process.env.TZ;
  const answers = new Set();
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
    process.env.TZ = tz;
    answers.add(weekdayOf('2026-08-28'));
  }
  process.env.TZ = before;
  assert.deepEqual([...answers], ['Friday']);
});

test('a malformed or impossible date key names no weekday', () => {
  assert.equal(weekdayOf('2026-8-28'), null);
  assert.equal(weekdayOf('latest'), null);
  assert.equal(weekdayOf(''), null);
  assert.equal(weekdayOf(null), null);
  // Round-tripped, so this is refused rather than sliding into March.
  assert.equal(weekdayOf('2026-02-30'), null);
});

test('one article is singular and many are plural', () => {
  assert.equal(editionNotification('2026-08-28', 1).body, "Friday's edition — 1 article");
  assert.equal(editionNotification('2026-08-28', 2).body, "Friday's edition — 2 articles");
  assert.equal(editionNotification('2026-08-28', 85).body, "Friday's edition — 85 articles");
});

test('the title is the paper, and no headline appears anywhere', () => {
  const note = editionNotification('2026-08-28', 12);
  assert.equal(note.title, 'The Chronicle');
  assert.equal(/headline/i.test(JSON.stringify(note)), false);
});

test('the payload is the edition and nothing else', () => {
  const note = editionNotification('2026-08-28', 12);
  assert.deepEqual(note.data, { edition: '2026-08-28' });
  assert.deepEqual(Object.keys(note.data), ['edition']);
});

test('a count of zero sends nothing at all', () => {
  // The count excludes hidden articles, so an edition whose every article is
  // hidden is not an edition worth waking a phone for.
  assert.equal(editionNotification('2026-08-28', 0), null);
  assert.equal(editionNotification('2026-08-28', -3), null);
  assert.equal(editionNotification('2026-08-28', NaN), null);
});

test('a bad date key sends nothing rather than an untitled notification', () => {
  assert.equal(editionNotification('nonsense', 12), null);
});
