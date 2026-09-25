const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MODEL, resolveModel, parseModelReply } = require('../model');

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

test('a fenced reply is unwrapped', () => {
  assert.deepEqual(parseModelReply('```json\n{"entries":[]}\n```'), { entries: [] });
  assert.deepEqual(parseModelReply('```\n{"entries":[]}\n```'), { entries: [] });
});

test('a reply with chatter around the object still parses', () => {
  assert.deepEqual(parseModelReply('Sure! Here you go:\n{"entries":[]}\nHope that helps.'), { entries: [] });
});

test('an empty or unparseable reply yields nothing rather than throwing', () => {
  assert.equal(parseModelReply(''), null);
  assert.equal(parseModelReply('   '), null);
  assert.equal(parseModelReply(null), null);
  assert.equal(parseModelReply(undefined), null);
  assert.equal(parseModelReply('not json at all'), null);
  assert.equal(parseModelReply('{ this is broken '), null);
});
