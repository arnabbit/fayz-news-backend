const test = require('node:test');
const assert = require('node:assert/strict');
const { catchUp, createStoryQueue, readStoryState, emptyOnFailure } = require('../storyCatchUp');

// ---- an in-memory stand-in for the collections ----
//
// Only the operators the story, the grouping and the guards use, with dotted
// paths. Every call is atomic, as a single-document Mongo update is. Not a
// Mongo emulator.

function getPath(doc, path) {
  return path.split('.').reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), doc);
}

function setPath(doc, path, value) {
  const keys = path.split('.');
  let at = doc;
  for (const k of keys.slice(0, -1)) {
    if (at[k] === undefined || at[k] === null) at[k] = {};
    at = at[k];
  }
  at[keys[keys.length - 1]] = value;
}

function unsetPath(doc, path) {
  const keys = path.split('.');
  const parent = getPath(doc, keys.slice(0, -1).join('.')) ?? (keys.length === 1 ? doc : undefined);
  if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]];
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = getPath(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$exists') return (value !== undefined) === arg;
        if (op === '$lte') return value !== undefined && value <= arg;
        if (op === '$gte') return value !== undefined && value >= arg;
        if (op === '$lt') return value !== undefined && value < arg;
        if (op === '$in') return arg.includes(value);
        if (op === '$ne') return value !== arg;
        if (op === '$size') return Array.isArray(value) && value.length === arg;
        throw new Error(`fake db: unsupported operator ${op}`);
      });
    }
    if (cond === null) return value === null || value === undefined;
    return value === cond;
  });
}

function applyUpdate(doc, update, inserting) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [key, arg] of Object.entries(fields)) {
      if (op === '$set') setPath(doc, key, structuredClone(arg));
      else if (op === '$setOnInsert') { if (inserting) setPath(doc, key, structuredClone(arg)); }
      else if (op === '$unset') unsetPath(doc, key);
      else if (op === '$inc') setPath(doc, key, (getPath(doc, key) || 0) + arg);
      else if (op === '$push') setPath(doc, key, [...(getPath(doc, key) || []), structuredClone(arg)]);
      else if (op === '$addToSet') {
        const list = getPath(doc, key) || [];
        for (const item of arg.$each) if (!list.includes(item)) list.push(item);
        setPath(doc, key, list);
      } else if (op === '$min') { if (getPath(doc, key) === undefined || arg < getPath(doc, key)) setPath(doc, key, arg); }
      else if (op === '$max') { if (getPath(doc, key) === undefined || arg > getPath(doc, key)) setPath(doc, key, arg); }
      else throw new Error(`fake db: unsupported update ${op}`);
    }
  }
}

// Yields between operations, so two passes started together interleave.
const tick = () => new Promise(resolve => setImmediate(resolve));

function collection(docs) {
  const sortBy = (rows, sort) => {
    if (!sort) return rows;
    const [[key, dir]] = Object.entries(sort);
    return [...rows].sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : 0));
  };
  return {
    docs,
    async findOne(filter, options = {}) {
      await tick();
      const [first] = sortBy(docs.filter(d => matches(d, filter)), options.sort);
      return first ? structuredClone(first) : null;
    },
    find(filter, options = {}) {
      return {
        toArray: async () => {
          await tick();
          return sortBy(docs.filter(d => matches(d, filter)), options.sort).map(d => structuredClone(d));
        },
      };
    },
    async updateOne(filter, update, options = {}) {
      await tick();
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

function fakeDb({ articles = [], threads = [], stories = [] } = {}) {
  const collections = {
    articles: collection(articles),
    storyThreads: collection(threads),
    periodStoriesV2: collection(stories),
  };
  return {
    collections,
    collection(name) {
      if (!collections[name]) throw new Error(`fake db: no collection ${name}`);
      return collections[name];
    },
  };
}

// ---- fixtures ----

const WEEK = { id: '2026-W38', kind: 'week', range: { from: '2026-09-14', to: '2026-09-20' } };
const sources = n => Array.from({ length: n }, (_, i) => ({ postUrl: `https://x/${i}` }));

function article(id, threadId, date, extra = {}) {
  return {
    id,
    _threadId: threadId,
    _dateKey: date,
    _createdAt: new Date(`${date}T05:00:00Z`),
    headline: `Headline ${id}`,
    dek: '',
    body: [`Body of ${id}.`],
    developments: [],
    sourcePosts: sources(1),
    ...extra,
  };
}

const THREADS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map(threadId => ({ threadId, title: `Thread ${threadId}`, category: 'world' }));

// T1 on 14 and 15, T2 on 15 and 16, T3 on 16 and 17. Each thread becomes a
// candidate on its second edition, verified by its two sources.
function baseArticles() {
  return [
    article('a14', 'T1', '2026-09-14'),
    article('a15', 'T1', '2026-09-15'),
    article('b15', 'T2', '2026-09-15'),
    article('b16', 'T2', '2026-09-16'),
    article('c16', 'T3', '2026-09-16'),
    article('c17', 'T3', '2026-09-17'),
  ];
}

const runDate = prompt => /This run is for the edition dated (\d{4}-\d{2}-\d{2})/.exec(prompt)[1];
const isEditor = prompt => prompt.startsWith('You are the editor');

// The candidate threads a prompt shows, in its order, with what the editor
// needs to answer.
function candidates(prompt) {
  const d = runDate(prompt);
  return prompt.split('### threadId: ').slice(1).map(block => ({
    threadId: block.split('\n')[0].trim(),
    written: /\nwritten: yes/.test(block),
    ids: [...block.matchAll(/articleId: (\S+)\n\s+date: (\S+)/g)].filter(([, , date]) => date <= d).map(([, id]) => id),
    onDay: [...block.matchAll(/articleId: (\S+)\n\s+date: \S+ \(this edition\)/g)].map(m => m[1]),
  }));
}

// Ranks every candidate in the prompt's order, writes a backstory for each
// one not written yet, and an update for each written one with an article
// dated the run date. The prompt is the only input, so the reply depends on
// exactly what the run was shown. `rank` may pick the ranking instead.
function editorReply(prompt, rank = ids => ids) {
  const d = runDate(prompt);
  const grace = prompt.includes('Do not write any "update" or "correction"');
  const all = candidates(prompt);
  const ranking = rank(all.map(c => c.threadId), d);
  const backstories = [];
  const updates = [];
  for (const c of all.filter(x => ranking.includes(x.threadId))) {
    if (!c.written) {
      backstories.push({ threadId: c.threadId, headline: `${c.threadId} on ${d}`, paragraphs: [`${c.threadId} story to ${d}.`], articleIds: c.ids, why: 'all four' });
    } else if (!grace && c.onDay.length) {
      updates.push({ threadId: c.threadId, kind: 'update', paragraphs: [`More on ${c.threadId} on ${d}.`], articleIds: c.onDay, why: 'new facts' });
    }
  }
  return JSON.stringify({ ranking, backstories, updates });
}

function scriptedModel(answer = prompt => editorReply(prompt)) {
  const prompts = [];
  const ask = async prompt => {
    prompts.push(prompt);
    await tick();
    return answer(prompt, prompts.length);
  };
  return { ask, prompts, editorDates: () => prompts.filter(isEditor).map(runDate) };
}

function deps(db, model, today, extra = {}) {
  let clock = 0;
  return {
    db,
    ask: model.ask,
    enabled: true,
    model: 'test/model',
    today: () => (typeof today === 'function' ? today() : today),
    now: () => new Date(Date.UTC(2026, 9, 1) + (clock += 1000)),
    ...extra,
  };
}

const storyOf = db => db.collections.periodStoriesV2.docs.find(s => s.periodId === WEEK.id);
const storyFor = (db, threadId) => (storyOf(db)?.stories || []).find(s => s.threadId === threadId);
// Each story as [threadId, [part date and kind...]], in stored order.
const shape = db => (storyOf(db)?.stories || []).map(s => [s.threadId, s.parts.map(p => `${p.date} ${p.kind}`)]);

// ---- no key ----

test('with no key nothing runs, nothing is read and nothing throws', async () => {
  const untouchable = { collection() { throw new Error('touched the database'); } };
  let called = false;
  const runs = await catchUp({ db: untouchable, ask: async () => { called = true; }, enabled: false }, WEEK);
  assert.deepEqual(runs, []);
  assert.equal(called, false);
});

// ---- order ----

test('runs happen oldest first; a run with no candidate makes no call', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const model = scriptedModel();
  const runs = await catchUp(deps(db, model, '2026-09-25'), WEEK);

  assert.deepEqual(runs, [
    { date: '2026-09-14', outcome: 'none' },
    { date: '2026-09-15', outcome: 'appended' },
    { date: '2026-09-16', outcome: 'appended' },
    { date: '2026-09-17', outcome: 'appended' },
  ]);
  // 14: T1 is on one edition, so nothing is a candidate yet.
  assert.deepEqual(model.editorDates(), ['2026-09-15', '2026-09-16', '2026-09-17']);
  assert.deepEqual(shape(db), [
    ['T1', ['2026-09-15 backstory']],
    ['T2', ['2026-09-16 backstory']],
    ['T3', ['2026-09-17 backstory']],
  ]);
  const story = storyOf(db);
  assert.deepEqual(story.ranking, ['T1', 'T2', 'T3']);
  assert.equal(story.throughDate, '2026-09-17');
  assert.equal(story.stories[0].headline, 'T1 on 2026-09-15');
  assert.equal(story.stories[0].parts[0].model, 'test/model');
  assert.ok(story.stories[0].parts[0].writtenAt instanceof Date);
  assert.deepEqual(story.attempts, {});

  // Caught up: another pass makes no call.
  const again = await catchUp(deps(db, model, '2026-09-25'), WEEK);
  assert.deepEqual(again, []);
  assert.equal(model.editorDates().length, 3);
});

test('a pass on an open period stops at today', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const model = scriptedModel();
  await catchUp(deps(db, model, '2026-09-15'), WEEK);
  assert.deepEqual(model.editorDates(), ['2026-09-15']);
  assert.equal(storyOf(db).throughDate, '2026-09-15');
});

test('the old day-by-day collection is never read or written', async () => {
  // The fake has no `periodStories`: touching it throws.
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  await catchUp(deps(db, scriptedModel(), '2026-09-25'), WEEK);
  await readStoryState(db, WEEK, '2026-09-25');
  assert.throws(() => db.collection('periodStories'), /no collection/);
  assert.equal(db.collections.periodStoriesV2.docs.length, 1);
});

// ---- updates ----

test('a ranked story gets one update part, dated the run, only when there is something new', async () => {
  const articles = [...baseArticles(), article('a17', 'T1', '2026-09-17')];
  const db = fakeDb({ articles, threads: THREADS });
  await catchUp(deps(db, scriptedModel(), '2026-09-25'), WEEK);
  assert.deepEqual(shape(db), [
    ['T1', ['2026-09-15 backstory', '2026-09-17 update']],
    ['T2', ['2026-09-16 backstory']],
    ['T3', ['2026-09-17 backstory']],
  ]);
  assert.deepEqual(storyFor(db, 'T1').parts[1].articleIds, ['a17']);
});

// ---- the ranking ----

test('a story that drops out is not ranked but keeps its text, and comes back without a new backstory', async () => {
  const articles = [...baseArticles(), article('a17', 'T1', '2026-09-17')];
  const db = fakeDb({ articles, threads: THREADS });
  // On the 16th a bigger story pushes T1 out; on the 17th it comes back.
  const model = scriptedModel(prompt => editorReply(prompt, (ids, d) => (d === '2026-09-16' ? ids.filter(id => id !== 'T1') : ids)));
  const runs = await catchUp(deps(db, model, () => '2026-09-25'), WEEK);
  assert.deepEqual(runs.map(r => r.outcome), ['none', 'appended', 'appended', 'appended']);

  const t1 = storyFor(db, 'T1');
  assert.deepEqual(t1.parts.map(p => `${p.date} ${p.kind}`), ['2026-09-15 backstory', '2026-09-17 update']);
  assert.equal(t1.headline, 'T1 on 2026-09-15');
  // The 17th's prompt showed T1 as written, with its text, so it was not re-told.
  const on17 = model.prompts.find(p => isEditor(p) && runDate(p) === '2026-09-17');
  assert.match(on17, /threadId: T1\n[\s\S]*?ranked now: no\nwritten: yes/);
  assert.ok(on17.includes('T1 story to 2026-09-15.'));
  // Ranked first on the 17th, T2 came first; T1 is back in the list.
  assert.deepEqual(storyOf(db).ranking, ['T2', 'T1', 'T3']);
});

test('the budget is enforced in code, however many the model ranks', async () => {
  // Six threads, each on two editions: one more than a week's budget.
  const articles = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].flatMap(id => [
    article(`${id}-14`, id, '2026-09-14'), article(`${id}-15`, id, '2026-09-15'),
  ]);
  const db = fakeDb({ articles, threads: THREADS });
  await catchUp(deps(db, scriptedModel(), '2026-09-25'), WEEK);
  assert.deepEqual(storyOf(db).ranking, ['T1', 'T2', 'T3', 'T4', 'T5']);
  assert.equal(storyOf(db).stories.length, 5);
});

// ---- frozen ----

test('a part dated before today is byte-for-byte unchanged by every later run', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const model = scriptedModel();
  let today = '2026-09-16';
  await catchUp(deps(db, model, () => today), WEEK);
  const frozen = structuredClone(storyOf(db).stories);

  // New editions, a same-day filing into the 16th after the day has passed,
  // and a late filing into the 14th.
  today = '2026-09-19';
  db.collections.articles.docs.push(
    article('a19', 'T1', '2026-09-19', { _createdAt: new Date('2026-09-19T06:00:00Z') }),
    article('b16x', 'T2', '2026-09-16', { _createdAt: new Date('2026-09-19T07:00:00Z') }),
    article('a14x', 'T1', '2026-09-14', { _createdAt: new Date('2026-09-19T08:00:00Z') }),
  );
  await catchUp(deps(db, model, () => today), WEEK);

  const after = storyOf(db).stories;
  for (const before of frozen) {
    const now = after.find(s => s.threadId === before.threadId);
    assert.equal(now.headline, before.headline);
    assert.equal(JSON.stringify(now.parts.slice(0, before.parts.length)), JSON.stringify(before.parts));
  }
  assert.ok(after.flatMap(s => s.parts).length > frozen.flatMap(s => s.parts).length);
});

// ---- same day ----

test("a same-day re-push, then a reopen, replaces only today's parts and ranking", async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const model = scriptedModel();
  await catchUp(deps(db, model, '2026-09-16'), WEEK);
  const before = structuredClone(storyOf(db).stories);
  assert.deepEqual(shape(db), [['T1', ['2026-09-15 backstory']], ['T2', ['2026-09-16 backstory']]]);

  // Re-push of today: a new article on T4, which joins T4's earlier one.
  db.collections.articles.docs.push(
    article('d15', 'T4', '2026-09-15', { _createdAt: new Date('2026-09-15T05:00:00Z') }),
    article('d16', 'T4', '2026-09-16', { _createdAt: new Date('2026-09-16T09:00:00Z') }),
  );
  const runs = await catchUp(deps(db, model, '2026-09-16'), WEEK);

  assert.deepEqual(runs, [{ date: '2026-09-16', outcome: 'replaced' }]);
  assert.deepEqual(shape(db), [['T1', ['2026-09-15 backstory']], ['T2', ['2026-09-16 backstory']], ['T4', ['2026-09-16 backstory']]]);
  assert.deepEqual(storyFor(db, 'T1'), before[0]);
  // T2's backstory was today's, so it was written again.
  assert.notDeepEqual(storyFor(db, 'T2').parts[0].writtenAt, before[1].parts[0].writtenAt);
  assert.deepEqual(storyOf(db).ranking, ['T1', 'T2', 'T4']);
});

// ---- late filing ----

test('a late filing after the period is read by a run dated today, which only admits', async () => {
  const articles = [...baseArticles(), article('a16', 'T1', '2026-09-16')];
  const db = fakeDb({ articles, threads: THREADS });
  const model = scriptedModel();
  await catchUp(deps(db, model, '2026-10-05'), WEEK);
  const before = structuredClone(storyOf(db).stories);

  // T4 had one edition; the late filing gives it a second, inside the period.
  // A late article on T1 is new too, but a grace run writes no update.
  db.collections.articles.docs.push(
    article('d14', 'T4', '2026-09-14'),
    article('d16', 'T4', '2026-09-16', { _createdAt: new Date('2026-10-05T08:00:00Z') }),
    article('a17', 'T1', '2026-09-17', { _createdAt: new Date('2026-10-05T08:00:00Z') }),
  );
  const runs = await catchUp(deps(db, model, '2026-10-05'), WEEK);

  assert.deepEqual(runs, [{ date: '2026-10-05', outcome: 'appended' }]);
  const after = storyOf(db).stories;
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(before.length).map(s => [s.threadId, s.parts.map(p => `${p.date} ${p.kind}`)]), [['T4', ['2026-10-05 backstory']]]);
  assert.ok(storyOf(db).ranking.includes('T4'));
  assert.equal(storyOf(db).throughDate, '2026-10-05');

  // Seen now: reopening makes no call.
  const calls = model.prompts.length;
  assert.deepEqual(await catchUp(deps(db, model, '2026-10-06'), WEEK), []);
  assert.equal(model.prompts.length, calls);
});

test('a late filing while edition runs are still due is read once, by a run dated today at the end', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const model = scriptedModel();
  await catchUp(deps(db, model, '2026-09-16'), WEEK);
  const before = structuredClone(storyOf(db).stories);

  // The 17th is still due. T4 had one edition; the late filing into the 15th
  // gives it a second.
  db.collections.articles.docs.push(
    article('d14', 'T4', '2026-09-14'),
    article('d15', 'T4', '2026-09-15', { _createdAt: new Date('2026-09-18T08:00:00Z') }),
  );
  const runs = await catchUp(deps(db, model, '2026-09-18'), WEEK);

  assert.deepEqual(runs, [{ date: '2026-09-17', outcome: 'appended' }, { date: '2026-09-18', outcome: 'appended' }]);
  // The edition run did not read the late filing, so it cannot go into a
  // part dated in the past.
  const edition17 = model.prompts.find(p => isEditor(p) && runDate(p) === '2026-09-17');
  assert.equal(edition17.includes('articleId: d15'), false);
  assert.equal(edition17.includes('threadId: T4'), false);
  const after = storyOf(db).stories;
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(shape(db).slice(before.length), [['T3', ['2026-09-17 backstory']], ['T4', ['2026-09-18 backstory']]]);
  assert.equal(storyOf(db).late, null);

  // Seen once: reopening makes no call.
  const calls = model.prompts.length;
  assert.deepEqual(await catchUp(deps(db, model, '2026-09-18'), WEEK), []);
  assert.equal(model.prompts.length, calls);
});

// ---- grace window ----

test('editions in the 3-day grace window run; the 4th day after the end does not', async () => {
  const articles = [
    ...baseArticles(),
    article('c21', 'T3', '2026-09-21'),
    article('c23', 'T3', '2026-09-23'),
    article('c24', 'T3', '2026-09-24'),
  ];
  const db = fakeDb({ articles, threads: THREADS });
  const model = scriptedModel();
  const runs = await catchUp(deps(db, model, '2026-10-01'), WEEK);
  assert.deepEqual(runs.map(r => r.date),
    ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-21', '2026-09-23']);
  // The grace run sees the grace edition as evidence, marked not citable.
  const graceRun = model.prompts.find(p => isEditor(p) && runDate(p) === '2026-09-23');
  assert.ok(graceRun.includes('c23'));
  assert.ok(graceRun.includes('after the period: evidence only'));
  assert.equal(graceRun.includes('c24'), false);
  // T3 has articles on the grace days, but a grace run writes no update.
  assert.deepEqual(storyFor(db, 'T3').parts.map(p => p.kind), ['backstory']);
});

// ---- doubled runs ----

test('two opens at once do not add the same part twice', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const model = scriptedModel();
  await Promise.all([
    catchUp(deps(db, model, '2026-09-25'), WEEK),
    catchUp(deps(db, model, '2026-09-25'), WEEK),
  ]);
  assert.deepEqual(shape(db), [
    ['T1', ['2026-09-15 backstory']],
    ['T2', ['2026-09-16 backstory']],
    ['T3', ['2026-09-17 backstory']],
  ]);
  assert.equal(storyOf(db).throughDate, '2026-09-17');
});

test('the queue takes a period once while it is queued, and never runs before the caller returns', async () => {
  const errors = [];
  const queue = createStoryQueue((key, err) => errors.push([key, err.message]));
  const started = [];
  const job = key => async () => { started.push(key); await tick(); };

  assert.equal(queue.enqueue('2026-W38', job('first')), true);
  assert.equal(queue.enqueue('2026-W38', job('second')), false);
  assert.equal(queue.enqueue('2026-09', job('month')), true);
  assert.equal(queue.isQueued('2026-W38'), true);
  // Nothing has started: the caller has already moved on.
  assert.deepEqual(started, []);

  await queue.idle();
  assert.deepEqual(started, ['first', 'month']);
  assert.equal(queue.isQueued('2026-W38'), false);

  // A failing job is reported and does not stop the next one.
  queue.enqueue('bad', async () => { throw new Error('boom'); });
  queue.enqueue('good', job('good'));
  await queue.idle();
  assert.deepEqual(errors, [['bad', 'boom']]);
  assert.deepEqual(started, ['first', 'month', 'good']);
});

// ---- three attempts ----

test('a date that fails three times is skipped and later runs still proceed', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const model = scriptedModel(prompt => {
    if (isEditor(prompt) && runDate(prompt) === '2026-09-15') throw new Error('OpenRouter answered 500');
    return editorReply(prompt);
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(catchUp(deps(db, model, '2026-09-25'), WEEK), /500/);
    assert.equal(storyOf(db).attempts['2026-09-15'], attempt);
    assert.equal(storyOf(db).throughDate, '2026-09-14');
  }

  const runs = await catchUp(deps(db, model, '2026-09-25'), WEEK);
  assert.deepEqual(runs.map(r => [r.date, r.outcome]), [
    ['2026-09-15', 'skipped'], ['2026-09-16', 'appended'], ['2026-09-17', 'appended'],
  ]);
  assert.equal(model.editorDates().filter(d => d === '2026-09-15').length, 3);
  // The skipped date's articles are still evidence.
  const next = model.prompts.find(p => isEditor(p) && runDate(p) === '2026-09-16');
  assert.ok(next.includes('articleId: a15'));
  assert.deepEqual(shape(db)[0], ['T1', ['2026-09-16 backstory']]);
  assert.equal(storyOf(db).attempts['2026-09-15'], undefined);
});

test('an editor reply with no ranking is a failed attempt, not an empty ranking', async () => {
  for (const bad of ['I could not do that.', '{"entries": []}']) {
    const db = fakeDb({ articles: baseArticles(), threads: THREADS });
    await assert.rejects(catchUp(deps(db, scriptedModel(() => bad), '2026-09-25'), WEEK), /parses/);
    assert.equal(storyOf(db).throughDate, '2026-09-14');
    assert.equal(storyOf(db).attempts['2026-09-15'], 1);
    assert.deepEqual(storyOf(db).stories, []);
  }
});

test('an empty ranking over a stored ranking is a failed attempt; after three the date is skipped and the ranking stays', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const model = scriptedModel(prompt => (runDate(prompt) === '2026-09-17' ? '{"ranking": []}' : editorReply(prompt)));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(catchUp(deps(db, model, '2026-09-25'), WEEK), /ranked nothing/);
    assert.equal(storyOf(db).attempts['2026-09-17'], attempt);
    assert.equal(storyOf(db).throughDate, '2026-09-16');
    assert.deepEqual(storyOf(db).ranking, ['T1', 'T2']);
  }
  const runs = await catchUp(deps(db, model, '2026-09-25'), WEEK);
  assert.deepEqual(runs, [{ date: '2026-09-17', outcome: 'skipped' }]);
  assert.deepEqual(storyOf(db).ranking, ['T1', 'T2']);
  assert.equal(storyOf(db).throughDate, '2026-09-17');
});

test('an empty ranking with nothing stored yet is a normal answer', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const runs = await catchUp(deps(db, scriptedModel(() => '{"ranking": []}'), '2026-09-25'), WEEK);
  assert.deepEqual(runs.map(r => r.outcome), ['none', 'none', 'none', 'none']);
  assert.deepEqual(storyOf(db).ranking, []);
  assert.deepEqual(storyOf(db).attempts, {});
  assert.equal(storyOf(db).throughDate, '2026-09-17');
});

test('a run with no candidate makes no call and still advances', async () => {
  // Only a grace-window article: nothing in the period itself.
  const db = fakeDb({ articles: [article('z22', 'T1', '2026-09-22')], threads: THREADS });
  const model = scriptedModel();
  const runs = await catchUp(deps(db, model, '2026-09-25'), WEEK);
  assert.deepEqual(runs, [{ date: '2026-09-22', outcome: 'none' }]);
  assert.equal(model.prompts.length, 0);
  assert.equal(storyOf(db).throughDate, '2026-09-22');
});

// ---- grouping ----

test('ungrouped articles are grouped up to the run date before the editor runs', async () => {
  const articles = baseArticles().map(({ _threadId, ...a }) => a);
  const db = fakeDb({ articles });
  const model = scriptedModel(prompt => (isEditor(prompt) ? editorReply(prompt) : ''));
  await catchUp(deps(db, model, '2026-09-15'), WEEK);
  const grouped = db.collections.articles.docs.filter(a => a._threadId).map(a => a.id).sort();
  assert.deepEqual(grouped, ['a14', 'a15', 'b15']);
});

test('an edition whose grouping keeps failing does not wedge later runs', async () => {
  // b16 is ungrouped, and every grouping call fails.
  const articles = baseArticles().map(a => (a.id === 'b16' ? (({ _threadId, ...rest }) => rest)(a) : a));
  const db = fakeDb({ articles, threads: THREADS });
  const model = scriptedModel(prompt => {
    if (!isEditor(prompt)) throw new Error('OpenRouter answered 503');
    return editorReply(prompt);
  });

  await assert.rejects(catchUp(deps(db, model, '2026-09-25'), WEEK), /503/);
  await assert.rejects(catchUp(deps(db, model, '2026-09-25'), WEEK), /503/);
  assert.equal(storyOf(db).throughDate, '2026-09-15');
  assert.equal(storyOf(db).attempts['2026-09-16'], 2);

  // Third attempt: the failing call files b16 alone, and the story moves on.
  const runs = await catchUp(deps(db, model, '2026-09-25'), WEEK);
  assert.deepEqual(runs.map(r => r.date), ['2026-09-16', '2026-09-17']);
  const b16 = db.collections.articles.docs.find(a => a.id === 'b16');
  assert.ok(b16._threadId);
  assert.notEqual(b16._threadId, 'T2');
  assert.equal(storyOf(db).throughDate, '2026-09-17');
});

test('the last-attempt grouping call turns a failure into an empty reply', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await emptyOnFailure(async () => { throw new Error('down'); })('p'), '');
    assert.equal(await emptyOnFailure(async p => `echo ${p}`)('p'), 'echo p');
  } finally {
    console.error = quiet;
  }
});

// ---- state for the endpoint ----

test('the story state reads without writing, and names the runs due', async () => {
  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  const state = await readStoryState(db, WEEK, '2026-09-25');
  assert.deepEqual(state.due, ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']);
  assert.deepEqual(state.story.stories, []);
  assert.deepEqual(state.story.ranking, []);
  assert.equal(db.collections.periodStoriesV2.docs.length, 0);
});

test('the endpoint status: writing while runs are due, ready once caught up, even with nothing ranked', async () => {
  const { storyStatus } = require('../periodStory');
  const { toStory, storyArticleIds } = require('../wire');
  const status = (state, articleCount = 6) =>
    storyStatus({ articleCount, due: state.due, queued: false, enabled: true });

  const db = fakeDb({ articles: baseArticles(), threads: THREADS });
  assert.equal(status(await readStoryState(db, WEEK, '2026-09-25')), 'writing');
  await catchUp(deps(db, scriptedModel(), '2026-09-25'), WEEK);
  const state = await readStoryState(db, WEEK, '2026-09-25');
  assert.equal(status(state), 'ready');

  const wire = toStory(state.story, new Set(storyArticleIds(state.story)));
  assert.deepEqual(wire.stories.map(s => s.threadId), ['T1', 'T2', 'T3']);
  assert.equal(JSON.stringify(wire).match(/"(why|verification|basis|writtenAt|model)"/), null);

  const quiet = fakeDb({ articles: baseArticles(), threads: THREADS });
  await catchUp(deps(quiet, scriptedModel(() => '{"ranking": []}'), '2026-09-25'), WEEK);
  const quietState = await readStoryState(quiet, WEEK, '2026-09-25');
  assert.equal(status(quietState), 'ready');
  assert.deepEqual(toStory(quietState.story, new Set()), { stories: [] });

  assert.equal(status(await readStoryState(fakeDb(), WEEK, '2026-09-25'), 0), 'none');
});
