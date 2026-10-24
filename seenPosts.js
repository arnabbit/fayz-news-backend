// Which upstream posts the paper already holds, kept pure.
//
// Derived from `articles.sourcePosts`, never stored on its own: a post is seen
// once some article cites it. Stored URLs are not normalised — the extension
// files `/p/X/`, `/reel/X/` and `/user/p/X/` alike — so the answer is the
// shortcode alone. Instagram serves one post under `/p/` and `/reel/` with the
// same shortcode, so the type is not part of the identity.

const POST_TYPES = ['p', 'reel', 'tv'];

// Returns the shortcode, or null when the URL does not name one post.
function postShortcode(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parts;
  try {
    parts = new URL(raw.trim(), 'https://www.instagram.com').pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  const typeIndex = parts.findIndex(part => POST_TYPES.includes(part));
  if (typeIndex === -1) return null;
  return parts[typeIndex + 1] || null;
}

// Distinct shortcodes, sorted so the same archive always gives the same answer.
function seenShortcodes(urls) {
  const codes = new Set();
  for (const url of Array.isArray(urls) ? urls : []) {
    const code = postShortcode(url);
    if (code) codes.add(code);
  }
  return [...codes].sort();
}

module.exports = { postShortcode, seenShortcodes };
