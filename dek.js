// The dek fallback, and it is permanent infrastructure rather than scaffolding.
//
// The extension's merge pass writes a purpose-built dek, but none of the 1068
// archived articles has one and they will never be re-pushed (`seenPosts` is
// permanent). So the server computes a fallback for them — **per request, never
// written back**: a stored synthesised dek is indistinguishable from an
// authored one, and persisting it would destroy the option of backfilling
// properly later.
//
// It lives on the server, and only on the server, so the client cannot end up
// with two truncation implementations that disagree.

// Hard cap on any dek, authored or synthesised (the extension's LLM targets
// ~180). The sentence search is bounded by the same cap: a boundary found past
// it is not usable, so widening the search window past 240 buys nothing.
const DEK_CAP = 240;
const SENTENCE_WINDOW = 300;

function dekFallback(body) {
  const first = String((Array.isArray(body) ? body[0] : body) || '').trim();
  if (first.length <= DEK_CAP) return first;

  const window = first.slice(0, SENTENCE_WINDOW);
  let lastSentenceEnd = -1;
  for (let i = 0; i < window.length && i < DEK_CAP; i++) {
    if ('.!?'.includes(window[i]) && (i + 1 >= window.length || window[i + 1] === ' ')) {
      lastSentenceEnd = i;
    }
  }
  if (lastSentenceEnd > 0) return first.slice(0, lastSentenceEnd + 1);

  const clipped = first.slice(0, DEK_CAP);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

// `dek` is never null on the wire: the stored value when there is one, the
// fallback otherwise.
function dekFor(doc) {
  const stored = String((doc && doc.dek) || '').trim();
  if (stored) return stored.length > DEK_CAP ? dekFallback([stored]) : stored;
  return dekFallback(doc && doc.body);
}

module.exports = { DEK_CAP, dekFallback, dekFor };
