require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

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
  db = client.db('fayznews');
  // Index for fast queries
  await db.collection('articles').createIndex({ published_date: -1 });
  await db.collection('articles').createIndex({ category: 1 });
  await db.collection('articles').createIndex({ _dateKey: 1, _id: -1 });
  await db.collection('articles').createIndex({ _dateKey: 1, category: 1, _id: -1 });
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
    sourcePostUrls: cleanStringArray(item?.sourcePostUrls),
    sourcePostNumbers: Array.isArray(item?.sourcePostNumbers)
      ? item.sourcePostNumbers.map(Number).filter(Number.isFinite)
      : []
  })).filter(item => item.summary);
}

function cleanSourcePosts(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    postUrl: String(item?.postUrl || '').trim(),
    postNumber: Number.isFinite(Number(item?.postNumber)) ? Number(item.postNumber) : null,
    feedOrder: Number.isFinite(Number(item?.feedOrder)) ? Number(item.feedOrder) : null,
    feedOrderMeaning: String(item?.feedOrderMeaning || '').trim(),
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

    // Remove today's existing articles (upsert behavior)
    await db.collection('articles').deleteMany({ _dateKey: dateKey });

    // Insert all articles with generated IDs
    const docs = articles.map(a => ({
      id: crypto.randomBytes(6).toString('hex'),
      headline: a.headline || 'Untitled',
      published_date: date,
      category: a.category || 'World',
      body: Array.isArray(a.body) ? a.body : [String(a.body || '')],
      developments: cleanDevelopments(a.developments),
      sourcePosts: cleanSourcePosts(a.sourcePosts),
      _dateKey: dateKey,
      _createdAt: new Date()
    }));

    await db.collection('articles').insertMany(docs);

    res.json({ ok: true, date, count: docs.length });
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
    const cleanedDocs = docs.map(({ _id, _dateKey, _createdAt, ...rest }) => rest);

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
