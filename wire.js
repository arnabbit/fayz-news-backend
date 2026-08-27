// The wire projections. Two shapes, not one with a `?fields=` switch — a field
// switch would leave the app's cache ambiguous about what an entry holds, which
// is the reason it was rejected.
//
// The wire carries only what a screen renders. Mongo keeps the full record
// (`postNumber`, `mediaTypes`, `captureMethods`, `slideCount`, `sourcePostUrls`)
// for audit; re-adding one of them here is a one-line change.

const { dekFor } = require('./dek');
const { slugifyCategory } = require('./categories');

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

module.exports = { toFeedItem, toArticle, FEED_PROJECTION };
