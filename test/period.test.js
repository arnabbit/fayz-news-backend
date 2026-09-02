const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePeriodId,
  periodIdFor,
  periodIdsForDate,
  isWithin,
  daysBetween,
  istDate,
} = require('../period');
const AGREEMENT = require('./period-agreement.json');

// The app's suite is the specification, ported case for case. ISO week
// boundaries, quarter arithmetic and year edges are where an off-by-one
// survives review and then shows a reader the wrong month of the paper.
//
// The app's four labelling cases and five bucketing cases are deliberately NOT
// ported: both are presentation the app owns, the period response carries no
// label, and duplicating that copy here would create two things to keep in step
// with nothing holding them equal. See the note at the top of period.js.

const range = id => (parsePeriodId(id) || {}).range;

test('a month id covers its whole month, February included', () => {
  assert.deepEqual(range('2026-08'), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(range('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  // 2024 is a leap year; 2100 is not, despite being divisible by four.
  assert.deepEqual(range('2024-02'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(range('2100-02'), { from: '2100-02-01', to: '2100-02-28' });
});

test('a quarter id covers three months and ends on a real day', () => {
  assert.deepEqual(range('2026-Q1'), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(range('2026-Q2'), { from: '2026-04-01', to: '2026-06-30' });
  assert.deepEqual(range('2026-Q3'), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(range('2026-Q4'), { from: '2026-10-01', to: '2026-12-31' });
});

test('a year id covers the year', () => {
  assert.deepEqual(range('2026'), { from: '2026-01-01', to: '2026-12-31' });
});

test('an ISO week runs Monday to Sunday', () => {
  assert.deepEqual(range('2026-W35'), { from: '2026-08-24', to: '2026-08-30' });
  assert.equal(periodIdFor('2026-08-24', 'week'), '2026-W35');
  assert.equal(periodIdFor('2026-08-30', 'week'), '2026-W35');
  // The days either side belong to the neighbouring weeks, not this one.
  assert.equal(periodIdFor('2026-08-23', 'week'), '2026-W34');
  assert.equal(periodIdFor('2026-08-31', 'week'), '2026-W36');
});

test('ISO week 1 is the week containing 4 January', () => {
  // 2026-01-01 is a Thursday, so its week reaches back into December 2025.
  assert.deepEqual(range('2026-W01'), { from: '2025-12-29', to: '2026-01-04' });
  assert.equal(periodIdFor('2025-12-29', 'week'), '2026-W01');
  assert.equal(periodIdFor('2026-01-04', 'week'), '2026-W01');
});

test('a date in early January can belong to the previous ISO year', () => {
  // 2027-01-01 is a Friday: its week began Monday 28 December 2026 and is the
  // last week of ISO year 2026, not the first of 2027.
  assert.equal(periodIdFor('2027-01-01', 'week'), '2026-W53');
  assert.deepEqual(range('2026-W53'), { from: '2026-12-28', to: '2027-01-03' });
});

test('a date in late December can belong to the next ISO year', () => {
  // 2024-12-30 is a Monday, and its Thursday falls in 2025.
  assert.equal(periodIdFor('2024-12-30', 'week'), '2025-W01');
});

test('a year with only 52 ISO weeks refuses a 53rd', () => {
  assert.ok(parsePeriodId('2026-W53'));
  assert.equal(parsePeriodId('2025-W53'), null);
  assert.equal(parsePeriodId('2026-W54'), null);
  assert.equal(parsePeriodId('2026-W00'), null);
});

test('malformed ids are refused rather than guessed at', () => {
  const bad = ['', '2026-W5', '2026-8', '2026-Q5', '2026-Q0', '2026-13', '2026-00',
    'latest', '26-08', '2026-08-01x'];
  for (const id of bad) {
    assert.equal(parsePeriodId(id), null, `expected ${id} to be refused`);
  }
});

test('a full date is not a period id', () => {
  // `/periods/2026-08-27` is a mistyped edition link, not a period.
  assert.equal(parsePeriodId('2026-08-27'), null);
});

test('out-of-range years are refused', () => {
  assert.equal(parsePeriodId('1899'), null);
  assert.equal(parsePeriodId('3000-01'), null);
  assert.ok(parsePeriodId('1900'));
  assert.ok(parsePeriodId('2999-12'));
});

test('a date maps to the period of each kind that contains it', () => {
  assert.equal(periodIdFor('2026-08-27', 'year'), '2026');
  assert.equal(periodIdFor('2026-08-27', 'month'), '2026-08');
  assert.equal(periodIdFor('2026-08-27', 'quarter'), '2026-Q3');
  assert.equal(periodIdFor('2026-01-01', 'quarter'), '2026-Q1');
  assert.equal(periodIdFor('2026-12-31', 'quarter'), '2026-Q4');
});

test('a date names every derived period that must be invalidated', () => {
  assert.deepEqual(periodIdsForDate('2026-08-27'), [
    '2026-W35', '2026-08', '2026-Q3', '2026',
  ]);
  assert.deepEqual(periodIdsForDate('2027-01-01'), [
    '2026-W53', '2027-01', '2027-Q1', '2027',
  ]);
  assert.deepEqual(periodIdsForDate('not-a-date'), []);
});

test('a date that is not a date maps to nothing', () => {
  assert.equal(periodIdFor('2026-02-31', 'month'), null);
  assert.equal(periodIdFor('not-a-date', 'week'), null);
  assert.equal(periodIdFor('latest', 'month'), null);
});

test('every period id a date produces parses back, for all four kinds', () => {
  for (const date of ['2026-01-01', '2026-02-28', '2026-08-27', '2026-12-31', '2024-02-29']) {
    for (const kind of ['week', 'month', 'quarter', 'year']) {
      const id = periodIdFor(date, kind);
      assert.ok(id, `${date} ${kind} produced no id`);
      const parsed = parsePeriodId(id);
      assert.ok(parsed, `${id} did not parse back`);
      assert.ok(isWithin(date, parsed.range), `${id} does not contain ${date}`);
      assert.equal(parsed.kind, kind);
    }
  }
});

test('containment is inclusive at both ends', () => {
  const august = { from: '2026-08-01', to: '2026-08-31' };
  assert.equal(isWithin('2026-08-01', august), true);
  assert.equal(isWithin('2026-08-31', august), true);
  assert.equal(isWithin('2026-07-31', august), false);
  assert.equal(isWithin('2026-09-01', august), false);
});

test('the IST date is five and a half hours ahead of UTC', () => {
  // 18:29 UTC on the 27th is still the 27th in Delhi; 18:30 is the 28th.
  assert.equal(istDate(Date.UTC(2026, 7, 27, 18, 29, 59)), '2026-08-27');
  assert.equal(istDate(Date.UTC(2026, 7, 27, 18, 30, 0)), '2026-08-28');
});

test('the IST date rolls the month and the year at the right instant', () => {
  assert.equal(istDate(Date.UTC(2026, 7, 31, 18, 30, 0)), '2026-09-01');
  assert.equal(istDate(Date.UTC(2026, 11, 31, 18, 30, 0)), '2027-01-01');
  // Midnight UTC is half past five in the morning in Delhi, same day.
  assert.equal(istDate(Date.UTC(2026, 0, 1, 0, 0, 0)), '2026-01-01');
});

// The timeline's spine, which the app's module has no equivalent of: the
// endpoint must return one entry per day, including days with no edition.

test('a range yields every one of its days, inclusive at both ends', () => {
  const week = daysBetween({ from: '2026-08-24', to: '2026-08-30' });
  assert.equal(week.length, 7);
  assert.equal(week[0], '2026-08-24');
  assert.equal(week[6], '2026-08-30');
});

test('day counts are right across a leap February and a whole year', () => {
  assert.equal(daysBetween({ from: '2024-02-01', to: '2024-02-29' }).length, 29);
  assert.equal(daysBetween({ from: '2026-02-01', to: '2026-02-28' }).length, 28);
  assert.equal(daysBetween({ from: '2026-01-01', to: '2026-12-31' }).length, 365);
  assert.equal(daysBetween({ from: '2024-01-01', to: '2024-12-31' }).length, 366);
});

test('a single-day range is one day, and a malformed one is none', () => {
  assert.deepEqual(daysBetween({ from: '2026-08-24', to: '2026-08-24' }), ['2026-08-24']);
  assert.deepEqual(daysBetween({ from: 'nonsense', to: '2026-08-24' }), []);
});

// The two implementations must agree, or a period looks different depending on
// which of them named it. The fixture is generated from the app's own module.

test('the backend derives the same range as the app, for 630 ids', () => {
  const ids = Object.keys(AGREEMENT.ranges);
  assert.equal(ids.length, 630);
  for (const id of ids) {
    const expected = AGREEMENT.ranges[id];
    const got = parsePeriodId(id);
    if (expected === null) {
      assert.equal(got, null, `${id}: the app refuses this and the backend does not`);
      continue;
    }
    assert.ok(got, `${id}: the app parses this and the backend does not`);
    assert.deepEqual([got.kind, got.range.from, got.range.to], expected, `${id} disagrees`);
  }
});

test('the backend buckets every day of four years exactly as the app does', () => {
  const dates = Object.keys(AGREEMENT.buckets);
  assert.equal(dates.length, 1461);
  for (const date of dates) {
    const got = ['week', 'month', 'quarter', 'year'].map(k => periodIdFor(date, k));
    assert.deepEqual(got, AGREEMENT.buckets[date], `${date} disagrees`);
  }
});
