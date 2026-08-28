// What counts as a searchable query, kept pure.
//
// **Validation, not throttling.** A `$text` query against a ~700 KB in-memory
// index is microseconds, so there is no expensive query here to defend against
// and no rate limiter is added. The bounds exist because a one-character query
// matches nothing useful and a 100+ character one is a paste, not a search.

const MIN_QUERY = 2;
const MAX_QUERY = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Returns the cleaned query, or null when there is nothing worth asking Mongo.
// Collapsing internal whitespace matters: the bounds are on what gets searched,
// not on what got typed.
function searchQuery(raw) {
  if (typeof raw !== 'string') return null;
  const q = raw.trim().replace(/\s+/g, ' ');
  if (q.length < MIN_QUERY || q.length > MAX_QUERY) return null;
  return q;
}

function searchLimit(raw) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

module.exports = {
  MIN_QUERY,
  MAX_QUERY,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  searchQuery,
  searchLimit,
};
