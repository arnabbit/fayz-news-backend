require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

const CATEGORIES = [
  { name: 'Home', slug: 'home' },
  { name: 'Politics', slug: 'politics' },
  { name: 'World', slug: 'world' },
  { name: 'Sports', slug: 'sports' },
  { name: 'Economy', slug: 'economy' },
  { name: 'Technology', slug: 'technology' },
  { name: 'Entertainment', slug: 'entertainment' },
  { name: 'Science', slug: 'science' },
  { name: 'Health', slug: 'health' },
  { name: 'Legal', slug: 'legal' },
  { name: 'Environment', slug: 'environment' },
];

let db;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('fayznews');
  // Index for fast queries
  await db.collection('articles').createIndex({ published_date: -1 });
  await db.collection('articles').createIndex({ category: 1 });
  console.log('Connected to MongoDB');
}

function todayStr() {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  }); // e.g. "March 25, 2026"
}

function todayISO() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD for dedup
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

// ---- GET /api/categories ----
app.get('/api/categories', (req, res) => {
  res.json({ categories: CATEGORIES });
});

// ---- GET /api/articles?page=1&per_page=10&category=politics ----
app.get('/api/articles', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page) || 10));
    const category = (req.query.category || '').toLowerCase();

    // Build filter
    const filter = {};
    if (category && category !== 'home') {
      // Match category case-insensitively
      filter.category = { $regex: new RegExp(`^${category}$`, 'i') };
    }

    const total = await db.collection('articles').countDocuments(filter);
    const skip = (page - 1) * perPage;

    const docs = await db.collection('articles')
      .find(filter, { projection: { _id: 0, _dateKey: 0, _createdAt: 0 } })
      .sort({ _createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .toArray();

    const hasNext = skip + perPage < total;

    res.json({
      articles: docs,
      pagination: {
        page,
        per_page: perPage,
        total,
        has_next: hasNext,
        next_page: hasNext ? page + 1 : null
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
