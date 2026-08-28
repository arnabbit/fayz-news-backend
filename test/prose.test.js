const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MODEL,
  resolveModel,
  buildPrompt,
  parseModelReply,
  validateProse,
} = require('../prose');

const CATEGORIES = [
  { slug: 'politics', name: 'Politics', count: 26 },
  { slug: 'environment', name: 'Environment', count: 21 },
  { slug: 'legal', name: 'Legal', count: 12 },
  { slug: 'sports', name: 'Sports', count: 2 },
];

const PERIOD = { id: '2026-W35', kind: 'week', range: { from: '2026-08-24', to: '2026-08-30' } };

test('the model comes from the environment and falls back to the default', () => {
  assert.equal(resolveModel('anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4');
  assert.equal(resolveModel(''), DEFAULT_MODEL);
  assert.equal(resolveModel('   '), DEFAULT_MODEL);
  assert.equal(resolveModel(undefined), DEFAULT_MODEL);
  assert.equal(resolveModel(null), DEFAULT_MODEL);
  assert.equal(resolveModel(42), DEFAULT_MODEL);
});

test('the default model is the one the extension already defaults to', () => {
  assert.equal(DEFAULT_MODEL, 'google/gemini-3.1-flash-lite-preview');
});

test('only headlines reach the prompt, never bodies', () => {
  const prompt = buildPrompt(PERIOD, CATEGORIES, {
    politics: ['A political headline'],
    environment: ['An environmental headline'],
    legal: ['A legal headline'],
    sports: ['A sporting headline'],
  });
  assert.ok(prompt.includes('A political headline'));
  assert.equal(prompt.includes('paragraph one of the body'), false);
  assert.ok(prompt.includes('2026-W35'));
  assert.ok(prompt.includes('2026-08-24'));
});

test('thin categories are held back for the trailing line rather than given a paragraph', () => {
  const prompt = buildPrompt(PERIOD, CATEGORIES, {
    politics: ['P'], environment: ['E'], legal: ['L'], sports: ['S'],
  });
  assert.ok(prompt.includes('## Politics (politics)'));
  assert.equal(prompt.includes('## Sports (sports)'), false);
  assert.ok(prompt.includes('trailing line'));
});

test('a fenced reply is unwrapped', () => {
  assert.deepEqual(parseModelReply('```json\n{"lede":"x"}\n```'), { lede: 'x' });
  assert.deepEqual(parseModelReply('```\n{"lede":"x"}\n```'), { lede: 'x' });
});

test('a reply with chatter around the object still parses', () => {
  assert.deepEqual(parseModelReply('Sure! Here you go:\n{"lede":"x"}\nHope that helps.'), { lede: 'x' });
});

test('an empty or unparseable reply yields nothing rather than throwing', () => {
  assert.equal(parseModelReply(''), null);
  assert.equal(parseModelReply('   '), null);
  assert.equal(parseModelReply(null), null);
  assert.equal(parseModelReply(undefined), null);
  assert.equal(parseModelReply('not json at all'), null);
  assert.equal(parseModelReply('{ this is broken '), null);
});

test('a well-formed generation validates to exactly the ADR shape', () => {
  const out = validateProse({
    lede: '  Two sentences.  ',
    byCategory: [{ slug: 'politics', name: 'Politics', text: ' A paragraph. ' }],
    also: ' A trailing line. ',
  }, CATEGORIES);
  assert.deepEqual(out, {
    lede: 'Two sentences.',
    byCategory: [{ slug: 'politics', name: 'Politics', text: 'A paragraph.' }],
    also: 'A trailing line.',
  });
  assert.deepEqual(Object.keys(out.byCategory[0]), ['slug', 'name', 'text']);
});

test('byCategory is ordered by article count, whatever order the model returned', () => {
  // The wire order IS the ranking — the app never re-sorts it — so it has to be
  // right when it is stored.
  const out = validateProse({
    lede: 'x',
    byCategory: [
      { slug: 'legal', name: 'Legal', text: 'c' },
      { slug: 'politics', name: 'Politics', text: 'a' },
      { slug: 'environment', name: 'Environment', text: 'b' },
    ],
    also: null,
  }, CATEGORIES);
  assert.deepEqual(out.byCategory.map(c => c.slug), ['politics', 'environment', 'legal']);
});

test('a category the period does not have is dropped', () => {
  const out = validateProse({
    lede: 'x',
    byCategory: [
      { slug: 'politics', name: 'Politics', text: 'a' },
      { slug: 'astrology', name: 'Astrology', text: 'invented' },
    ],
    also: null,
  }, CATEGORIES);
  assert.deepEqual(out.byCategory.map(c => c.slug), ['politics']);
});

test('a duplicated category is kept once', () => {
  const out = validateProse({
    lede: 'x',
    byCategory: [
      { slug: 'politics', name: 'Politics', text: 'first' },
      { slug: 'politics', name: 'Politics', text: 'second' },
    ],
    also: null,
  }, CATEGORIES);
  assert.equal(out.byCategory.length, 1);
  assert.equal(out.byCategory[0].text, 'first');
});

test('one malformed paragraph does not take the others with it', () => {
  const out = validateProse({
    lede: 'x',
    byCategory: [
      { slug: 'politics', name: 'Politics', text: 'a' },
      null,
      { slug: 'legal', text: '' },
      'not an object',
      { slug: 'environment', name: 'Environment', text: 'b' },
    ],
    also: null,
  }, CATEGORIES);
  assert.deepEqual(out.byCategory.map(c => c.slug), ['politics', 'environment']);
});

test('a missing name falls back to the category name rather than being blank', () => {
  const out = validateProse({
    lede: 'x', byCategory: [{ slug: 'politics', text: 'a' }], also: null,
  }, CATEGORIES);
  assert.equal(out.byCategory[0].name, 'Politics');
});

test('a generation with nothing renderable is refused rather than stored', () => {
  // Storing it would turn "not written yet" into "written, and empty", which the
  // screen has no way to recover from.
  assert.equal(validateProse({ lede: '', byCategory: [], also: '' }, CATEGORIES), null);
  assert.equal(validateProse({ lede: '  ', byCategory: 'nope', also: null }, CATEGORIES), null);
  assert.equal(validateProse(null, CATEGORIES), null);
  assert.equal(validateProse('a string', CATEGORIES), null);
  assert.equal(validateProse([], CATEGORIES), null);
});

test('a lede with no paragraphs still stores, and degrades on the screen', () => {
  const out = validateProse({ lede: 'Only a lede.', byCategory: [], also: null }, CATEGORIES);
  assert.deepEqual(out, { lede: 'Only a lede.', byCategory: [], also: null });
});

test('an absent trailing line is null, not an empty string', () => {
  assert.equal(validateProse({ lede: 'x', byCategory: [], also: '' }, CATEGORIES).also, null);
  assert.equal(validateProse({ lede: 'x', byCategory: [], also: 42 }, CATEGORIES).also, null);
});

test('validating a stored summary again changes nothing', () => {
  const once = validateProse({
    lede: 'x',
    byCategory: [{ slug: 'politics', name: 'Politics', text: 'a' }],
    also: 'y',
  }, CATEGORIES);
  assert.deepEqual(validateProse(once, CATEGORIES), once);
});
