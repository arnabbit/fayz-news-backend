require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { computeArticleId, qualifyArticleId, normalizeHeadline } = require('./articleId');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'fayznews';

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

function todayStr() {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  }); // e.g. "March 25, 2026"
}

function todayISO() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD for dedup
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
app.post('/api/articles', async (req, res) => {
  try {
    const { articles } = req.body;
    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'articles array required' });
    }

    const date = todayStr();
    const dateKey = todayISO();

    // Append-only: never delete an existing edition. A same-day second push adds
    // to it. Identity is content-derived, so a re-push of the same story (or a
    // retry after a post-write 500) updates in place instead of duplicating.
    const docs = articles.map(a => {
      const sourcePosts = cleanSourcePosts(a.sourcePosts);
      const headline = a.headline || 'Untitled';
      return {
        id: computeArticleId({ headline, sourcePosts }, dateKey),
        headline,
        category: a.category || 'World',
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

    const now = new Date();
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
    const slugs = await db.collection('articles').distinct('category', { _dateKey: dateKey });
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
    const filter = { _dateKey: dateKey };
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

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'fayz-news-backend' });
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
