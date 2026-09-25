// What every model call here shares: which model, how it is called, and
// turning the text it returns into a value, or into nothing. Pure. The call
// itself lives in server.js, because it is the only part that needs the
// network.
//
// The provider convention is not invented here. It is the one already running
// in the instagram-news-summarizer extension — OpenRouter's chat completions
// endpoint, Bearer auth, key and model both from configuration — reused rather
// than given a second shape for one system.

// Used when OPENROUTER_MODEL is unset or blank, and seeded to the same model
// the extension currently defaults to.
const DEFAULT_MODEL = 'google/gemini-3.1-flash-lite-preview';

// Generous. A year's evidence is large, and being truncated mid-sentence is
// worse than being slow.
const TEMPERATURE = 0.25;
const MAX_TOKENS = 8192;

// Long enough for a large prompt through a slow model, short enough that a
// hung request cannot hold the story queue for ever.
const REQUEST_TIMEOUT_MS = 90000;

function resolveModel(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value || DEFAULT_MODEL;
}

// The model returns text; this is where it stops being trusted. Anything that
// does not parse is null rather than an exception, so each caller decides what
// "the model said nothing usable" means for it.
function parseModelReply(reply) {
  if (typeof reply !== 'string' || !reply.trim()) return null;
  // Models fence JSON more often than not, whatever the instruction said.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const body = fenced ? fenced[1] : reply;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_MODEL,
  TEMPERATURE,
  MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  resolveModel,
  parseModelReply,
};
