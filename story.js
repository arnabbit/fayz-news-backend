// The period editor. Given one period, one run date `d`, the candidate
// threads up to `d` and the stories written so far, it builds the prompt and
// validates the reply into a ranking and the parts owed to it. Pure: no
// database, no network. The catch-up run reads the rows, makes the call and
// stores the result.
//
// Importance is judged over the period, never within one day. What can be
// counted is enforced here rather than trusted to the model: the budget, the
// "lasting" test (a thread must be on enough editions to be a candidate at
// all) and the source half of "verified".
//
// Dates are IST `YYYY-MM-DD` strings throughout. They compare as strings.

const { parseModelReply } = require('./model');
const { clean, list } = require('./values');

// Verbatim in the prompt. Changing it changes what the paper calls important.
const STORY_DEFINITION = 'A story containing one or more verified developments that materially change the known state of events, have non-trivial consequences, and remain relevant beyond the publication cycle.';

// Each period judges against its own range. A year's bar is higher than a
// week's, so a story can be in the week and not the year.
const BARS = {
  week: 'mattered this week',
  month: 'mattered this month; most week-level stories do not qualify',
  quarter: 'shaped the quarter',
  year: 'shaped the year; expect very few',
};

// The most stories a period serves. A ceiling, not a target, and all of it is
// there from the period's first day.
const BUDGETS = { week: 5, month: 20, quarter: 60, year: 240 };

// A thread is lasting, and so a candidate at all, when it is on at least this
// many distinct editions inside the period, up to the run date.
const MIN_EDITIONS = { week: 2, month: 3, quarter: 5, year: 10 };

// A thread is verified by sources when its articles carry at least this many
// source posts in total.
const MIN_SOURCES = 2;
const MAX_PARAGRAPHS = 4;
// An official basis shorter than this cannot be told apart from a phrase that
// happens to occur anywhere.
const MIN_BASIS_WORDS = 3;
// How many of a thread's most recent articles the editor is shown. Keeps a
// year's input bounded.
const TRAIL_ARTICLES = 8;

const UPDATE_KINDS = new Set(['update', 'correction']);

const budgetOf = period => BUDGETS[period.kind] || BUDGETS.week;
const minEditionsOf = period => MIN_EDITIONS[period.kind] || MIN_EDITIONS.week;

// The stories as they stood before the run for `d`: only parts dated before
// `d`, and only stories left with a part. A part dated `d` belongs to the run
// this one may replace, so it must not count against itself; a story whose
// only part is dated `d` was admitted by that run and is not written yet.
//
//   story  { stories: [{ threadId, headline, parts: [{ date, kind, ... }] }], ranking: [threadId] }
function storySoFar(story, d) {
  const stories = [];
  for (const s of list(story && story.stories)) {
    if (!s || typeof s.threadId !== 'string') continue;
    const parts = list(s.parts).filter(p => p && typeof p.date === 'string' && p.date < d);
    if (parts.length) stories.push({ ...s, parts });
  }
  const written = new Set(stories.map(s => s.threadId));
  const ranking = list(story && story.ranking).filter(id => written.has(id));
  return { stories, ranking };
}

// The candidates for a run: every thread with an article in
// [from, min(d, to)] that is on at least MIN_EDITIONS of the period's own
// editions up to `d`. Its trail is its articles in [from, d], of which the
// editor sees the most recent TRAIL_ARTICLES. Grace-window articles (after
// `to`) are in the trail, marked, so they are evidence but never cited and
// never count as an edition. Hidden articles are not evidence at all.
//
//   threads   [{ threadId, title, category }]           storyThreads rows
//   articles  [{ id, _threadId, _dateKey, headline, dek, body[],
//                developments[{ summary }], sourcePosts[], hidden? }]
//   story     the stored period story
//
// Articles outside the window, or on a thread not in `threads`, are ignored,
// so the caller may pass more than it needs.
function buildEvidence(period, d, threads, articles, story) {
  const { from, to } = period.range;
  const lastInPeriod = d < to ? d : to;
  const sofar = storySoFar(story, d);
  const written = new Set(sofar.stories.map(s => s.threadId));
  const rank = new Map(sofar.ranking.map((id, i) => [id, i]));

  const trails = new Map();
  for (const a of list(articles)) {
    if (!a || a.hidden === true || typeof a.id !== 'string') continue;
    const date = a._dateKey;
    if (typeof date !== 'string' || date < from || date > d) continue;
    if (!trails.has(a._threadId)) trails.set(a._threadId, []);
    trails.get(a._threadId).push(a);
  }

  const evidence = [];
  for (const thread of list(threads)) {
    const trail = trails.get(thread.threadId);
    if (!trail) continue;
    const inPeriod = trail.filter(a => a._dateKey <= lastInPeriod);
    const editionCount = new Set(inPeriod.map(a => a._dateKey)).size;
    if (editionCount < minEditionsOf(period)) continue;
    trail.sort((x, y) => x._dateKey.localeCompare(y._dateKey) || x.id.localeCompare(y.id));
    evidence.push({
      threadId: thread.threadId,
      title: clean(thread.title),
      category: clean(thread.category),
      written: written.has(thread.threadId),
      firstDate: trail[0]._dateKey,
      totalSources: trail.reduce((sum, a) => sum + list(a.sourcePosts).length, 0),
      editionCount,
      // Every id the thread may cite, including ones older than the trail the
      // editor is shown: an earlier part may have cited them.
      citable: inPeriod.map(a => a.id),
      articles: trail.slice(-TRAIL_ARTICLES).map(a => ({
        id: a.id,
        date: a._dateKey,
        inPeriod: a._dateKey <= to,
        headline: clean(a.headline),
        dek: clean(a.dek),
        developments: list(a.developments).map(x => clean(x && x.summary)).filter(Boolean),
        // Full bodies only for the edition being run.
        body: a._dateKey === d ? list(a.body).map(clean).filter(Boolean) : null,
      })),
      omitted: Math.max(0, trail.length - TRAIL_ARTICLES),
    });
  }

  // The current ranking first, in its order, so the model reads what it is
  // continuing before what it may add. Then by when the thread first appeared.
  const at = t => (rank.has(t.threadId) ? rank.get(t.threadId) : Infinity);
  return evidence.sort((x, y) => (at(x) - at(y))
    || x.firstDate.localeCompare(y.firstDate)
    || x.threadId.localeCompare(y.threadId));
}

function describeWritten(written) {
  const lines = ['story so far (do not repeat it):', `  headline: ${clean(written.headline)}`];
  for (const part of written.parts) {
    lines.push(`  - [${part.date}] ${part.kind}:`, ...list(part.paragraphs).map(clean).filter(Boolean).map(p => `      ${p}`));
  }
  return lines.join('\n');
}

function describeThread(thread, written, rank, d) {
  const lines = [
    `### threadId: ${thread.threadId}`,
    `title: ${thread.title}`,
    `category: ${thread.category}`,
    `ranked now: ${rank === undefined ? 'no' : `#${rank + 1}`}`,
    `written: ${written ? 'yes' : 'no'}`,
    `totalSources: ${thread.totalSources}`,
    `editionCount: ${thread.editionCount}`,
  ];
  if (written) lines.push(describeWritten(written));
  lines.push(thread.omitted
    ? `trail (the ${thread.articles.length} most recent articles; ${thread.omitted} earlier ones left out):`
    : 'trail:');
  for (const a of thread.articles) {
    const note = a.inPeriod ? '' : ' (after the period: evidence only, do not cite)';
    lines.push(`  - articleId: ${a.id}`, `    date: ${a.date}${a.date === d ? ' (this edition)' : ''}${note}`);
    lines.push(`    headline: ${a.headline}`);
    if (a.dek) lines.push(`    dek: ${a.dek}`);
    if (a.developments.length) lines.push('    developments:', ...a.developments.map(s => `      - ${s}`));
    if (a.body && a.body.length) lines.push('    body:', ...a.body.map(p => `      ${p}`));
  }
  return lines.join('\n');
}

function buildStoryPrompt(period, d, evidence, story) {
  const { from, to } = period.range;
  const grace = d > to;
  const budget = budgetOf(period);
  const sofar = storySoFar(story, d);
  const byThread = new Map(sofar.stories.map(s => [s.threadId, s]));
  const rank = new Map(sofar.ranking.map((id, i) => [id, i]));

  const threads = list(evidence).length
    ? list(evidence).map(t => describeThread(t, byThread.get(t.threadId), rank.get(t.threadId), d)).join('\n\n')
    : 'There are no candidate threads in this period up to this date. Reply with {"ranking": [], "backstories": [], "updates": []}.';

  const current = sofar.ranking.length
    ? sofar.ranking.map((id, i) => `${i + 1}. ${id}: ${clean(byThread.get(id).headline)}`).join('\n')
    : 'No story is ranked yet.';

  const graceLines = grace
    ? [
      '',
      `IMPORTANT: the period is over; you may only admit stories whose events happened on or before ${to}. Later editions are evidence only.`,
      'In this run you may rank and write backstories only. Do not write any "update" or "correction": reply with "updates": [].',
    ]
    : [];

  return [
    'You are the editor of the list of important stories for one period of a daily newspaper.',
    `The period is ${period.id} (${period.kind}), covering ${from} to ${to}.`,
    `This run is for the edition dated ${d}. You see the period's candidate threads up to that date, the current ranking and every story already written.`,
    `You rank the most important stories of the period so far, at most ${budget}, and write what each ranked story is owed. Written text is frozen and will never change; new text is only ever added at the end of a story.`,
    ...graceLines,
    '',
    '## What counts as an important story',
    STORY_DEFINITION,
    '',
    'A thread is ranked only when ALL four checks pass:',
    `1. verified: the thread has ${MIN_SOURCES} or more source posts in total (totalSources), or the evidence contains an official text (a court order, government data, an official statement). For an official text, set "verification": "official" and put in "basis" an exact quote of that text from the evidence.`,
    '2. material change: it changes what is known. Not a restatement, not an opinion.',
    '3. consequences: it has a non-trivial effect on people, money, law, policy or safety.',
    `4. lasting: it stays relevant beyond the day. Every thread below is already on ${minEditionsOf(period)} or more editions of the period.`,
    'Check 1 is also enforced by code for a thread with no written story. A backstory that fails it is discarded, and so is its place in the ranking.',
    '',
    `The bar for a ${period.kind}: the story ${BARS[period.kind] || BARS.week}.`,
    'Judge importance over the whole period to this date, not over one day.',
    '',
    '## The ranking',
    `- At most ${budget} threadIds, most important first. The budget is a ceiling, not a target: rank fewer when fewer qualify. An empty ranking is a normal answer.`,
    '- Rank the whole period so far. A bigger new story may push a weaker one out. A story that drops out keeps its text, and can come back later.',
    '- The order you give is the order readers see.',
    '',
    '## What to write',
    '- backstory: for every ranked thread with "written: no", and only for those. A headline, and the story told from its start in the period up to this edition.',
    '- update: only for a ranked thread with "written: yes" and a material development in the articles dated this edition. Tell only what is new, and open by joining to the story so far ("Two days after the ceasefire..."). No material development means no update.',
    '- correction: only for a ranked thread with "written: yes", when the evidence shows something already written was wrong. Say what was wrong and what is now known.',
    '- At most one update or correction per thread. Never a backstory for a thread with "written: yes". Never repeat the story so far.',
    '',
    '## Writing rules',
    '- Plain past-tense newspaper English. No markdown, no headings, no bullets inside the strings.',
    '- Only facts present in the evidence. Do not state outcomes the text does not state.',
    `- One to ${MAX_PARAGRAPHS} paragraphs per backstory, update or correction.`,
    '- articleIds: the articles of that thread the text is based on, exactly as given. Never cite an article marked "do not cite".',
    '',
    '## Reply',
    'Reply with JSON only, no prose around it, in exactly this shape:',
    '{"ranking": [string], "backstories": [{"threadId": string, "headline": string, "paragraphs": [string], "articleIds": [string], "verification": "sources" | "official", "basis": string, "why": string}], "updates": [{"threadId": string, "kind": "update" | "correction", "paragraphs": [string], "articleIds": [string], "why": string}]}',
    '- threadIds exactly as given below.',
    '- verification and basis only when they apply. why: which of the four checks passed and how, or what is new, in one sentence.',
    '',
    '## Current ranking',
    current,
    '',
    '## Candidate threads',
    threads,
  ].join('\n');
}

// Lower case, letters and digits only, single spaces. So a quote survives
// curly quotes, punctuation and line breaks, and nothing else.
const normalise = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function threadText(thread) {
  return normalise(thread.articles.map(a => [a.headline, a.dek, ...a.developments, ...(a.body || [])].join(' ')).join(' '));
}

// The quote must be long enough to mean something and must occur in the
// thread's own evidence. A basis the model made up is no basis.
function hasOfficialBasis(thread, basis) {
  const quote = normalise(basis);
  if (quote.split(' ').filter(Boolean).length < MIN_BASIS_WORDS) return false;
  return ` ${threadText(thread)} `.includes(` ${quote} `);
}

// The thread's own articles dated on or before `d` and inside the period,
// once each, in the model's order.
function citedIds(thread, ids) {
  const citable = new Set(thread.citable);
  return [...new Set(list(ids).filter(id => typeof id === 'string' && citable.has(id)))];
}

const paragraphsOf = value => list(value).map(clean).filter(Boolean).slice(0, MAX_PARAGRAPHS);

// A backstory as it will be stored, or null when it breaks a rule: no
// headline, no paragraph, no citable article, or not verified.
function validBackstory(b, thread) {
  const headline = clean(b.headline);
  const paragraphs = paragraphsOf(b.paragraphs);
  const articleIds = citedIds(thread, b.articleIds);
  if (!headline || !paragraphs.length || !articleIds.length) return null;

  const official = b.verification === 'official' && hasOfficialBasis(thread, b.basis);
  let verification = null;
  if (official) verification = 'official';
  else if (thread.totalSources >= MIN_SOURCES) verification = 'sources';
  if (!verification) return null;

  const part = { kind: 'backstory', paragraphs, articleIds, verification };
  if (official) part.basis = clean(b.basis);
  // Stored, never served: which checks passed, for whoever audits a story.
  part.why = clean(b.why);
  return { threadId: thread.threadId, headline, part };
}

// Validates the reply into `{ ranking, backstories, updates }`, or null when
// the reply has no ranking at all (a failed attempt). It corrects rather than
// trusts, and what comes out is safe to store:
//
//  - ranking: only candidate threadIds, each once. A thread with no written
//    story stays only with a valid backstory. Then cut to the budget.
//  - backstories: one per ranked thread with no written story, the first
//    valid one. It must be verified: MIN_SOURCES source posts, or an official
//    basis quoted from the evidence.
//  - updates: only for a ranked thread with a written story, at most one per
//    thread, the first valid one. None in the grace window.
//  - articleIds keep only the thread's own articles dated on or before `d`
//    and inside the period. None left drops the backstory or update.
//  - One to MAX_PARAGRAPHS paragraphs, or it is dropped.
//
// `reply` is the model's text, or an object already parsed from it.
function validateRanking(reply, period, d, evidence, story) {
  const parsed = typeof reply === 'string' ? parseModelReply(reply) : reply;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.ranking)) return null;

  const grace = d > period.range.to;
  const byThread = new Map(list(evidence).map(t => [t.threadId, t]));

  const offered = new Map();
  for (const b of list(parsed.backstories)) {
    if (!b || typeof b !== 'object') continue;
    const thread = byThread.get(clean(b.threadId));
    if (!thread || thread.written || offered.has(thread.threadId)) continue;
    const valid = validBackstory(b, thread);
    if (valid) offered.set(thread.threadId, valid);
  }

  const ranking = [];
  const backstories = [];
  for (const raw of parsed.ranking) {
    if (ranking.length >= budgetOf(period)) break;
    const thread = byThread.get(clean(raw));
    if (!thread || ranking.includes(thread.threadId)) continue;
    if (!thread.written) {
      const backstory = offered.get(thread.threadId);
      if (!backstory) continue;
      backstories.push(backstory);
    }
    ranking.push(thread.threadId);
  }

  const ranked = new Set(ranking);
  const updates = [];
  const updated = new Set();
  for (const u of grace ? [] : list(parsed.updates)) {
    if (!u || typeof u !== 'object') continue;
    const thread = byThread.get(clean(u.threadId));
    if (!thread || !thread.written || !ranked.has(thread.threadId) || updated.has(thread.threadId)) continue;
    if (!UPDATE_KINDS.has(u.kind)) continue;
    const paragraphs = paragraphsOf(u.paragraphs);
    const articleIds = citedIds(thread, u.articleIds);
    if (!paragraphs.length || !articleIds.length) continue;
    updated.add(thread.threadId);
    updates.push({ threadId: thread.threadId, part: { kind: u.kind, paragraphs, articleIds, why: clean(u.why) } });
  }

  return { ranking, backstories, updates };
}

module.exports = {
  STORY_DEFINITION,
  BARS,
  BUDGETS,
  MIN_EDITIONS,
  MIN_SOURCES,
  MAX_PARAGRAPHS,
  MIN_BASIS_WORDS,
  TRAIL_ARTICLES,
  storySoFar,
  buildEvidence,
  buildStoryPrompt,
  validateRanking,
};
