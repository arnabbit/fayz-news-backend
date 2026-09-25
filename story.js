// The period editor. Given one period, one run date `d`, the evidence up to
// `d` and the story written so far, it builds the prompt and validates the
// reply into one section, or into nothing. Pure: no database, no network. The
// catch-up run reads the rows, makes the call and stores the section.
//
// Importance is judged over the period, never within one day. Two of the four
// checks are enforced here rather than trusted to the model: "lasting" (the
// thread is on at least two editions) and the source half of "verified".
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

// A thread is verified by sources when its articles carry at least this many
// source posts in total.
const MIN_SOURCES = 2;
// A thread is lasting when it is on at least this many distinct editions.
const MIN_EDITIONS = 2;
const MAX_PARAGRAPHS = 4;
// An official basis shorter than this cannot be told apart from a phrase that
// happens to occur anywhere.
const MIN_BASIS_WORDS = 3;

const KINDS = new Set(['new', 'update', 'correction']);

// Only sections dated before `d` are the story so far. A section dated `d`
// is the one this run may replace, so it must not count against itself.
function priorSections(story, d) {
  return list(story && story.sections).filter(s => s && typeof s.date === 'string' && s.date < d);
}

// A thread is admitted once it has a `new` entry in the story.
function admittedThreads(story, d) {
  const admitted = new Set();
  for (const section of priorSections(story, d)) {
    for (const e of list(section.entries)) {
      if (e && e.kind === 'new' && typeof e.threadId === 'string') admitted.add(e.threadId);
    }
  }
  return admitted;
}

// threadId to the entries already written for it, oldest first, with the
// date of the section each is in.
function writtenByThread(story, d) {
  const out = new Map();
  for (const section of priorSections(story, d)) {
    for (const e of list(section.entries)) {
      if (!e || typeof e.threadId !== 'string') continue;
      if (!out.has(e.threadId)) out.set(e.threadId, []);
      out.get(e.threadId).push({ date: section.date, entry: e });
    }
  }
  return out;
}

// Evidence for a run: every thread with at least one article in
// [from, min(d, to)], with its trail of articles in [from, d]. Grace-window
// articles (after `to`) are in the trail, marked, so they count towards the
// checks but can never be cited. Hidden articles are not evidence at all.
//
//   threads   [{ threadId, title, category }]           storyThreads rows
//   articles  [{ id, _threadId, _dateKey, headline, dek, body[],
//                developments[{ summary }], sourcePosts[], hidden? }]
//   story     { sections: [{ date, entries[] }] }
//
// Articles outside the window, or on a thread not in `threads`, are ignored,
// so the caller may pass more than it needs.
function buildEvidence(period, d, threads, articles, story) {
  const { from, to } = period.range;
  const lastInPeriod = d < to ? d : to;
  const admitted = admittedThreads(story, d);

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
    if (!trail || !trail.some(a => a._dateKey <= lastInPeriod)) continue;
    trail.sort((x, y) => x._dateKey.localeCompare(y._dateKey) || x.id.localeCompare(y.id));
    evidence.push({
      threadId: thread.threadId,
      title: clean(thread.title),
      category: clean(thread.category),
      admitted: admitted.has(thread.threadId),
      totalSources: trail.reduce((sum, a) => sum + list(a.sourcePosts).length, 0),
      editionCount: new Set(trail.map(a => a._dateKey)).size,
      articles: trail.map(a => ({
        id: a.id,
        date: a._dateKey,
        inPeriod: a._dateKey <= to,
        headline: clean(a.headline),
        dek: clean(a.dek),
        developments: list(a.developments).map(x => clean(x && x.summary)).filter(Boolean),
        // Full bodies only for the edition being run, which keeps a year's
        // input bounded.
        body: a._dateKey === d ? list(a.body).map(clean).filter(Boolean) : null,
      })),
    });
  }

  // Admitted threads first, so the model reads what it is continuing before
  // what it may add. Then by when the thread first appeared.
  return evidence.sort((x, y) => (Number(y.admitted) - Number(x.admitted))
    || x.articles[0].date.localeCompare(y.articles[0].date)
    || x.threadId.localeCompare(y.threadId));
}

function describeWritten(written) {
  return written.map(({ date, entry }) => {
    const paragraphs = list(entry.paragraphs).map(clean).filter(Boolean).map(p => `      ${p}`);
    return [`    - [${date}] ${entry.kind}: ${clean(entry.headline)}`, ...paragraphs].join('\n');
  }).join('\n');
}

function describeThread(thread, written, d) {
  const lines = [
    `### threadId: ${thread.threadId}`,
    `title: ${thread.title}`,
    `category: ${thread.category}`,
    `admitted: ${thread.admitted ? 'yes' : 'no'}`,
    `totalSources: ${thread.totalSources}`,
    `editionCount: ${thread.editionCount}`,
  ];
  if (thread.admitted && written && written.length) {
    lines.push('already written (do not repeat it):', describeWritten(written));
  }
  lines.push('trail:');
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
  const written = writtenByThread(story, d);

  const threads = list(evidence).length
    ? list(evidence).map(t => describeThread(t, written.get(t.threadId), d)).join('\n\n')
    : 'There are no threads in this period up to this date. Reply with {"entries": []}.';

  const graceLines = grace
    ? [
      '',
      `IMPORTANT: the period is over; you may only admit stories whose events happened on or before ${to}. Later editions are evidence only.`,
      'Only "new" entries are allowed in this run. Do not write any "update" or "correction".',
    ]
    : [];

  return [
    'You are the editor of the running story for one period of a daily newspaper.',
    `The period is ${period.id} (${period.kind}), covering ${from} to ${to}.`,
    `This run is for the edition dated ${d}. You see the period's evidence up to that date and the story written so far.`,
    'You add at most one dated section to the story. Earlier sections are frozen and will never change.',
    ...graceLines,
    '',
    '## What counts as an important story',
    STORY_DEFINITION,
    '',
    'A thread becomes a "new" entry only when ALL four checks pass:',
    `1. verified: the thread has ${MIN_SOURCES} or more source posts in total (totalSources), or the evidence contains an official text (a court order, government data, an official statement). For an official text, set "verification": "official" and put in "basis" an exact quote of that text from the evidence.`,
    '2. material change: it changes what is known. Not a restatement, not an opinion.',
    '3. consequences: it has a non-trivial effect on people, money, law, policy or safety.',
    `4. lasting: the thread is on ${MIN_EDITIONS} or more distinct editions (editionCount). A big one-day event waits for one more edition.`,
    'Checks 1 and 4 are also enforced by code. An entry that fails them is discarded.',
    '',
    `The bar for a ${period.kind}: the story ${BARS[period.kind] || BARS.week}.`,
    'Judge importance over the whole period to this date, not over one day.',
    '',
    '## Kinds of entry',
    '- "new": a thread that is not admitted yet and now passes all four checks. Tell the story from its start in the period up to this edition: that is the backstory.',
    '- "update": only for an admitted thread with something new since its last entry. Tell only what is new, and open by joining to the last entry ("Two days after the ceasefire...").',
    '- "correction": only for an admitted thread, when the evidence shows something already written was wrong. Say what was wrong and what is now known.',
    'Never write "new" for an admitted thread. Never write "update" or "correction" for a thread that is not admitted.',
    'Most runs add nothing, or very little. An empty list is a normal answer.',
    '',
    '## Writing rules',
    '- Plain past-tense newspaper English. No markdown, no headings, no bullets inside the strings.',
    '- Only facts present in the evidence. Do not state outcomes the text does not state.',
    `- One to ${MAX_PARAGRAPHS} paragraphs per entry.`,
    '- Put entries in order of importance, most important first. That order is kept as it is.',
    '- articleIds: the articles of that thread the entry is based on, exactly as given. Never cite an article marked "do not cite".',
    '',
    '## Reply',
    'Reply with JSON only, no prose around it, in exactly this shape:',
    '{"entries": [{"threadId": string, "kind": "new" | "update" | "correction", "headline": string, "paragraphs": [string], "articleIds": [string], "verification": "sources" | "official", "basis": string, "why": string}]}',
    '- threadId exactly as given below. At most one entry per thread.',
    '- verification and basis only when they apply. why: which of the four checks passed and how, in one sentence.',
    '',
    '## Threads',
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

// Validates the reply into one section, or null for no section. An entry that
// breaks a rule is dropped; the others stand. What comes out is safe to store:
//
//  - The thread must be in the evidence, and admitted for `update` and
//    `correction`, not admitted for `new`.
//  - A `new` entry must pass the two code checks: at least MIN_EDITIONS
//    editions, and MIN_SOURCES source posts or an official basis quoted from
//    the evidence.
//  - After the period, only `new` entries.
//  - articleIds keep only the thread's own articles dated on or before `d`
//    and inside the period. None left drops the entry.
//  - A headline and at least one paragraph, or the entry is dropped.
//  - One entry per thread; the first wins. The order is the model's, and it
//    is the ranking.
//
// `reply` is the model's text, or an object already parsed from it.
function validateSection(reply, period, d, evidence, story) {
  const parsed = typeof reply === 'string' ? parseModelReply(reply) : reply;
  const raw = parsed && typeof parsed === 'object' ? parsed.entries : null;
  if (!Array.isArray(raw)) return null;

  const { from, to } = period.range;
  const grace = d > to;
  const byThread = new Map(list(evidence).map(t => [t.threadId, t]));
  const written = writtenByThread(story, d);
  const seen = new Set();
  const entries = [];

  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const threadId = clean(e.threadId);
    const thread = byThread.get(threadId);
    if (!thread || seen.has(threadId)) continue;

    const kind = e.kind;
    if (!KINDS.has(kind)) continue;
    if (grace && kind !== 'new') continue;
    if ((kind === 'new') === thread.admitted) continue;

    const citable = new Set(thread.articles
      .filter(a => a.date >= from && a.date <= d && a.date <= to)
      .map(a => a.id));
    const articleIds = [...new Set(list(e.articleIds).filter(id => typeof id === 'string' && citable.has(id)))];
    if (articleIds.length === 0) continue;

    const headline = clean(e.headline);
    const paragraphs = list(e.paragraphs).map(clean).filter(Boolean).slice(0, MAX_PARAGRAPHS);
    if (!headline || paragraphs.length === 0) continue;

    const official = e.verification === 'official' && hasOfficialBasis(thread, e.basis);
    let verification = null;
    if (official) verification = 'official';
    else if (thread.totalSources >= MIN_SOURCES) verification = 'sources';

    if (kind === 'new' && (thread.editionCount < MIN_EDITIONS || !verification)) continue;

    const previous = written.get(threadId);
    const out = {
      threadId,
      kind,
      headline,
      paragraphs,
      articleIds,
      continuesFrom: previous && previous.length ? previous[previous.length - 1].date : null,
    };
    if (verification) out.verification = verification;
    if (official) out.basis = clean(e.basis);
    // Stored, never served: which checks passed, for whoever audits a story.
    out.why = clean(e.why);

    seen.add(threadId);
    entries.push(out);
  }

  // Zero entries is no section. A normal answer, not a failure.
  return entries.length ? { date: d, entries } : null;
}

module.exports = {
  STORY_DEFINITION,
  BARS,
  MIN_SOURCES,
  MIN_EDITIONS,
  MAX_PARAGRAPHS,
  MIN_BASIS_WORDS,
  admittedThreads,
  buildEvidence,
  buildStoryPrompt,
  validateSection,
};
