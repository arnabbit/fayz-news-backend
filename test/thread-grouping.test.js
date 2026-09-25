const test = require('node:test');
const assert = require('node:assert/strict');
const { groupNextEdition, groupThrough } = require('../threadGrouping');

// ---- an in-memory stand-in for the two collections ----
//
// Only the operators the grouping code uses. Enough to test order, storage and
// correction without a database; not a Mongo emulator.

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$exists') return (value !== undefined) === arg;
        if (op === '$lte') return value !== undefined && value <= arg;
        if (op === '$gte') return value !== undefined && value >= arg;
        if (op === '$lt') return value !== undefined && value < arg;
        if (op === '$in') return arg.includes(value);
        if (op === '$ne') return value !== arg;
        throw new Error(`fake db: unsupported operator ${op}`);
      });
    }
    return value === cond;
  });
}

function applyUpdate(doc, update, inserting) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [key, arg] of Object.entries(fields)) {
      if (op === '$set') doc[key] = arg;
      else if (op === '$setOnInsert') { if (inserting) doc[key] = arg; }
      else if (op === '$addToSet') {
        const list = doc[key] || [];
        for (const item of arg.$each) if (!list.includes(item)) list.push(item);
        doc[key] = list;
      } else if (op === '$min') { if (doc[key] === undefined || arg < doc[key]) doc[key] = arg; }
      else if (op === '$max') { if (doc[key] === undefined || arg > doc[key]) doc[key] = arg; }
      else throw new Error(`fake db: unsupported update ${op}`);
    }
  }
}

function collection(docs) {
  const sortBy = (rows, sort) => {
    if (!sort) return rows;
    const [[key, dir]] = Object.entries(sort);
    return [...rows].sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : 0));
  };
  return {
    docs,
    async findOne(filter, options = {}) {
      const [first] = sortBy(docs.filter(d => matches(d, filter)), options.sort);
      return first ? structuredClone(first) : null;
    },
    find(filter, options = {}) {
      return { toArray: async () => sortBy(docs.filter(d => matches(d, filter)), options.sort).map(d => structuredClone(d)) };
    },
    async updateOne(filter, update, options = {}) {
      const doc = docs.find(d => matches(d, filter));
      if (doc) {
        applyUpdate(doc, update, false);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const fresh = {};
      for (const [key, value] of Object.entries(filter)) {
        if (typeof value !== 'object' || value === null) fresh[key] = value;
      }
      applyUpdate(fresh, update, true);
      docs.push(fresh);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    },
  };
}

function fakeDb(articles, threads = []) {
  const collections = { articles: collection(articles), storyThreads: collection(threads) };
  return {
    collections,
    collection(name) {
      if (!collections[name]) throw new Error(`fake db: no collection ${name}`);
      return collections[name];
    },
  };
}

function article(id, dateKey, extra = {}) {
  return { id, headline: `Headline ${id}`, dek: '', category: 'world', developments: [], _dateKey: dateKey, ...extra };
}

// A model stand-in that records every prompt and answers from a script.
function scriptedModel(answer) {
  const prompts = [];
  const ask = async prompt => {
    prompts.push(prompt);
    return typeof answer === 'function' ? answer(prompt, prompts.length) : answer;
  };
  return { ask, prompts };
}

const threadOf = (db, id) => db.collections.articles.docs.find(a => a.id === id)._threadId;
const storedThread = (db, threadId) => db.collections.storyThreads.docs.find(t => t.threadId === threadId);

// ---- every article, hidden included ----

test('every visible and hidden article in a grouped edition gets a thread', async () => {
  const db = fakeDb([
    article('a1', '2026-09-01'),
    article('a2', '2026-09-01', { hidden: true }),
    article('a3', '2026-09-01'),
  ]);
  const model = scriptedModel('{"assignments":[]}');
  await groupThrough({ db, ask: model.ask }, '2026-09-01');
  for (const id of ['a1', 'a2', 'a3']) assert.ok(threadOf(db, id), `${id} has no thread`);
  assert.ok(model.prompts[0].includes('a2'), 'the hidden article reached the model');
});

test('one model call per edition', async () => {
  const db = fakeDb([article('a1', '2026-09-01'), article('a2', '2026-09-01'), article('b1', '2026-09-03')]);
  const model = scriptedModel('{"assignments":[]}');
  await groupThrough({ db, ask: model.ask }, '2026-09-03');
  assert.equal(model.prompts.length, 2);
});

// ---- order ----

test('editions are grouped oldest first, and never past the date asked for', async () => {
  const db = fakeDb([
    article('c1', '2026-09-05'),
    article('a1', '2026-09-01'),
    article('b1', '2026-09-03'),
  ]);
  const model = scriptedModel('{"assignments":[]}');
  const grouped = await groupThrough({ db, ask: model.ask }, '2026-09-03');
  assert.deepEqual(grouped, ['2026-09-01', '2026-09-03']);
  assert.ok(model.prompts[0].includes('dated 2026-09-01'));
  assert.ok(model.prompts[1].includes('dated 2026-09-03'));
  assert.equal(threadOf(db, 'c1'), undefined);
});

test('the one-edition step always takes the oldest ungrouped edition', async () => {
  const db = fakeDb([article('b1', '2026-09-03'), article('a1', '2026-09-01')]);
  const model = scriptedModel('{"assignments":[]}');
  const step = await groupNextEdition({ db, ask: model.ask }, '2026-09-03');
  assert.deepEqual(step, { dateKey: '2026-09-01', grouped: 1 });
  assert.equal(threadOf(db, 'b1'), undefined);
});

test('a later edition sees the threads the earlier one created, and can join them', async () => {
  const db = fakeDb([article('a1', '2026-09-01'), article('b1', '2026-09-03')]);
  let firstThread;
  const model = scriptedModel((prompt, n) => {
    if (n === 1) return '{"assignments":[{"articleId":"a1","threadId":null,"title":"The talks"}]}';
    firstThread = threadOf(db, 'a1');
    assert.ok(prompt.includes(firstThread), 'the earlier thread is a candidate');
    assert.ok(prompt.includes('Headline a1'), 'with its headlines');
    return JSON.stringify({ assignments: [{ articleId: 'b1', threadId: firstThread }] });
  });
  await groupThrough({ db, ask: model.ask }, '2026-09-03');
  assert.equal(threadOf(db, 'b1'), firstThread);
  assert.deepEqual(storedThread(db, firstThread), {
    threadId: firstThread, title: 'The talks', category: 'world',
    firstDate: '2026-09-01', lastDate: '2026-09-03', articleIds: ['a1', 'b1'],
  });
});

test('a thread last seen more than 60 days before the edition is not a candidate', async () => {
  const db = fakeDb([
    article('old', '2026-06-01', { _threadId: 'T-old' }),
    article('new', '2026-09-01'),
  ], [
    { threadId: 'T-old', title: 'Old story', category: 'world', firstDate: '2026-06-01', lastDate: '2026-06-01', articleIds: ['old'] },
  ]);
  const model = scriptedModel('{"assignments":[{"articleId":"new","threadId":"T-old"}]}');
  await groupThrough({ db, ask: model.ask }, '2026-09-01');
  assert.equal(model.prompts[0].includes('T-old'), false);
  assert.notEqual(threadOf(db, 'new'), 'T-old');
});

// ---- correction ----

test('a reply naming an unknown thread or article is corrected, not stored', async () => {
  const db = fakeDb([article('a1', '2026-09-01')]);
  const model = scriptedModel(JSON.stringify({
    assignments: [
      { articleId: 'a1', threadId: 'INVENTED' },
      { articleId: 'ghost', threadId: null, title: 'Ghost' },
    ],
  }));
  await groupThrough({ db, ask: model.ask }, '2026-09-01');
  const threadId = threadOf(db, 'a1');
  assert.ok(threadId && threadId !== 'INVENTED');
  assert.equal(db.collections.storyThreads.docs.length, 1);
  assert.deepEqual(db.collections.storyThreads.docs[0].articleIds, ['a1']);
  assert.equal(db.collections.articles.docs.some(a => a.id === 'ghost'), false);
});

test('an article the model omits gets a new thread of its own', async () => {
  const db = fakeDb([article('a1', '2026-09-01'), article('a2', '2026-09-01')], [
    { threadId: 'T1', title: 'Known', category: 'world', firstDate: '2026-08-30', lastDate: '2026-08-30', articleIds: [] },
  ]);
  const model = scriptedModel('{"assignments":[{"articleId":"a1","threadId":"T1"}]}');
  await groupThrough({ db, ask: model.ask }, '2026-09-01');
  assert.equal(threadOf(db, 'a1'), 'T1');
  const own = storedThread(db, threadOf(db, 'a2'));
  assert.deepEqual(own.articleIds, ['a2']);
  assert.equal(own.title, 'Headline a2');
});

test('an unusable reply still leaves no article without a thread', async () => {
  const db = fakeDb([article('a1', '2026-09-01'), article('a2', '2026-09-01')]);
  const model = scriptedModel('I cannot help with that.');
  await groupThrough({ db, ask: model.ask }, '2026-09-01');
  assert.ok(threadOf(db, 'a1'));
  assert.ok(threadOf(db, 'a2'));
  assert.notEqual(threadOf(db, 'a1'), threadOf(db, 'a2'));
});

test('a failed model call stores nothing and says so', async () => {
  const db = fakeDb([article('a1', '2026-09-01')]);
  const ask = async () => { throw new Error('OpenRouter answered 503'); };
  await assert.rejects(groupThrough({ db, ask }, '2026-09-01'), /503/);
  assert.equal(threadOf(db, 'a1'), undefined);
  assert.equal(db.collections.storyThreads.docs.length, 0);
});

// ---- re-push and late filing ----

test('a re-push of a grouped article keeps its thread and costs no model call', async () => {
  const db = fakeDb([article('a1', '2026-09-01')]);
  const model = scriptedModel('{"assignments":[]}');
  await groupThrough({ db, ask: model.ask }, '2026-09-01');
  const before = threadOf(db, 'a1');

  // What POST /api/articles does to an article that already exists: a $set of
  // the pushed fields, none of which is _threadId.
  const { _dateKey, ...pushed } = article('a1', '2026-09-01', { headline: 'Headline a1, updated' });
  await db.collection('articles').updateOne({ id: 'a1' }, { $set: { ...pushed, _updatedAt: new Date() } });

  await groupThrough({ db, ask: model.ask }, '2026-09-01');
  assert.equal(threadOf(db, 'a1'), before);
  assert.equal(model.prompts.length, 1);
});

test('a late-filed article is grouped on the next run, against the threads that exist then', async () => {
  const db = fakeDb([article('a1', '2026-09-01'), article('b1', '2026-09-05')]);
  const model = scriptedModel('{"assignments":[]}');
  await groupThrough({ db, ask: model.ask }, '2026-09-05');
  const laterThread = threadOf(db, 'b1');

  // Filed into a past edition after both were grouped.
  db.collections.articles.docs.push(article('late', '2026-09-01'));

  const next = scriptedModel(JSON.stringify({ assignments: [{ articleId: 'late', threadId: laterThread }] }));
  const grouped = await groupThrough({ db, ask: next.ask }, '2026-09-05');
  assert.deepEqual(grouped, ['2026-09-01']);
  assert.ok(next.prompts[0].includes(laterThread), 'a thread that started later is a candidate');
  assert.equal(threadOf(db, 'late'), laterThread);
  assert.deepEqual(storedThread(db, laterThread).articleIds, ['b1', 'late']);
  assert.equal(storedThread(db, laterThread).firstDate, '2026-09-01');
  assert.equal(storedThread(db, laterThread).lastDate, '2026-09-05');
});

test('an article grouped by someone else meanwhile is not moved', async () => {
  const db = fakeDb([article('a1', '2026-09-01'), article('a2', '2026-09-01')]);
  const model = scriptedModel(() => {
    // Another writer groups a1 while the model is thinking.
    db.collections.articles.docs.find(a => a.id === 'a1')._threadId = 'T-other';
    return '{"assignments":[]}';
  });
  await groupThrough({ db, ask: model.ask }, '2026-09-01');
  assert.equal(threadOf(db, 'a1'), 'T-other');
  assert.ok(db.collections.storyThreads.docs.every(t => !t.articleIds.includes('a1')));
  assert.ok(threadOf(db, 'a2'));
});

test('nothing ungrouped means no model call', async () => {
  const db = fakeDb([article('a1', '2026-09-01', { _threadId: 'T1' })]);
  const model = scriptedModel('{"assignments":[]}');
  assert.deepEqual(await groupThrough({ db, ask: model.ask }, '2026-09-25'), []);
  assert.equal(model.prompts.length, 0);
});
