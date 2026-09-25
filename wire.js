// The wire projections. Two shapes, not one with a `?fields=` switch — a field
// switch would leave the app's cache ambiguous about what an entry holds, which
// is the reason it was rejected.
//
// The wire carries only what a screen renders. Mongo keeps the full record
// (`postNumber`, `mediaTypes`, `captureMethods`, `slideCount`, `sourcePostUrls`)
// for audit; re-adding one of them here is a one-line change.

const { dekFor } = require('./dek');
const { slugifyCategory, categoryName } = require('./categories');
const { daysBetween } = require('./period');
const { list } = require('./values');

// `edition` (YYYY-MM-DD, IST) is the only date on the wire. `published_date` is
// gone: the label is presentation, and the client formats it.
function toFeedItem(doc) {
  return {
    id: doc.id,
    headline: doc.headline,
    category: slugifyCategory(doc.category),
    dek: dekFor(doc),
    edition: doc._dateKey,
    developmentCount: Array.isArray(doc.developments) ? doc.developments.length : 0,
    sourceCount: Array.isArray(doc.sourcePosts) ? doc.sourcePosts.length : 0,
  };
}

function toArticle(doc) {
  return {
    ...toFeedItem(doc),
    body: Array.isArray(doc.body) ? doc.body : [],
    developments: (Array.isArray(doc.developments) ? doc.developments : [])
      .map(d => ({ summary: String((d && d.summary) || '') }))
      .filter(d => d.summary),
    sourcePosts: (Array.isArray(doc.sourcePosts) ? doc.sourcePosts : [])
      .map(p => ({
        postUrl: String((p && p.postUrl) || ''),
        sourceHeadline: String((p && p.sourceHeadline) || ''),
      }))
      .filter(p => p.postUrl || p.sourceHeadline),
  };
}

// Feed-item projection. `body` is read but not returned — the dek fallback
// needs paragraph one, and only paragraph one, so it is sliced at the database
// rather than pulled whole for an 85-article edition.
const FEED_PROJECTION = {
  id: 1, headline: 1, category: 1, dek: 1, _dateKey: 1,
  body: { $slice: 1 },
  'developments.summary': 1,
  'sourcePosts.postUrl': 1,
};

// ---- the period ----

// Every article id the stored story cites, once. The route asks Mongo which
// of these are still visible.
function storyArticleIds(story) {
  const ids = new Set();
  for (const section of list(story && story.sections)) {
    for (const entry of list(section && section.entries)) {
      for (const id of list(entry && entry.articleIds)) ids.add(id);
    }
  }
  return [...ids];
}

// The stored story as the app reads it. Sections and entries keep their
// stored order. `why`, `verification`, `basis`, `writtenAt` and `model` stay
// in Mongo for audit. An id not in `visibleIds` (hidden, or gone) is dropped;
// the entry stays, because its text was written and frozen and the ids only
// link out.
function toStory(story, visibleIds) {
  return {
    sections: list(story && story.sections).map(section => ({
      date: section.date,
      entries: list(section.entries).map(e => ({
        threadId: e.threadId,
        kind: e.kind,
        headline: e.headline,
        paragraphs: list(e.paragraphs),
        articleIds: list(e.articleIds).filter(id => visibleIds.has(id)),
        continuesFrom: e.continuesFrom || null,
      })),
    })),
  };
}

// GET /api/v2/periods/:id. `facets` is the aggregate over the period's
// visible articles: `{ byDay: [{ _id: date, count }], byCategory: [{ _id: slug, count }] }`.
function toPeriod({ period, facets, story, visibleIds, storyStatus }) {
  const byDay = new Map(list(facets && facets.byDay).map(row => [row._id, row.count]));
  const articleCount = [...byDay.values()].reduce((sum, n) => sum + n, 0);

  // One entry per day in the range, including the days with nothing — so the
  // timeline draws a day with no edition as a tick rather than as a gap.
  const timeline = daysBetween(period.range).map(date => ({
    date,
    count: byDay.get(date) || 0,
  }));

  const categories = list(facets && facets.byCategory)
    .map(row => ({ slug: row._id, name: categoryName(row._id), count: row.count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

  return {
    id: period.id,
    kind: period.kind,
    range: period.range,
    editionCount: byDay.size,
    articleCount,
    categories,
    timeline,
    story: toStory(story, visibleIds),
    storyStatus,
  };
}

module.exports = { toFeedItem, toArticle, FEED_PROJECTION, toPeriod, toStory, storyArticleIds };
