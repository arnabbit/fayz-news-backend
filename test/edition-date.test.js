const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseEditionDateKey,
  editionDateLabelFromKey,
  resolveEditionDate,
} = require('../editionDate');

const NOW = new Date('2026-09-02T12:00:00.000Z');

test('an omitted edition date falls back to the current IST date', () => {
  assert.deepEqual(resolveEditionDate(undefined, NOW), {
    dateKey: '2026-09-02',
    dateLabel: 'September 2, 2026',
    currentDateKey: '2026-09-02',
    historical: false,
  });
});

test('a valid current or historical date is accepted without timezone parsing', () => {
  assert.deepEqual(resolveEditionDate('2026-09-02', NOW), {
    dateKey: '2026-09-02',
    dateLabel: 'September 2, 2026',
    currentDateKey: '2026-09-02',
    historical: false,
  });
  assert.deepEqual(resolveEditionDate('2024-02-29', NOW), {
    dateKey: '2024-02-29',
    dateLabel: 'February 29, 2024',
    currentDateKey: '2026-09-02',
    historical: true,
  });
});

test('malformed, impossible, out-of-range, and future dates are refused', () => {
  for (const value of [
    null, 20260901, '', '2026-9-01', '2026-02-29', '2026-02-30',
    '1899-12-31', '3000-01-01', '2026-09-03',
  ]) {
    assert.equal(resolveEditionDate(value, NOW), null, String(value));
  }
});

test('calendar parsing and labels agree at leap-year and year boundaries', () => {
  assert.deepEqual(parseEditionDateKey('2000-02-29'), { year: 2000, month: 2, day: 29 });
  assert.equal(parseEditionDateKey('2100-02-29'), null);
  assert.equal(editionDateLabelFromKey('1900-01-01'), 'January 1, 1900');
  assert.equal(editionDateLabelFromKey('2999-12-31'), 'December 31, 2999');
});
