const crypto = require('crypto');

// Mirrors normalizeInstagramUrl() in the extension's background.js:
// strip query string and fragment, keep everything else.
function normalizeInstagramUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

// Mirrors getInstagramPostKey() in the extension's background.js:
// "p:SHORTCODE" / "reel:SHORTCODE" / "tv:SHORTCODE", or '' when not a post url.
function getInstagramPostKey(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const typeIndex = parts.findIndex(part => ['p', 'reel', 'tv'].includes(part));
    if (typeIndex === -1 || !parts[typeIndex + 1]) return '';
    return `${parts[typeIndex]}:${parts[typeIndex + 1]}`;
  } catch {
    return '';
  }
}

// Canonical identity of one source post. Prefer the extension's post key (the
// same value seenPosts is keyed on); fall back to the normalized url, then raw.
// Mirrors filterUnseenPostLinks(), which also falls back to the url itself.
function canonicalPostKey(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return '';
  return getInstagramPostKey(raw) || normalizeInstagramUrl(raw) || raw;
}

function normalizeHeadline(headline) {
  return String(headline == null ? '' : headline)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function sha16(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

// Content-derived, stable article id.
//   primary:  sha256(sorted unique canonical post keys + '|' + dateKey)
//   fallback: sha256(normalizedHeadline + '|' + dateKey)   when no source posts
//
// dateKey is part of the key because the same post is re-summarised on later
// days: without it, day 2's version of a story overwrites day 1's and vanishes
// from the edition readers are served.
function computeArticleId(article, dateKey) {
  const keys = Array.isArray(article && article.sourcePosts)
    ? article.sourcePosts.map(p => canonicalPostKey(p && p.postUrl)).filter(Boolean)
    : [];

  const day = String(dateKey || '');
  if (keys.length > 0) {
    const unique = Array.from(new Set(keys)).sort();
    return sha16(`${unique.join('\n')}|${day}`);
  }

  return sha16(`${normalizeHeadline(article && article.headline)}|${day}`);
}

// A single roundup reel routinely yields several unrelated stories on the same
// day, so one post set is not one story. When two distinct stories land on the
// same base id, every one after the first is qualified by its headline instead
// of silently overwriting. Deterministic, so a retried payload re-derives the
// identical ids.
function qualifyArticleId(baseId, headline) {
  return sha16(`${baseId}|${normalizeHeadline(headline)}`);
}

module.exports = {
  normalizeInstagramUrl,
  getInstagramPostKey,
  canonicalPostKey,
  normalizeHeadline,
  computeArticleId,
  qualifyArticleId,
};
