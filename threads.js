// Threads: one running story across editions. Every article belongs to exactly
// one. Pure: the prompt, the reply parser and the validator. The model call
// lives in server.js and the storage in threadGrouping.js.
//
// Grouping decides sameness only, never importance. It is global, so every
// period agrees on what one story is.

const crypto = require('crypto');
const { parseModelReply } = require('./model');
const { addDays } = require('./period');
const { clean } = require('./values');

// How far back an edition looks for a thread to join.
const THREAD_WINDOW_DAYS = 60;
// How many of a candidate thread's headlines the model is shown.
const RECENT_HEADLINES = 3;
// A thread title is a label, not a paragraph.
const TITLE_CAP = 120;
// Where an article with no category is filed. The same default the write
// path uses.
const FALLBACK_CATEGORY = 'world';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 12;

// The backend mints every thread id. The model never does: an id it made up
// would be indistinguishable from a real one it misremembered.
function mintThreadId() {
  const bytes = crypto.randomBytes(ID_LENGTH);
  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

// The oldest lastDate a thread can have and still be a candidate.
const threadWindowStart = dateKey => addDays(dateKey, -THREAD_WINDOW_DAYS);

// Rows are `{ _threadId, headline, _dateKey }`, in any order. Returns a Map of
// threadId to its newest headlines, newest first.
function recentHeadlines(rows) {
  const sorted = [...rows].sort((a, b) => String(b._dateKey).localeCompare(String(a._dateKey)));
  const out = new Map();
  for (const row of sorted) {
    const list = out.get(row._threadId) || [];
    if (list.length < RECENT_HEADLINES) list.push(row.headline);
    out.set(row._threadId, list);
  }
  return out;
}

function describeArticle(article) {
  const lines = [`- articleId: ${article.id}`, `  headline: ${clean(article.headline)}`];
  if (clean(article.dek)) lines.push(`  dek: ${clean(article.dek)}`);
  lines.push(`  category: ${clean(article.category) || FALLBACK_CATEGORY}`);
  const developments = (Array.isArray(article.developments) ? article.developments : [])
    .map(d => clean(d && d.summary))
    .filter(Boolean);
  if (developments.length) {
    lines.push('  developments:', ...developments.map(s => `    - ${s}`));
  }
  return lines.join('\n');
}

function describeThread(thread) {
  const lines = [
    `- threadId: ${thread.threadId}`,
    `  title: ${clean(thread.title)}`,
    `  category: ${clean(thread.category)}`,
    `  last seen: ${thread.lastDate}`,
  ];
  const headlines = (thread.headlines || []).map(clean).filter(Boolean);
  if (headlines.length) {
    lines.push('  latest headlines:', ...headlines.map(h => `    - ${h}`));
  }
  return lines.join('\n');
}

// Headline, dek, category and developments only. Never the body, and never
// source posts: those are other outlets' words.
function buildGroupingPrompt(dateKey, articles, knownThreads) {
  const threads = knownThreads.length
    ? knownThreads.map(describeThread).join('\n')
    : 'There are no existing threads. Every article starts a new thread.';

  return [
    'You are sorting the articles of one edition of a daily newspaper into threads.',
    'A thread is one running story followed across editions, such as "the ceasefire talks".',
    `The edition is dated ${dateKey}.`,
    '',
    'For each article, decide one thing: is it the SAME running story as one of the existing',
    'threads below? Judge sameness only. Do not judge how important a story is.',
    '',
    'Join an existing thread only when the article is clearly a continuation of that exact story:',
    'the same event, dispute, case or process, with the same main actors. Sharing a country, a',
    'topic or a category is not enough. When in doubt, start a new thread. Two stories wrongly',
    'joined are much worse than one story wrongly split.',
    '',
    'Reply with JSON only, no prose around it, in exactly this shape:',
    '{"assignments": [{"articleId": string, "threadId": string | null, "title": string}]}',
    '',
    '- One entry for every article below, using its articleId exactly as given.',
    '- threadId: the threadId of the existing thread it continues, exactly as given, or null to',
    '  start a new thread. Never invent a threadId.',
    '- title: only needed when threadId is null. A short neutral name for the running story,',
    '  a few words, not a headline.',
    '',
    '## Existing threads',
    threads,
    '',
    `## Articles in the ${dateKey} edition`,
    articles.map(describeArticle).join('\n'),
  ].join('\n');
}

// The model's text to a list of assignments, or null when there is none to
// be had. Asked for an object; a bare array is tolerated, because a model that
// drops the wrapper has still answered the question.
function parseGroupingReply(reply) {
  const parsed = parseModelReply(reply);
  if (parsed && Array.isArray(parsed.assignments)) return parsed.assignments;

  if (typeof reply !== 'string') return null;
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const array = JSON.parse(reply.slice(start, end + 1));
    return Array.isArray(array) ? array : null;
  } catch {
    return null;
  }
}

// Validates and corrects. What comes out is safe to store as it is:
//
//  - An unknown articleId is dropped. So is a second entry for one article.
//  - An unknown threadId is not stored. The article starts a new thread
//    instead, which is the safe way to be wrong.
//  - Any article the model left out starts a new thread of its own. Grouping
//    never leaves a hole.
//  - Every new thread gets an id minted here, and its own thread. Two new
//    articles are never merged on a shared title.
//
// `assignments` is in the order `articles` was given. `mintId` exists so a
// test can name the ids it expects.
function validateGrouping(reply, articles, knownThreads, mintId = mintThreadId) {
  const byId = new Map(articles.map(a => [a.id, a]));
  const known = new Set(knownThreads.map(t => t.threadId));

  const chosen = new Map();
  for (const entry of Array.isArray(reply) ? reply : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const articleId = typeof entry.articleId === 'string' ? entry.articleId : null;
    if (!articleId || !byId.has(articleId) || chosen.has(articleId)) continue;
    const threadId = typeof entry.threadId === 'string' && known.has(entry.threadId)
      ? entry.threadId
      : null;
    chosen.set(articleId, { threadId, title: clean(entry.title) });
  }

  const assignments = [];
  const newThreads = [];
  for (const article of articles) {
    const pick = chosen.get(article.id);
    if (pick && pick.threadId) {
      assignments.push({ articleId: article.id, threadId: pick.threadId });
      continue;
    }
    const threadId = mintId();
    const title = ((pick && pick.title) || clean(article.headline) || 'Untitled').slice(0, TITLE_CAP);
    newThreads.push({ threadId, title, category: clean(article.category) || FALLBACK_CATEGORY });
    assignments.push({ articleId: article.id, threadId });
  }

  return { assignments, newThreads };
}

module.exports = {
  THREAD_WINDOW_DAYS,
  RECENT_HEADLINES,
  TITLE_CAP,
  mintThreadId,
  threadWindowStart,
  recentHeadlines,
  buildGroupingPrompt,
  parseGroupingReply,
  validateGrouping,
};
