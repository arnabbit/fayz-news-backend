# 0006 — The period story is a ranked list of stories

**Status:** accepted. Supersedes ADR 0005 in part: its dated sections and
entries (D2, D3, D8, the wire shape, and "stored order is the reading order"
as a reading by day) and its two-edition "lasting" rule (D6). Everything else
in 0005 stands: the definition and the four checks, threads, importance judged
per period against its own bar, the grace window, the source half of
"verified", corrections appended, generation on open through one queue, three
attempts, the audit fields, no key, and the late-filing amendment to ADR 0004.

## Context

ADR 0005 grew a period's story by day. Each run appended one dated section of
`new`, `update` and `correction` entries. That kept yesterday's text unchanged,
but it made a month a diary. The live September month had 17 day-sections and
64 entries, 29 of them new stories and 34 updates, and it was still growing.
Readers wanted about 20 big stories for a month, each told once and kept
current, not a record of every day on which something moved.

Two things let it grow. Nothing limited how many stories a period could hold,
and "lasting" meant two editions for every kind of period, so a story that
lasted two days of a month was as lasting as one that ran all month.

The definition of an important story is unchanged, and it still goes into the
prompt verbatim.

## Decision

`GET /api/v2/periods/:id` serves the unchanged skeleton and `storyStatus`, and
a story that is organised by story, not by day:

```
story  { stories: [{ threadId, headline, parts: [{ date, kind, paragraphs, articleIds }] }] }
kind   'backstory' | 'update' | 'correction'
```

`stories` is in ranking order. Each story's parts are in the order written.

| # | Decision | Where it lives |
|---|---|---|
| D1 | **A period story is a ranked list of stories.** Each story is one thread: a headline, a `backstory` part written on the day it is admitted, then dated `update` and `correction` parts added at the end. There are no day sections. | `toStory`, `storeUpdate` |
| D2 | **A hard budget, enforced in code:** week 5, month 20, quarter 60, year 240. All of it is available from the period's first day. It is a ceiling, not a target, and the prompt says so. | `BUDGETS`, `validateRanking` |
| D3 | **Re-ranked on every run.** Each run ranks the candidates over the period's evidence up to its date and keeps the top of the budget, so a bigger new story can push the weakest out. A story that drops out is not served, but its stored text is kept. If it comes back, it continues from that text and gets no second backstory. | `validateRanking`, `storeUpdate` |
| D4 | **Append-only text.** A written part is never edited. A material development on a ranked story adds one dated part at the end of it; no material development, no part. At most one part per story per run date. A correction is appended, never an edit. | `storeUpdate` |
| D5 | **"Lasting" is enforced in code, per kind.** A thread is a candidate only when it is on at least week 2, month 3, quarter 5 or year 10 distinct editions inside the period, up to the run date. Grace-window editions are evidence but do not count. The source half of "verified" is unchanged: at least two source posts, or an `official` basis of at least three words found in the thread's own evidence. It is checked when a story is admitted. | `MIN_EDITIONS`, `buildEvidence`, `hasOfficialBasis` |
| D6 | **One model call per run date.** Its input is the period, its bar and budget; each candidate's trail (headline, dek and developments per article, the full body only for articles dated the run date, and only the most recent 8 articles); the current ranking; and each stored story's headline and the text of its parts, so an update does not repeat them. It returns a ranking, a backstory for every ranked thread with no story, and an update or correction for ranked threads with one. | `buildStoryPrompt` |
| D7 | **The validator corrects instead of trusting.** Ranking ids must be candidates, each once. A ranked thread with no stored story and no valid backstory leaves the ranking. The list is then cut to the budget. Cited ids must be the thread's own, on or before the run date and inside the period. At most one update per thread, and none in the grace window. A reply with no ranking is a failed attempt. | `validateRanking` |
| D8 | **A run dated today may be redone, and it replaces only today's parts and today's ranking.** A story whose only part is today's backstory goes with it if the new ranking leaves it out. A part dated before today is never addressed. | `storySoFar`, `storeUpdate` |
| D9 | **A new collection, `periodStoriesV2`, unique on `periodId`.** `periodStories` is not read, migrated or deleted. Every period, September included, is rebuilt from scratch. | `STORIES` |

The rest follows from those:

**The grace window keeps its rule.** A grace run may re-rank and may admit only
stories whose events happened inside the period, because a candidate needs its
editions inside the period and a grace article is never cited. It writes no
update and no correction.

**The store is guarded as before.** A claim or store matches only the
`throughDate` and the story count it read, so a retried or doubled run cannot
add twice. The store sets the whole `stories` list, but that list is always the
stored stories with their parts dated before the run, plus new parts at the
end, so no earlier part can change.

**A run with no candidate makes no call.** The stored ranking stands and
`throughDate` moves on. Early in a month this is most runs, because nothing is
on three editions yet.

**`storyStatus`** keeps its rules: `none` with no visible article, `writing`
while a run is due, queued, or the key is unset, and `ready` when caught up.
`ready` with no story is valid.

## Alternatives rejected

**Capping the day sections.** A cap on entries per day still gives a diary,
and a month would still collect a new list every day.

**A soft budget in the prompt only.** The model was already told that most
stories do not qualify for a month. It admitted 29.

**Rewriting a story's text on each run so it reads as one piece.** It breaks
the promise from ADR 0005 that text already read stays as it was. Parts keep
that promise and still read as one story, because an update opens by joining
to what came before.

**Dropping a story's text when it leaves the ranking.** A story can fall out
and come back in a long period. Keeping its text means it resumes where it
stopped, and it is never told twice.

**Migrating the old documents.** Sections cannot be turned into ranked stories
without a new judgement over the period, which is what a rebuild is.

## Consequences

**The served list can reorder from day to day**, and a story can disappear
from it. The text of every part is still frozen once its date has passed.

**An empty ranking empties the served list** until a later run ranks again. It
is a valid answer: nothing may qualify. It is also what a bad reply that still
parses would do.

**The input grows with the stored text.** Each candidate that has a story
carries all of its parts. A year can hold 240 stories; the trail limit of 8
articles bounds the evidence, but not the stored text.

**An update is not tied in code to an article of the run date**, because a run
dated today for a late filing reads articles filed into earlier dates. The
prompt asks for what is new in this edition, and the stored text is shown so
it is not repeated.

**September is rebuilt on its next open**, one run per edition, as ADR 0005
described for any first open. The old `periodStories` documents stay in the
database, unread. Dropping the collection is a manual step.
