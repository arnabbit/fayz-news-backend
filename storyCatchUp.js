// Grows a period's story: one run per due date, oldest first, each appending
// at most one section. The rules live in periodStory.js (progress and guards),
// threadGrouping.js (threads) and story.js (the editor); this is the part that
// reads, calls and writes. The database, the model call and the clock are
// passed in, so the whole run is testable without any of them.
//
// Runs only after a period response has gone out, through one in-process
// queue (createStoryQueue). Render runs one instance; the storage guards make
// a second one harmless, at worst a repeated model call.

const { parseModelReply } = require('./model');
const { groupThrough } = require('./threadGrouping');
const { buildEvidence, buildStoryPrompt, validateSection } = require('./story');
const {
  MAX_ATTEMPTS,
  OUTCOME,
  laterDate,
  storyWindow,
  editionFacts,
  lateFilings,
  withoutLateFilings,
  dueRuns,
  claimUpdate,
  storeUpdate,
  emptyStory,
} = require('./periodStory');

const STORIES = 'periodStories';

// A bound on one pass, far above a year's editions. It only stops a loop that
// something unforeseen keeps from making progress.
const MAX_RUNS_PER_PASS = 500;

// A grouping call that fails yields an empty reply instead, and an empty reply
// files every article into a thread of its own (threads.js). Used on a date's
// last attempt only, so an edition the model cannot group becomes a false
// split — which the editor can still write about — rather than a block on
// every later edition, in every period, for ever.
function emptyOnFailure(ask) {
  return async prompt => {
    try {
      return await ask(prompt);
    } catch (err) {
      console.error('grouping call failed on a last attempt; filing each article alone:', err.message);
      return '';
    }
  };
}

// The stored story, or an empty one when no run has happened yet.
async function readStory(db, periodId) {
  const doc = await db.collection(STORIES).findOne({ periodId });
  return doc || { ...emptyStory(), periodId };
}

// The stored story, the run dates due for it and its late filings, as of
// `today`. Reads only. This is also what the period endpoint needs for its
// status.
async function readStoryState(db, period, today) {
  const story = await readStory(db, period.id);
  const window = storyWindow(period, today);
  if (window.from > window.to) return { story, due: [], late: null };
  const rows = await db.collection('articles')
    .find(
      { hidden: { $ne: true }, _dateKey: { $gte: window.from, $lte: window.to } },
      { projection: { _id: 0, _dateKey: 1, _createdAt: 1 } }
    )
    .toArray();
  const editions = editionFacts(rows);
  return { story, due: dueRuns(period, today, editions, story), late: lateFilings(period, today, editions, story) };
}

// Every guarded update needs a document to match, so the first run creates
// it. A racer creating it too collides on the unique index, which is fine.
async function ensureStory(db, periodId) {
  try {
    await db.collection(STORIES).updateOne({ periodId }, { $setOnInsert: emptyStory() }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
}

// The newest filing time among the visible rows, or null when none is known.
const newestCreatedAt = rows => rows
  .filter(row => row.hidden !== true)
  .reduce((newest, row) => laterDate(newest, row._createdAt), null);

// One run for date `d`. Returns what happened, an OUTCOME: LOST when another
// writer moved the story first.
// A failed model call throws, with the attempt already counted. `late` is
// lateFilings: a run before today does not read them.
async function runOnce(deps, period, story, d, today, late) {
  const { db, ask, model } = deps;
  const stories = db.collection(STORIES);
  const window = storyWindow(period, today);
  const end = d < window.to ? d : window.to;

  const readRows = () => db.collection('articles')
    .find(
      { _dateKey: { $gte: period.range.from, $lte: end } },
      {
        projection: {
          _id: 0, id: 1, _threadId: 1, _dateKey: 1, _createdAt: 1, hidden: 1,
          headline: 1, dek: 1, body: 1, 'developments.summary': 1, sourcePosts: 1,
        },
      }
    )
    .toArray();

  const claim = claimUpdate(story, d);
  if (!claim) {
    // Three attempts spent: the date is skipped, and its articles stay
    // evidence for every later run.
    const rows = await readRows();
    const skip = storeUpdate({ story, date: d, today, section: null, consumed: newestCreatedAt(rows), model, now: deps.now(), late });
    const result = await stories.updateOne(skip.filter, skip.update);
    return result.matchedCount ? OUTCOME.SKIPPED : OUTCOME.LOST;
  }
  const claimed = await stories.updateOne(claim.filter, claim.update);
  if (!claimed.matchedCount) return OUTCOME.LOST;

  // Step 1: group what is ungrouped up to `d`.
  const lastAttempt = claim.attempt >= MAX_ATTEMPTS;
  if (deps.group) await deps.group(d, lastAttempt);
  else await groupThrough({ db, ask: lastAttempt ? emptyOnFailure(ask) : ask }, d);

  // Step 2: the evidence up to `d`.
  const rows = await readRows();
  const read = withoutLateFilings(rows, late, d, today);
  const threadIds = [...new Set(read.map(r => r._threadId).filter(Boolean))];
  const threads = threadIds.length
    ? await db.collection('storyThreads')
      .find({ threadId: { $in: threadIds } }, { projection: { _id: 0, threadId: 1, title: 1, category: 1 } })
      .toArray()
    : [];
  const evidence = buildEvidence(period, d, threads, read, story);

  // Step 3: the editor. No evidence, no call.
  let section = null;
  if (evidence.length) {
    const reply = await ask(buildStoryPrompt(period, d, evidence, story));
    // Unparseable is a failed attempt. A parsed reply with nothing that
    // survives validation is a normal answer: no section.
    const parsed = parseModelReply(reply);
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error('the editor returned nothing that parses');
    section = validateSection(parsed, period, d, evidence, story);
  }

  // Step 4: store, guarded.
  const store = storeUpdate({ story, date: d, today, section, consumed: newestCreatedAt(rows), model, now: deps.now(), late });
  const result = await stories.updateOne(store.filter, store.update);
  return result.matchedCount ? store.outcome : OUTCOME.LOST;
}

// Brings one period's story up to date. Returns the runs it made, in order,
// as `[{ date, outcome }]`. Stops at the first failure and rethrows it: the
// attempt is counted, and the next open tries again.
//
//   deps  { db, ask, enabled, model, today: () => 'YYYY-MM-DD', now: () => Date,
//           group?: (d, lastAttempt) => Promise }   group defaults to groupThrough
async function catchUp(deps, period) {
  const runs = [];
  if (!deps.enabled) return runs;
  await ensureStory(deps.db, period.id);

  for (let i = 0; i < MAX_RUNS_PER_PASS; i += 1) {
    const today = deps.today();
    const { story, due, late } = await readStoryState(deps.db, period, today);
    if (!due.length) return runs;
    const date = due[0];
    const outcome = await runOnce(deps, period, story, date, today, late);
    runs.push({ date, outcome });
  }
  return runs;
}

// One in-process queue for everything the story does: grouping and every
// period's runs, one at a time. A period already queued or running is not
// queued again. `enqueue` returns at once; the job starts on a later tick, so
// a caller that has just responded never waits for it.
function createStoryQueue(onError = () => {}) {
  const queued = new Set();
  let tail = Promise.resolve();

  function enqueue(key, job) {
    if (queued.has(key)) return false;
    queued.add(key);
    tail = tail
      .then(() => job())
      .catch(err => onError(key, err))
      .then(() => { queued.delete(key); });
    return true;
  }

  return {
    enqueue,
    isQueued: key => queued.has(key),
    // Resolves when everything queued so far has finished. For tests.
    idle: () => tail,
  };
}

module.exports = {
  STORIES,
  emptyOnFailure,
  readStory,
  readStoryState,
  catchUp,
  createStoryQueue,
};
