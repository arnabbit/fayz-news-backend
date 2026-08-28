require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { computeArticleId, qualifyArticleId, normalizeHeadline } = require('./articleId');
const { editionDateKey, editionDateLabel } = require('./editionDate');
const { slugifyCategory, editionCategories } = require('./categories');
const { DEK_CAP } = require('./dek');
const { toFeedItem, toArticle, FEED_PROJECTION } = require('./wire');
const { pushTokenDocument } = require('./pushTokens');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'fayznews';

// One shared secret guards both writes. It lives in extension source, so it is
// anti-drive-by rather than auth — stated plainly so nobody mistakes it for the
// latter. Rollout is two-phase: with REQUIRE_PUSH_KEY unset the endpoint accepts
// an unauthenticated push and logs it, so shipping the backend can never stop
// the pipeline; flip it to true once the extension sends the header.
const CHRONICLE_KEY = process.env.CHRONICLE_KEY || '';
const REQUIRE_PUSH_KEY = String(process.env.REQUIRE_PUSH_KEY || '').toLowerCase() === 'true';

// Canonical order for display
const CATEGORY_ORDER = [
  'home', 'politics', 'world', 'sports', 'economy',
  'technology', 'entertainment', 'science', 'health', 'legal', 'environment',
];
const CATEGORY_NAMES = {
  home: 'Home', politics: 'Politics', world: 'World', sports: 'Sports',
  economy: 'Economy', technology: 'Technology', entertainment: 'Entertainment',
  science: 'Science', health: 'Health', legal: 'Legal', environment: 'Environment',
};

let db;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  // Index for fast queries
  await db.collection('articles').createIndex({ published_date: -1 });
  await db.collection('articles').createIndex({ category: 1 });
  await db.collection('articles').createIndex({ _dateKey: 1, _id: -1 });
  await db.collection('articles').createIndex({ _dateKey: 1, category: 1, _id: -1 });
  // Article identity is content-derived; the unique index is the last line of
  // defence against a duplicate insert racing two concurrent pushes.
  try {
    await db.collection('articles').createIndex({ id: 1 }, { unique: true, name: 'id_unique' });
  } catch (err) {
    console.error(
      'WARNING: could not create unique index on `id` — duplicate ids exist. ' +
      'Run `node scripts/backfill-article-ids.js --apply` then restart.',
      err.message
    );
  }
  console.log('Connected to MongoDB');
}

async function latestDateKey() {
  const doc = await db.collection('articles').findOne(
    {},
    { sort: { _createdAt: -1 }, projection: { _dateKey: 1 } }
  );
  return doc ? doc._dateKey : null;
}

// ---- v2 shared plumbing ----

// Every v2 read matches this, including counts and category lists. A count that
// disagrees with the list it summarises is a bug report waiting to happen.
const VISIBLE = { hidden: { $ne: true } };

// The latest *edition*, which is the largest `_dateKey` — not the most recently
// created document. `latestDateKey()` above sorts by `_createdAt` and stays as
// it is only because the dying v1 endpoints already depend on it; sorting by
// creation time answers a different question and is subtly wrong for this one.
async function latestEditionKey() {
  const doc = await db.collection('articles').findOne(
    VISIBLE,
    { sort: { _dateKey: -1 }, projection: { _dateKey: 1 } }
  );
  return doc ? doc._dateKey : null;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function clampLimit(value, fallback, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

// The only cold-start lever there is. A past edition can never gain or lose an
// article, so it is cacheable for a day; anything resolved through `latest`
// gets five minutes. Accepted cost: a same-day re-push is invisible to a web
// reader for up to five minutes.
function cacheEdition(res, dateKey, latestKey) {
  const immutable = dateKey && latestKey && dateKey !== latestKey;
  res.set('Cache-Control', immutable ? 'public, max-age=86400' : 'public, max-age=300');
}

// Resolves the `:date` path segment. `latest` is a valid sentinel so a cold
// Render instance costs one round trip rather than two.
async function resolveEditionDate(raw) {
  if (raw === 'latest') {
    const dateKey = await latestEditionKey();
    return { dateKey, latestKey: dateKey, resolvedFromLatest: true };
  }
  if (!DATE_KEY.test(raw)) return { invalid: true };
  const latestKey = await latestEditionKey();
  return { dateKey: raw, latestKey, resolvedFromLatest: false };
}

// A `$group` on `_dateKey`, which is what an edition *is* — there is no
// editions collection, and 75% of days have no edition at all.
async function editionRows(match, limit) {
  const rows = await db.collection('articles').aggregate([
    { $match: match },
    { $group: { _id: '$_dateKey', count: { $sum: 1 }, categories: { $addToSet: '$category' } } },
    { $sort: { _id: -1 } },
    { $limit: limit },
  ]).toArray();
  return rows.map(row => ({
    date: row._id,
    count: row.count,
    categories: editionCategories(row.categories),
  }));
}

// Registration is open and sending is behind the key (ticket 07), so this
// guards writes only.
function requireKey(req, res, next) {
  const provided = req.get('X-Chronicle-Key') || '';
  const ok = CHRONICLE_KEY !== '' && provided === CHRONICLE_KEY;
  if (ok) return next();
  if (!REQUIRE_PUSH_KEY) {
    console.warn(
      `unauthenticated write accepted: ${req.method} ${req.originalUrl} ` +
      `(REQUIRE_PUSH_KEY is off${CHRONICLE_KEY === '' ? ', CHRONICLE_KEY is unset' : ''})`
    );
    return next();
  }
  return fail(res, 401, 'unauthorized', 'X-Chronicle-Key missing or wrong');
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function cleanDevelopments(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    summary: String(item?.summary || '').trim(),
    sourcePostUrls: cleanStringArray(item?.sourcePostUrls)
  })).filter(item => item.summary);
}

function cleanSourcePosts(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    postUrl: String(item?.postUrl || '').trim(),
    postNumber: Number.isFinite(Number(item?.postNumber)) ? Number(item.postNumber) : null,
    sourceHeadline: String(item?.sourceHeadline || '').trim(),
    mediaTypes: cleanStringArray(item?.mediaTypes),
    captureMethods: cleanStringArray(item?.captureMethods),
    slideCount: Number.isFinite(Number(item?.slideCount)) ? Number(item.slideCount) : 0
  })).filter(item => item.postUrl || item.sourceHeadline);
}

// ---- POST /api/articles — extension pushes articles here ----
app.post('/api/articles', requireKey, async (req, res) => {
  try {
    const { articles } = req.body;
    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'articles array required' });
    }

    // Both derived in IST (see editionDate.js) — the host is UTC on Render.
    const now = new Date();
    const date = editionDateLabel(now);
    const dateKey = editionDateKey(now);

    // Append-only: never delete an existing edition. A same-day second push adds
    // to it. Identity is content-derived, so a re-push of the same story (or a
    // retry after a post-write 500) updates in place instead of duplicating.
    const docs = articles.map(a => {
      const sourcePosts = cleanSourcePosts(a.sourcePosts);
      const headline = a.headline || 'Untitled';
      return {
        id: computeArticleId({ headline, sourcePosts }, dateKey),
        headline,
        // Normalised on write: a slug on disk and a slug on the wire.
        category: slugifyCategory(a.category) || 'world',
        // The merge pass writes this; the archive has none and never will, so
        // the server falls back per request instead (see dek.js). Capped here
        // as well as in the extension's validator, because the cap is the
        // wire's promise and not the extension's.
        dek: String(a.dek || '').trim().slice(0, DEK_CAP),
        body: Array.isArray(a.body) ? a.body : [String(a.body || '')],
        developments: cleanDevelopments(a.developments),
        sourcePosts
      };
    });

    // Several stories can share a base id (one roundup reel, many stories).
    // Never let that silently drop or overwrite one: the first story to claim a
    // base id keeps it, any other story on that id gets a headline-qualified id.
    // Sorting by headline keeps the assignment independent of payload order, so
    // a retried payload re-derives exactly the same ids.
    const existing = await db.collection('articles')
      .find({ id: { $in: docs.map(d => d.id) } }, { projection: { id: 1, headline: 1 } })
      .toArray();
    const claimedBy = new Map(existing.map(e => [e.id, normalizeHeadline(e.headline)]));

    // Collapse the same story sent twice in one payload.
    const byStory = new Map();
    for (const doc of docs) byStory.set(`${doc.id}|${normalizeHeadline(doc.headline)}`, doc);

    const uniqueDocs = [];
    const assigned = new Set();
    const candidates = [...byStory.values()].sort(
      (a, b) => normalizeHeadline(a.headline).localeCompare(normalizeHeadline(b.headline))
    );
    for (const doc of candidates) {
      const headline = normalizeHeadline(doc.headline);
      const owner = claimedBy.get(doc.id);
      if (owner !== undefined && owner !== headline) {
        doc.id = qualifyArticleId(doc.id, doc.headline);
      } else {
        claimedBy.set(doc.id, headline);
      }
      if (assigned.has(doc.id)) continue;
      assigned.add(doc.id);
      uniqueDocs.push(doc);
    }

    await db.collection('articles').bulkWrite(
      uniqueDocs.map(doc => ({
        updateOne: {
          filter: { id: doc.id },
          update: {
            $set: { ...doc, _updatedAt: now },
            // The edition an article first landed in is its edition. A re-push
            // updates the story, it does not move it to another day.
            $setOnInsert: { published_date: date, _dateKey: dateKey, _createdAt: now }
          },
          upsert: true
        }
      })),
      { ordered: false }
    );

    res.json({ ok: true, date, count: uniqueDocs.length });
  } catch (err) {
    console.error('POST /api/articles error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/categories — only categories present in the latest date's articles ----
app.get('/api/categories', async (req, res) => {
  try {
    const dateKey = await latestDateKey();
    if (!dateKey) {
      return res.json({ categories: [] });
    }
    // `hidden` is the one lever for pulling a bad story, so it has to hold on
    // the endpoints still being served until v1 is deleted.
    const slugs = await db.collection('articles')
      .distinct('category', { _dateKey: dateKey, hidden: { $ne: true } });
    // Normalise to slugs, deduplicate, sort by canonical order
    const found = new Set(slugs.map(s => s.toLowerCase()));
    const ordered = CATEGORY_ORDER.filter(slug => slug === 'home' || found.has(slug));
    const categories = ordered.map(slug => ({ name: CATEGORY_NAMES[slug] || slug, slug }));
    res.json({ categories });
  } catch (err) {
    console.error('GET /api/categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/articles?page=1&per_page=10&category=politics ----
app.get('/api/articles', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page) || 10));
    const category = (req.query.category || '').toLowerCase();
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

    // Always scope to latest date only
    const dateKey = await latestDateKey();
    if (!dateKey) {
      return res.json({
        articles: [],
        pagination: {
          page,
          per_page: perPage,
          total: 0,
          has_next: false,
          next_page: null,
          next_cursor: null,
        },
      });
    }

    // Build filter
    const filter = { _dateKey: dateKey, hidden: { $ne: true } };
    if (category && category !== 'home') {
      filter.category = { $regex: new RegExp(`^${category}$`, 'i') };
    }

    const total = await db.collection('articles').countDocuments(filter);

    // Cursor mode: faster and stable. Fallback to page/skip for old clients.
    const query = { ...filter };
    let usedPage = page;
    if (cursor) {
      if (!ObjectId.isValid(cursor)) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
      query._id = { $lt: new ObjectId(cursor) };
      usedPage = 1;
    } else if (page > 1) {
      const skip = (page - 1) * perPage;
      const pivot = await db.collection('articles')
        .find(filter, { projection: { _id: 1 } })
        .sort({ _id: -1 })
        .skip(skip - 1)
        .limit(1)
        .toArray();
      if (pivot.length > 0) {
        query._id = { $lt: pivot[0]._id };
      }
    }

    const rows = await db.collection('articles')
      .find(query)
      .sort({ _id: -1 })
      .limit(perPage + 1)
      .toArray();

    const hasNext = rows.length > perPage;
    const docs = rows.slice(0, perPage);
    const nextCursor = hasNext ? String(docs[docs.length - 1]._id) : null;
    const cleanedDocs = docs.map(({ _id, _dateKey, _createdAt, _updatedAt, ...rest }) => rest);

    res.json({
      articles: cleanedDocs,
      pagination: {
        page: usedPage,
        per_page: perPage,
        total,
        has_next: hasNext,
        next_page: hasNext ? usedPage + 1 : null,
        next_cursor: nextCursor,
      }
    });
  } catch (err) {
    console.error('GET /api/articles error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
//  /api/v2 — the reader surface. Six endpoints, all edition-scoped.
//
//  Cursors only: no page/skip, and no `total` — no screen shows one and it
//  costs a countDocuments per request. `POST /api/articles` keeps its path
//  forever; the v1 GETs above die once the app has moved.
// ============================================================================

// ---- GET /api/v2/editions?cursor=&limit= — the archive index ----
app.get('/api/v2/editions', async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit, 30, 100);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
    if (cursor && !DATE_KEY.test(cursor)) {
      return fail(res, 400, 'invalid_cursor', 'cursor must be YYYY-MM-DD');
    }

    // The archive is sparse — 38 editions across 153 days — so this is a list
    // of the days that exist, newest first, and never a date-range calendar.
    const match = { ...VISIBLE };
    if (cursor) match._dateKey = { $lt: cursor };

    const rows = await editionRows(match, limit + 1);
    const hasNext = rows.length > limit;
    const editions = rows.slice(0, limit);

    // A first page contains the latest edition; a cursor page is all past.
    res.set('Cache-Control', cursor ? 'public, max-age=86400' : 'public, max-age=300');
    res.json({
      editions,
      has_next: hasNext,
      next_cursor: hasNext ? editions[editions.length - 1].date : null,
    });
  } catch (err) {
    console.error('GET /api/v2/editions error:', err);
    fail(res, 500, 'internal', err.message);
  }
});

// ---- GET /api/v2/editions/:date — one edition row; :date may be "latest" ----
app.get('/api/v2/editions/:date', async (req, res) => {
  try {
    const { dateKey, latestKey, invalid } = await resolveEditionDate(req.params.date);
    if (invalid) return fail(res, 400, 'invalid_date', 'date must be YYYY-MM-DD or "latest"');
    // A day that never had an edition is not an empty edition. Nothing links to
    // one except a hand-typed URL or a stale bookmark.
    if (!dateKey) return fail(res, 404, 'not_found', 'no edition for that date');

    const [edition] = await editionRows({ ...VISIBLE, _dateKey: dateKey }, 1);
    if (!edition) return fail(res, 404, 'not_found', 'no edition for that date');

    cacheEdition(res, dateKey, latestKey);
    res.json(edition);
  } catch (err) {
    console.error('GET /api/v2/editions/:date error:', err);
    fail(res, 500, 'internal', err.message);
  }
});

// ---- GET /api/v2/editions/:date/articles?category=&cursor=&limit= ----
app.get('/api/v2/editions/:date/articles', async (req, res) => {
  try {
    const { dateKey, latestKey, invalid, resolvedFromLatest } =
      await resolveEditionDate(req.params.date);
    if (invalid) return fail(res, 400, 'invalid_date', 'date must be YYYY-MM-DD or "latest"');
    if (!dateKey) return fail(res, 404, 'not_found', 'no edition for that date');

    const limit = clampLimit(req.query.limit, 20, 50);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
    if (cursor && !ObjectId.isValid(cursor)) {
      return fail(res, 400, 'invalid_cursor', 'cursor must be an article cursor from a previous page');
    }
    const category = slugifyCategory(req.query.category);

    // `latest` already proved the edition exists; an explicit date has not.
    // Checked separately from the filtered query, or a category with no
    // articles today would 404 an edition that is plainly there.
    if (!resolvedFromLatest) {
      const exists = await db.collection('articles')
        .findOne({ ...VISIBLE, _dateKey: dateKey }, { projection: { _id: 1 } });
      if (!exists) return fail(res, 404, 'not_found', 'no edition for that date');
    }

    const query = { ...VISIBLE, _dateKey: dateKey };
    // `home` is a slug like any other and simply carries no filter.
    if (category && category !== 'home') query.category = category;
    if (cursor) query._id = { $lt: new ObjectId(cursor) };

    // Newest-inserted-first. No importance signal exists in the data, and a
    // re-push's new stories are genuinely the newest.
    const rows = await db.collection('articles')
      .find(query, { projection: { ...FEED_PROJECTION, _id: 1 } })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray();

    const hasNext = rows.length > limit;
    const docs = rows.slice(0, limit);

    cacheEdition(res, dateKey, latestKey);
    res.json({
      articles: docs.map(toFeedItem),
      has_next: hasNext,
      next_cursor: hasNext ? String(docs[docs.length - 1]._id) : null,
    });
  } catch (err) {
    console.error('GET /api/v2/editions/:date/articles error:', err);
    fail(res, 500, 'internal', err.message);
  }
});

// ---- GET /api/v2/articles/:id — the full article ----
app.get('/api/v2/articles/:id', async (req, res) => {
  try {
    // The id is opaque: the archive holds 12-char random ids and everything
    // since holds 16-char ones, so there is no length to check.
    const doc = await db.collection('articles').findOne({ ...VISIBLE, id: String(req.params.id) });
    // Withdrawn, unknown and hidden are one answer. A hidden article is a 404,
    // not a 410 tombstone — a tombstone would confirm the story existed.
    if (!doc) return fail(res, 404, 'not_found', 'no article with that id');

    cacheEdition(res, doc._dateKey, await latestEditionKey());
    res.json(toArticle(doc));
  } catch (err) {
    console.error('GET /api/v2/articles/:id error:', err);
    fail(res, 500, 'internal', err.message);
  }
});

// ---- PATCH /api/v2/articles/:id {hidden} — soft-hide, invoked by raw curl ----
app.patch('/api/v2/articles/:id', requireKey, async (req, res) => {
  try {
    const { hidden } = req.body || {};
    if (typeof hidden !== 'boolean') {
      return fail(res, 400, 'invalid_body', 'hidden must be a boolean');
    }

    // Not VISIBLE: un-hiding has to be able to find a hidden document. There is
    // no list-hidden endpoint — the id comes from shell history or Mongo, which
    // is rare enough not to build a surface for.
    const result = await db.collection('articles').updateOne(
      { id: String(req.params.id) },
      { $set: { hidden, _updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return fail(res, 404, 'not_found', 'no article with that id');

    res.set('Cache-Control', 'no-store');
    res.json({ id: req.params.id, hidden });
  } catch (err) {
    console.error('PATCH /api/v2/articles/:id error:', err);
    fail(res, 500, 'internal', err.message);
  }
});

// ---- POST /api/v2/push/tokens — the push registry ----
//
// Deliberately unauthenticated: see pushTokens.js. The app re-POSTs on every
// launch, so a repeat is the normal case and not an error.
app.post('/api/v2/push/tokens', async (req, res) => {
  try {
    const now = new Date();
    const doc = pushTokenDocument(req.body, now);
    if (!doc) return fail(res, 400, 'invalid_token', 'token must be an ExponentPushToken[...]');

    const { createdAt, ...rest } = doc;
    await db.collection('pushTokens').updateOne(
      { token: doc.token },
      // `createdAt` is set once. A re-registration updates `lastSeen` and the
      // two version axes, and never rewrites the day the device first appeared.
      { $set: rest, $setOnInsert: { createdAt } },
      { upsert: true }
    );

    res.set('Cache-Control', 'no-store');
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/v2/push/tokens error:', err);
    fail(res, 500, 'internal', err.message);
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'fayz-news-backend' });
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
