// The written retrospective a closed period gets, and the rules around it.
// Pure: the prompt, the model default and the validator. The call itself lives
// in server.js, because it is the only part that needs the network.
//
// The provider convention is not invented here. It is the one already running
// in the instagram-news-summarizer extension — OpenRouter's chat completions
// endpoint, Bearer auth, key and model both from configuration — reused rather
// than given a second shape for one system.

// Used when OPENROUTER_MODEL is unset or blank, and seeded to the same model
// the extension currently defaults to.
const DEFAULT_MODEL = 'google/gemini-3.1-flash-lite-preview';

// Generous. A year is roughly 1068 headlines in and three or four paragraphs
// out, and being truncated mid-sentence is worse than being slow.
const TEMPERATURE = 0.25;
const MAX_TOKENS = 8192;

// Long enough for a year's worth of headlines through a slow model, short
// enough that a hung request cannot hold a reader's period view open for ever.
const REQUEST_TIMEOUT_MS = 90000;

// A category needs enough in it to be worth its own paragraph. Below this it is
// folded into the trailing line instead, which is what `also` is for.
const MIN_CATEGORY_ARTICLES = 3;

function resolveModel(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value || DEFAULT_MODEL;
}

// Headlines only, never bodies — 78 of them for a week, roughly 1068 for a
// year. Grouped by category and ordered by count, because the order the model
// is shown is the order it is asked to keep.
function buildPrompt(period, categories, headlinesBySlug) {
  const paragraphed = categories.filter(c => c.count >= MIN_CATEGORY_ARTICLES);
  const folded = categories.filter(c => c.count < MIN_CATEGORY_ARTICLES);

  const sections = paragraphed.map(c => {
    const lines = (headlinesBySlug[c.slug] || []).map(h => `- ${h}`).join('\n');
    return `## ${c.name} (${c.slug}) — ${c.count} article${c.count === 1 ? '' : 's'}\n${lines}`;
  }).join('\n\n');

  const foldedNote = folded.length
    ? `\n\nCategories with only one or two articles, for the trailing line:\n${
      folded.map(c => `- ${c.name}: ${(headlinesBySlug[c.slug] || []).join('; ')}`).join('\n')}`
    : '';

  return [
    'You are writing the retrospective for one period of a daily newspaper archive.',
    `The period is ${period.id} (${period.kind}), covering ${period.range.from} to ${period.range.to}.`,
    'You are given every headline published in it, grouped by category. You have only the headlines — do not invent detail that is not in them, and do not claim outcomes they do not state.',
    '',
    'Reply with JSON only, no prose around it, in exactly this shape:',
    '{"lede": string, "byCategory": [{"slug": string, "name": string, "text": string}], "also": string | null}',
    '',
    '- lede: two or three sentences on the period as a whole.',
    '- byCategory: one short paragraph per category listed below under a "##" heading, keeping them in the order given. Use the slug and name exactly as given.',
    '- also: one trailing sentence folding in the categories with only one or two articles, or null if there are none.',
    '',
    'Write in plain past-tense newspaper English. No headings, no bullet points, no markdown inside the strings.',
    '',
    sections + foldedNote,
  ].join('\n');
}

// The model returns text; this is where it stops being trusted. Anything that
// does not fit the shape is dropped rather than stored — the app parses
// defensively too, but a malformed generation should never reach the collection
// in the first place.
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

const clean = value => (typeof value === 'string' ? value.trim() : '');

// Validates and, where it can, corrects. Two things are enforced rather than
// hoped for:
//
//  1. Every returned category must be one this period actually has. A model
//     that invents a category would otherwise put a paragraph on the screen
//     about articles that do not exist.
//  2. `byCategory` is re-ordered by article count here, at generation time.
//     **The wire order is the ranking** — the app never re-sorts it, because a
//     period view deliberately has no headline list: the data cannot supply a
//     ranking and the sentences can. So the ordering has to be right when it is
//     stored, not when it is read.
function validateProse(raw, categories) {
  if (typeof raw !== 'object' || raw === null) return null;

  const known = new Map(categories.map(c => [c.slug, c]));
  const seen = new Set();
  const byCategory = (Array.isArray(raw.byCategory) ? raw.byCategory : [])
    .map(entry => {
      if (typeof entry !== 'object' || entry === null) return null;
      const slug = clean(entry.slug);
      const text = clean(entry.text);
      const known_ = known.get(slug);
      if (!known_ || !text || seen.has(slug)) return null;
      seen.add(slug);
      // The name is stored alongside, so a frozen summary keeps the label it
      // was written under even if the category is renamed later.
      return { slug, name: clean(entry.name) || known_.name, text, count: known_.count };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug))
    .map(({ slug, name, text }) => ({ slug, name, text }));

  const lede = clean(raw.lede);
  const also = clean(raw.also);

  // Nothing renderable is not a summary. Storing one would turn "not written
  // yet" into "written, and empty", which the screen has no way to recover from.
  if (!lede && !also && byCategory.length === 0) return null;

  return { lede, byCategory, also: also || null };
}

module.exports = {
  DEFAULT_MODEL,
  TEMPERATURE,
  MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  MIN_CATEGORY_ARTICLES,
  resolveModel,
  buildPrompt,
  parseModelReply,
  validateProse,
};
