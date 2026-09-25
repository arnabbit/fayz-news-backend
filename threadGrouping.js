// Stores threads: files each ungrouped article into one, edition by edition.
// The rules live in threads.js; this is the part that reads and writes. The
// database and the model call are passed in, so the order and storage rules
// are testable without either.
//
//   storyThreads       { threadId, title, category, firstDate, lastDate, articleIds[] }
//   articles._threadId  set once, here, and never by POST /api/articles
//
// `articles._threadId` is the source of truth. A thread document is written
// only for the articles this run actually filed.

const {
  threadWindowStart,
  recentHeadlines,
  buildGroupingPrompt,
  parseGroupingReply,
  validateGrouping,
} = require('./threads');

// Hidden articles are grouped too: `hidden` is a read filter, and toggling it
// must not need a regroup. So nothing here matches on `hidden`.
const UNGROUPED = { _threadId: { $exists: false }, id: { $exists: true } };

// Threads that were active in the 60 days up to the edition. No upper bound:
// a late filing into a past edition is grouped against every thread that
// exists when it is grouped, including ones that started after its date.
async function candidateThreads(db, dateKey) {
  const threads = await db.collection('storyThreads')
    .find(
      { lastDate: { $gte: threadWindowStart(dateKey) } },
      { projection: { _id: 0, threadId: 1, title: 1, category: 1, lastDate: 1 } }
    )
    .toArray();
  if (threads.length === 0) return [];

  const rows = await db.collection('articles')
    .find(
      { _threadId: { $in: threads.map(t => t.threadId) } },
      { projection: { _id: 0, _threadId: 1, headline: 1, _dateKey: 1 } }
    )
    .toArray();
  const headlines = recentHeadlines(rows);
  return threads.map(t => ({ ...t, headlines: headlines.get(t.threadId) || [] }));
}

// Groups the OLDEST ungrouped edition on or before `throughDate`, and only
// that one. The caller cannot name the edition, which is how an edition is
// never grouped before an earlier one: its candidates are the threads that
// exist before it.
//
// Returns `{ dateKey, grouped }`, or null when nothing is ungrouped. A failed
// model call throws and stores nothing.
async function groupNextEdition({ db, ask }, throughDate) {
  const articles = db.collection('articles');
  const next = await articles.findOne(
    { ...UNGROUPED, _dateKey: { $lte: throughDate } },
    { sort: { _dateKey: 1 }, projection: { _id: 0, _dateKey: 1 } }
  );
  if (!next) return null;
  const dateKey = next._dateKey;

  const edition = await articles
    .find(
      { ...UNGROUPED, _dateKey: dateKey },
      { projection: { _id: 0, id: 1, headline: 1, dek: 1, category: 1, 'developments.summary': 1 } }
    )
    .toArray();
  const known = await candidateThreads(db, dateKey);

  // One model call per edition.
  const reply = await ask(buildGroupingPrompt(dateKey, edition, known));
  const { assignments, newThreads } = validateGrouping(parseGroupingReply(reply), edition, known);

  // Articles first, each only if it is still ungrouped, so an article filed by
  // another writer in the meantime keeps the thread it was given.
  const filed = new Map();
  for (const { articleId, threadId } of assignments) {
    const result = await articles.updateOne(
      { id: articleId, _threadId: { $exists: false } },
      { $set: { _threadId: threadId } }
    );
    if (result.modifiedCount !== 1) continue;
    if (!filed.has(threadId)) filed.set(threadId, []);
    filed.get(threadId).push(articleId);
  }

  // Then the threads, for what actually landed. A new thread nothing landed in
  // is never written.
  const fresh = new Map(newThreads.map(t => [t.threadId, t]));
  for (const [threadId, articleIds] of filed) {
    const created = fresh.get(threadId);
    const update = {
      $addToSet: { articleIds: { $each: articleIds } },
      $min: { firstDate: dateKey },
      $max: { lastDate: dateKey },
    };
    if (created) update.$setOnInsert = { title: created.title, category: created.category };
    await db.collection('storyThreads').updateOne({ threadId }, update, { upsert: Boolean(created) });
  }

  const grouped = [...filed.values()].reduce((sum, ids) => sum + ids.length, 0);
  return { dateKey, grouped };
}

// Groups every ungrouped edition on or before `throughDate`, oldest first, one
// model call each. Returns the edition dates it grouped, in order. The catch-up
// run calls this before it writes a section for `throughDate`.
async function groupThrough(deps, throughDate) {
  const done = [];
  for (;;) {
    const step = await groupNextEdition(deps, throughDate);
    if (!step) return done;
    // The same edition twice in a row means articles arrived while it was
    // being grouped. It is still one edition.
    if (done[done.length - 1] !== step.dateKey) done.push(step.dateKey);
    // A step that filed nothing cannot be followed by one that does better.
    if (step.grouped === 0) return done;
  }
}

module.exports = { groupNextEdition, groupThrough };
