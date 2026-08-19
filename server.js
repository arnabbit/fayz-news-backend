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
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const CATEGORY_ORDER = [
  'home', 'politics', 'world', 'sports', 'economy',
  'technology', 'entertainment', 'science', 'health', 'legal', 'environment',
];
const CATEGORY_NAMES = {
  home: 'Home', politics: 'Politics', world: 'World', sports: 'Sports',
  economy: 'Economy', technology: 'Technology', entertainment: 'Entertainment',
  science: 'Science', health: 'Health', legal: 'Legal', environment: 'Environment',
};
const PERIOD_TYPES = new Set(['weekly', 'monthly', 'yearly', 'custom']);

let db;

async function connectDB() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('fayznews');

  const articles = db.collection('articles');
  await articles.createIndex({ published_date: -1 });
  await articles.createIndex({ category: 1 });
  await articles.createIndex({ _dateKey: 1, _id: -1 });
  await articles.createIndex({ _dateKey: 1, category: 1, _id: -1 });
  await articles.createIndex({ _dateKey: -1, _id: -1 });
  await articles.createIndex({
    headline: 'text',
    body: 'text',
    category: 'text',
    'developments.summary': 'text',
    'sourcePosts.sourceHeadline': 'text',
  }, { name: 'article_archive_text' });

  const recaps = db.collection('recaps');
  await recaps.createIndex({ period_type: 1, period_start: -1, status: 1 });
  await recaps.createIndex(
    { period_type: 1, period_start: 1, period_end: 1 },
    { unique: true, name: 'recap_period_unique' }
  );

  console.log('Connected to MongoDB');
}

async function latestDateKey() {
  const doc = await db.collection('articles').findOne(
    {},
    { sort: { _dateKey: -1, _createdAt: -1 }, projection: { _dateKey: 1 } }
  );
  return doc ? doc._dateKey : null;
}

function dateFromKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKeyFromDate(date) {
  return date.toISOString().split('T')[0];
}

function formatDateKey(dateKey) {
  const date = dateFromKey(dateKey);
  if (!date) return dateKey;
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function todayStr() {
  return formatDateKey(todayISO());
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && Boolean(dateFromKey(value));
}

function categorySlug(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      : [],
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
    slideCount: Number.isFinite(Number(item?.slideCount)) ? Number(item.slideCount) : 0,
  })).filter(item => item.postUrl || item.sourceHeadline);
}

function publicArticle(doc) {
  const { _id, _createdAt, _updatedAt, ...rest } = doc;
  return {
    ...rest,
    mongo_id: String(_id),
    date_key: rest._dateKey,
  };
}

function publicRecap(doc) {
  if (!doc) return null;
  const { _id, _createdAt, _updatedAt, ...rest } = doc;
  return {
    id: String(_id),
    ...rest,
    created_at: _createdAt,
    updated_at: _updatedAt,
  };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return next();
  const supplied = req.get('x-admin-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (supplied === ADMIN_API_KEY) return next();
  return res.status(401).json({ error: 'Admin API key required' });
}

function normalisePeriodType(value) {
  const periodType = String(value || '').toLowerCase();
  return PERIOD_TYPES.has(periodType) ? periodType : null;
}

function getPeriodBounds(periodType, requestedStart, requestedEnd, anchorDateKey) {
  if (periodType === 'custom') {
    if (!isDateKey(requestedStart) || !isDateKey(requestedEnd) || requestedStart > requestedEnd) {
      return null;
    }
    return { start: requestedStart, end: requestedEnd };
  }

  const anchor = dateFromKey(requestedStart || anchorDateKey || todayISO());
  if (!anchor) return null;

  if (periodType === 'weekly') {
    const start = new Date(anchor);
    const dayOffset = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - dayOffset);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { start: dateKeyFromDate(start), end: dateKeyFromDate(end) };
  }

  if (periodType === 'monthly') {
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
    return { start: dateKeyFromDate(start), end: dateKeyFromDate(end) };
  }

  if (periodType === 'yearly') {
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
    const end = new Date(Date.UTC(anchor.getUTCFullYear(), 11, 31));
    return { start: dateKeyFromDate(start), end: dateKeyFromDate(end) };
  }

  return null;
}

function recapTitle(periodType, start, end) {
  if (periodType === 'weekly') return `Weekly Recap: ${formatDateKey(start)} - ${formatDateKey(end)}`;
  if (periodType === 'monthly') {
    const date = dateFromKey(start);
    return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  }
  if (periodType === 'yearly') return `${start.slice(0, 4)} Yearly Recap`;
  return `Recap: ${formatDateKey(start)} - ${formatDateKey(end)}`;
}

function groupArticlesByCategory(articles) {
  const groups = new Map();
  for (const article of articles) {
    const key = article.category || 'World';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(article);
  }
  return Array.from(groups.entries())
    .map(([category, items]) => ({ category, count: items.length, articles: items }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function buildFallbackRecap(periodType, start, end, articles) {
  const title = recapTitle(periodType, start, end);
  const categoryGroups = groupArticlesByCategory(articles);
  const topStories = articles.slice(0, 8).map(article => ({
    articleId: article.id,
    headline: article.headline,
    category: article.category,
    date_key: article._dateKey,
    published_date: article.published_date,
  }));
  const developingStories = articles
    .filter(article => Array.isArray(article.developments) && article.developments.length > 0)
    .slice(0, 6)
    .map(article => ({
      articleId: article.id,
      headline: article.headline,
      category: article.category,
      date_key: article._dateKey,
      developments: article.developments.slice(0, 3),
    }));
  const categoryHighlights = categoryGroups.slice(0, 8).map(group => ({
    category: group.category,
    count: group.count,
    highlights: group.articles.slice(0, 4).map(article => ({
      articleId: article.id,
      headline: article.headline,
      date_key: article._dateKey,
    })),
  }));
  const dateCounts = new Map();
  for (const article of articles) {
    dateCounts.set(article._dateKey, (dateCounts.get(article._dateKey) || 0) + 1);
  }
  const timeline = Array.from(dateCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date_key, count]) => ({ date_key, published_date: formatDateKey(date_key), count }));

  const summaryParts = [
    `${articles.length} stories were published from ${formatDateKey(start)} to ${formatDateKey(end)}.`,
    categoryGroups.length > 0
      ? `${categoryGroups[0].category} led coverage with ${categoryGroups[0].count} stories.`
      : '',
    topStories.length > 0 ? `The lead story was "${topStories[0].headline}".` : '',
  ].filter(Boolean);

  return {
    title,
    summary: summaryParts.join(' '),
    sections: [
      { title: 'Top stories', body: topStories.slice(0, 5).map(story => story.headline) },
      {
        title: 'Category highlights',
        body: categoryHighlights.map(group => `${group.category}: ${group.highlights.map(item => item.headline).join('; ')}`),
      },
      {
        title: 'Developing stories',
        body: developingStories.length
          ? developingStories.map(story => `${story.headline}: ${story.developments.map(item => item.summary).join(' ')}`)
          : ['No multi-post developments were captured for this period.'],
      },
    ],
    categoryHighlights,
    topStories,
    developingStories,
    timeline,
    stats: {
      article_count: articles.length,
      category_count: categoryGroups.length,
      source_post_count: articles.reduce((total, article) => total + (article.sourcePosts?.length || 0), 0),
    },
    generator: OPENAI_API_KEY ? 'fallback' : 'deterministic',
  };
}

function buildRecapPrompt(periodType, start, end, articles) {
  const compactArticles = articles.slice(0, 80).map(article => ({
    id: article.id,
    date: article._dateKey,
    category: article.category,
    headline: article.headline,
    body: Array.isArray(article.body) ? article.body.join('\n').slice(0, 1200) : '',
    developments: (article.developments || []).map(item => item.summary).slice(0, 4),
  }));

  return [
    {
      role: 'system',
      content: 'You write concise, factual news recaps. Use only the supplied articles. Return JSON only.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: `Create a ${periodType} recap for ${start} through ${end}.`,
        requiredShape: {
          summary: '2-4 sentences',
          sections: [{ title: 'string', body: ['short bullet strings'] }],
        },
        articles: compactArticles,
      }),
    },
  ];
}

async function buildAiRecap(periodType, start, end, articles) {
  if (!OPENAI_API_KEY || typeof fetch !== 'function') return null;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: buildRecapPrompt(periodType, start, end, articles),
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI recap generation failed: ${response.status}`);
  }

  const data = await response.json();
  const outputText = data.output_text || data.output?.flatMap(item => item.content || [])
    .map(item => item.text || '')
    .join('\n');
  if (!outputText) return null;

  const parsed = JSON.parse(outputText.replace(/^```json\s*|\s*```$/g, ''));
  return {
    title: recapTitle(periodType, start, end),
    summary: String(parsed.summary || '').trim(),
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    generator: 'openai',
  };
}

async function generateRecapDoc(periodType, start, end) {
  const articles = await db.collection('articles')
    .find({ _dateKey: { $gte: start, $lte: end } })
    .sort({ _dateKey: -1, _id: -1 })
    .toArray();

  if (articles.length === 0) {
    const error = new Error('No articles found for this period');
    error.statusCode = 404;
    throw error;
  }

  const fallback = buildFallbackRecap(periodType, start, end, articles);
  let aiContent = null;
  let generationError = null;

  try {
    aiContent = await buildAiRecap(periodType, start, end, articles);
  } catch (err) {
    generationError = err.message;
  }

  const content = aiContent || fallback;
  return {
    period_type: periodType,
    period_start: start,
    period_end: end,
    title: content.title || fallback.title,
    summary: content.summary || fallback.summary,
    sections: content.sections?.length ? content.sections : fallback.sections,
    categoryHighlights: fallback.categoryHighlights,
    topStories: fallback.topStories,
    developingStories: fallback.developingStories,
    timeline: fallback.timeline,
    stats: fallback.stats,
    sourceArticleIds: articles.map(article => article.id),
    status: 'published',
    generator: content.generator,
    generation_error: generationError,
    _createdAt: new Date(),
    _updatedAt: new Date(),
    _publishedAt: new Date(),
  };
}

app.post('/api/articles', async (req, res) => {
  try {
    const { articles } = req.body;
    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'articles array required' });
    }

    const date = todayStr();
    const dateKey = todayISO();
    await db.collection('articles').deleteMany({ _dateKey: dateKey });

    const docs = articles.map(a => ({
      id: crypto.randomBytes(6).toString('hex'),
      headline: a.headline || 'Untitled',
      published_date: date,
      category: a.category || 'World',
      body: Array.isArray(a.body) ? a.body : [String(a.body || '')],
      developments: cleanDevelopments(a.developments),
      sourcePosts: cleanSourcePosts(a.sourcePosts),
      _dateKey: dateKey,
      _createdAt: new Date(),
    }));

    await db.collection('articles').insertMany(docs);
    res.json({ ok: true, date, date_key: dateKey, count: docs.length });
  } catch (err) {
    console.error('POST /api/articles error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const requestedDate = req.query.date;
    const dateKey = isDateKey(requestedDate) ? requestedDate : await latestDateKey();
    if (!dateKey) return res.json({ categories: [] });

    const slugs = await db.collection('articles').distinct('category', { _dateKey: dateKey });
    const found = new Set(slugs.map(categorySlug));
    const ordered = CATEGORY_ORDER.filter(slug => slug === 'home' || found.has(slug));
    const extra = Array.from(found).filter(slug => !CATEGORY_ORDER.includes(slug)).sort();
    const categories = [...ordered, ...extra].map(slug => ({
      name: CATEGORY_NAMES[slug] || slug.replace(/\b\w/g, char => char.toUpperCase()),
      slug,
    }));

    res.json({ categories, date_key: dateKey });
  } catch (err) {
    console.error('GET /api/categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dates', async (req, res) => {
  try {
    const limit = Math.min(366, Math.max(1, parseInt(req.query.limit) || 60));
    const rows = await db.collection('articles').aggregate([
      {
        $group: {
          _id: '$_dateKey',
          published_date: { $first: '$published_date' },
          article_count: { $sum: 1 },
          categories: { $addToSet: '$category' },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: limit },
    ]).toArray();

    res.json({
      dates: rows.map(row => ({
        date_key: row._id,
        published_date: row.published_date || formatDateKey(row._id),
        article_count: row.article_count,
        categories: (row.categories || []).sort(),
      })),
    });
  } catch (err) {
    console.error('GET /api/dates error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/articles', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page) || 10));
    const category = categorySlug(req.query.category);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const requestedDate = req.query.date;
    const dateKey = isDateKey(requestedDate) ? requestedDate : await latestDateKey();

    if (!dateKey) {
      return res.json({
        articles: [],
        date_key: null,
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

    const filter = { _dateKey: dateKey };
    if (category && category !== 'home') {
      filter.category = { $regex: new RegExp(`^${escapeRegex(category)}$`, 'i') };
    }

    const total = await db.collection('articles').countDocuments(filter);
    const query = { ...filter };
    let usedPage = page;

    if (cursor) {
      if (!ObjectId.isValid(cursor)) return res.status(400).json({ error: 'Invalid cursor' });
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
      if (pivot.length > 0) query._id = { $lt: pivot[0]._id };
    }

    const rows = await db.collection('articles')
      .find(query)
      .sort({ _id: -1 })
      .limit(perPage + 1)
      .toArray();

    const hasNext = rows.length > perPage;
    const docs = rows.slice(0, perPage);
    const nextCursor = hasNext ? String(docs[docs.length - 1]._id) : null;

    res.json({
      articles: docs.map(publicArticle),
      date_key: dateKey,
      pagination: {
        page: usedPage,
        per_page: perPage,
        total,
        has_next: hasNext,
        next_page: hasNext ? usedPage + 1 : null,
        next_cursor: nextCursor,
      },
    });
  } catch (err) {
    console.error('GET /api/articles error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/articles/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const category = categorySlug(req.query.category);
    const startDate = isDateKey(req.query.start_date) ? req.query.start_date : null;
    const endDate = isDateKey(req.query.end_date) ? req.query.end_date : null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page) || 10));
    const filter = {};

    if (startDate || endDate) {
      filter._dateKey = {};
      if (startDate) filter._dateKey.$gte = startDate;
      if (endDate) filter._dateKey.$lte = endDate;
    }
    if (category && category !== 'home') {
      filter.category = { $regex: new RegExp(`^${escapeRegex(category)}$`, 'i') };
    }
    if (q) filter.$text = { $search: q };

    const total = await db.collection('articles').countDocuments(filter);
    const sort = q ? { score: { $meta: 'textScore' }, _dateKey: -1, _id: -1 } : { _dateKey: -1, _id: -1 };
    const rows = await db.collection('articles')
      .find(filter)
      .sort(sort)
      .skip((page - 1) * perPage)
      .limit(perPage)
      .toArray();

    res.json({
      articles: rows.map(publicArticle),
      pagination: {
        page,
        per_page: perPage,
        total,
        has_next: page * perPage < total,
        next_page: page * perPage < total ? page + 1 : null,
      },
    });
  } catch (err) {
    console.error('GET /api/articles/search error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/periods/latest', async (req, res) => {
  try {
    const [daily, weekly, monthly, yearly] = await Promise.all([
      latestDateKey(),
      db.collection('recaps').findOne({ period_type: 'weekly', status: 'published' }, { sort: { period_start: -1 } }),
      db.collection('recaps').findOne({ period_type: 'monthly', status: 'published' }, { sort: { period_start: -1 } }),
      db.collection('recaps').findOne({ period_type: 'yearly', status: 'published' }, { sort: { period_start: -1 } }),
    ]);

    res.json({
      daily: daily ? { date_key: daily, published_date: formatDateKey(daily) } : null,
      weekly: publicRecap(weekly),
      monthly: publicRecap(monthly),
      yearly: publicRecap(yearly),
    });
  } catch (err) {
    console.error('GET /api/periods/latest error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recaps', async (req, res) => {
  try {
    const periodType = normalisePeriodType(req.query.period_type);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const filter = { status: 'published' };
    if (periodType) filter.period_type = periodType;

    const rows = await db.collection('recaps')
      .find(filter)
      .sort({ period_start: -1 })
      .limit(limit)
      .toArray();

    res.json({ recaps: rows.map(publicRecap) });
  } catch (err) {
    console.error('GET /api/recaps error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recaps/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid recap id' });
    const recap = await db.collection('recaps').findOne({ _id: new ObjectId(req.params.id), status: 'published' });
    if (!recap) return res.status(404).json({ error: 'Recap not found' });
    res.json({ recap: publicRecap(recap) });
  } catch (err) {
    console.error('GET /api/recaps/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/recaps/generate', requireAdmin, async (req, res) => {
  try {
    const periodType = normalisePeriodType(req.body.period_type);
    if (!periodType) {
      return res.status(400).json({ error: 'period_type must be weekly, monthly, yearly, or custom' });
    }

    const anchor = await latestDateKey();
    const bounds = getPeriodBounds(periodType, req.body.period_start, req.body.period_end, anchor);
    if (!bounds) return res.status(400).json({ error: 'Invalid period_start or period_end' });

    const recapDoc = await generateRecapDoc(periodType, bounds.start, bounds.end);
    await db.collection('recaps').updateOne(
      { period_type: periodType, period_start: bounds.start, period_end: bounds.end },
      {
        $set: { ...recapDoc, _updatedAt: new Date(), _publishedAt: new Date() },
        $setOnInsert: { _createdAt: new Date() },
      },
      { upsert: true }
    );

    const saved = await db.collection('recaps').findOne({
      period_type: periodType,
      period_start: bounds.start,
      period_end: bounds.end,
    });

    res.json({ ok: true, recap: publicRecap(saved) });
  } catch (err) {
    console.error('POST /api/recaps/generate error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/recaps/:id/publish', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid recap id' });

    const result = await db.collection('recaps').findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: 'published', _publishedAt: new Date(), _updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Recap not found' });

    res.json({ ok: true, recap: publicRecap(result) });
  } catch (err) {
    console.error('POST /api/recaps/:id/publish error:', err);
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
