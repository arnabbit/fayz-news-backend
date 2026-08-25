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
//   primary:  sha256(sorted, unique, canonical sourcePosts[].postUrl keys)
//   fallback: sha256(normalizedHeadline + '|' + dateKey)   when no source posts
function computeArticleId(article, dateKey) {
  const keys = Array.isArray(article && article.sourcePosts)
    ? article.sourcePosts.map(p => canonicalPostKey(p && p.postUrl)).filter(Boolean)
    : [];

  if (keys.length > 0) {
    const unique = Array.from(new Set(keys)).sort();
    return sha16(unique.join('\n'));
  }

  return sha16(`${normalizeHeadline(article && article.headline)}|${String(dateKey || '')}`);
}

module.exports = {
  normalizeInstagramUrl,
  getInstagramPostKey,
  canonicalPostKey,
  normalizeHeadline,
  computeArticleId,
};
