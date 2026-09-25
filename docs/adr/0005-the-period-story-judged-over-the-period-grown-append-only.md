# 0005 — The period story: importance judged over the period, grown append-only

**Status:** accepted (S01–S06). Supersedes ADR 0003 for prose; its skeleton
half stands. Amends ADR 0004: a late filing is new evidence and invalidates
nothing.

## Context

The period view's written half was **prose**: a lede, one paragraph per
category and a fold-in line, generated once from a closed period's headlines.
That is a summary, and readers did not want a summary. They wanted to read
**only the important stories**, each told in full up to today, and to come back
tomorrow and find **yesterday's text unchanged, with only the new part added**.

"Important" has one definition, and it goes into the prompt verbatim
(`STORY_DEFINITION` in `story.js`):

> A story containing one or more verified developments that materially change
> the known state of events, have non-trivial consequences, and remain relevant
> beyond the publication cycle.

That is four checks — **verified**, **material change**, **consequences**,
**lasting** — and all four must pass.

## Decision

`GET /api/v2/periods/:id` serves the unchanged skeleton plus a **period story**
and a `storyStatus`. `prose` and `proseStatus` are gone.

```
story        { sections: [{ date, entries: [{ threadId, kind, headline, paragraphs,
                                              articleIds, continuesFrom }] }] }
storyStatus  'none' | 'writing' | 'ready'
kind         'new' | 'update' | 'correction'
```

Every article belongs to exactly one **thread** (`threads.js`,
`threadGrouping.js`). A story is grown per period by one **run** per edition
date (`storyCatchUp.js`), each run judged by the **period editor** (`story.js`)
and stored under the guards in `periodStory.js`.

| # | Decision | Where it lives |
|---|---|---|
| D1 | **Importance is judged per period, over the period's evidence to date. Never per day.** A run for date `d` reads every thread with an article in `[from, min(d, to)]`, with its whole trail in `[from, d]`. | `buildEvidence` |
| D2 | **Append-only.** Each run adds at most one dated **section**, at the end. Earlier sections never change. Every store is filtered on the `throughDate` and section count it read, so a retried or doubled run cannot add twice. | `storeUpdate`, `guard` |
| D3 | A section holds `new` entries (a thread passing the four checks for the first time, told from its start in the period), `update`s to **admitted** threads, and `correction`s. When nothing qualifies there is no section, and that is a normal answer. | `validateSection` |
| D4 | **Each period judges against its own range.** The bar is worded per kind — a week's story "mattered this week", a year's "shaped the year; expect very few" — so a story can be in the week and not the year. | `BARS` |
| D5 | **A 3-day grace window** after the period's last day. Editions inside it are evidence and can still admit stories whose events happened inside the period. Grace articles are never cited, and a grace run keeps only `new` entries. | `GRACE_DAYS`, `storyWindow` |
| D6 | **A big one-day event waits one more edition**, like every story. "Lasting" is enforced in code: the thread is on at least two distinct editions. So is the source half of "verified": at least two source posts, or an `official` basis of at least three words found in the thread's own evidence. Material change and consequences are the model's to judge. | `MIN_EDITIONS`, `MIN_SOURCES`, `hasOfficialBasis` |
| D7 | **A story later found wrong gets a `correction` entry appended.** The frozen text is not edited. | `validateSection` |
| D8 | **Only the section dated today may be rewritten**, by a same-day re-push. The replace is filtered on that section's date being today, so a section dated before today is never addressed by any path. When today's run wrote no section, a re-run today appends one instead: there is nothing dated today to replace. | `storeUpdate` |
| D9 | **Prose is removed.** No lede, no per-category paragraphs, no fold-in line. `prose.js`, `periodProse` and the prose invalidation on write are gone. | — |
| D10 | **Generation runs only when a period is opened**, after the response, through one in-process queue, catching up oldest edition first. Nothing runs on `POST /api/articles`. | `queueStory`, `catchUp`, `createStoryQueue` |
| D11 | **Backend and app change together.** `prose` leaves the wire in the same release; the app bumped its cache version. | app ADR 0003 |

The rest follows from those:

**Threads are global and decide sameness only, never importance.** Every period
agrees on what one story is, so a thread in the week is the same thread in the
year. An edition is grouped only after every earlier one, against the threads
active in the 60 days before it, one model call per edition. The model is biased
towards starting a new thread: two stories wrongly joined become one false
narrative, while one story wrongly split is two threads the editor can still
write about. The backend mints every thread id; an id the model invented would
be indistinguishable from one it misremembered. Hidden articles are grouped too,
because `hidden` is a read filter and toggling it must not need a regroup.

**Stored order is the reading order.** Sections by date, entries within a
section in the editor's own order of importance. Nothing re-sorts downstream —
the same principle the prose had, now true of a thing that can actually carry
it.

**The model's reply is not trusted.** An entry that breaks a rule is dropped and
the rest of the section stands: an unknown thread, `new` for an admitted thread
or `update`/`correction` for one that is not, an entry failing the code checks,
a cited article outside the thread, after `d` or outside the period, or an entry
with no headline or no paragraph. An unparseable reply is a failed attempt.
An `official` claim is stricter than the model's word: its basis must be at
least three words found in the thread's own evidence, or the entry needs the
source count instead.

**Three attempts per run date, then the date is skipped** and `throughDate`
moves past it; its articles stay evidence for every later run. On the last
attempt a failed grouping call files each article into a thread of its own, so
an edition the model cannot group becomes a false split rather than a block on
every later edition in every period.

**The audit fields stay in Mongo.** `why`, `verification`, `basis`, `writtenAt`
and `model` are stored on each entry or section and never served. A hidden
article's id is removed from `articleIds` at read time; the entry is still
served, because its text was written and frozen and the ids only link out.

**`storyStatus`** is `none` when the period has no visible article, `writing`
when a run is due, queued, or the model key is unset, and `ready` when caught up.
`ready` with no sections is valid: nothing in the period passed the checks.

## Amendment to ADR 0004 — a late filing is new evidence

ADR 0004 had a late historical filing **invalidate** the prose of its week,
month, quarter and year. That no longer happens, because there is nothing to
invalidate: a section is never rewritten once its date has passed.

A late filing is now simply new evidence. `POST /api/articles` does nothing
about stories. The next time a containing period is opened, the article's
`_createdAt` is later than the story's `seenUpTo`, so one run is added **dated
today** and appended at the end, after any edition runs still due; when today's
edition is itself due, that run is the one. The edition runs before it leave
the late filing out, and the first of them stores a `late` mark, so the run
dated today stays due after `seenUpTo` has moved on. A filing noticed between
edition runs adds a mark of its own, so the later edition runs leave it out
too. The run dated today reads the filings and clears the marks (`lateFilings`,
`withoutLateFilings`). So a filing is read once, and never goes into a section
dated in the past. With no `seenUpTo` yet, a mark has no watermark to tell a
late filing from an old one, so it leaves nothing out; the run dated today
still follows. A late filing is grouped
into a thread first, like any ungrouped article, against the threads that exist
when it is grouped.

## Alternatives rejected

**Judging importance per edition.** One edition cannot show that a story
lasted, or that its consequences arrived. Both are facts about later editions,
so a per-day judgement would either admit everything that looks big on the day
or be forced to guess.

**One shared daily record that every period reads.** It would put one bar on a
week and a year alike. A year's story is not its weeks' stories added up; most
of what mattered in a week did not shape the year, and only a judgement over the
year's own range can say which.

**Rewriting the whole story on each run.** It is the simple way to keep a story
current, and it breaks the one promise readers asked for: that yesterday's text
stays as it is. Append-only with dated sections is what makes "come back
tomorrow and read only what is new" true. A correction is appended for the same
reason, rather than editing what a reader has already read.

**Generating on write.** `POST /api/articles` is the one moment the dyno is
provably awake, which is why ADR 0002 sends pushes there. But generating there
means writing the week, month, quarter and year for every edition whether or not
anyone ever opens them. Generating on open makes cost follow what readers open.

**Headlines only.** Enough for a summary, not enough to tell a story in full.
The evidence carries each article's headline, dek and developments, and the full
body for the edition being run only, which keeps a year's input bounded while
giving the editor the text of what it is writing about today.

## Consequences

**The response never waits on the model**, exactly as ADR 0003 required of the
prose. The first open of a period gets its skeleton and whatever is stored,
with `storyStatus: "writing"`; sections arrive over later views. Every period
response caches for five minutes.

**A first open of an old year is about one run per edition in it** — roughly 90
model calls, one after another, in one queue. Accepted: it happens once per
period, and only for periods a reader opens. `MAX_RUNS_PER_PASS` (500) exists
only to stop a loop that cannot make progress.

**Render runs one instance, and there is no lease.** Two instances cannot add a
section twice, because of the guards and the unique index on
`periodStories.periodId`; at worst they repeat a model call.

**With `OPENROUTER_API_KEY` unset nothing is queued, read or called**, and every
period with articles reports `writing`. The skeleton still renders. A backend
without the key is degraded, never broken.

**Once a period has ended, a late filing can only admit.** Its run is dated
today, after the period's last day, so it is a grace run: no updates and no
corrections. A
correction the late article would justify cannot be written into that period's
story.

**A late filing into an earlier grace-window day that has already run is not a
run of its own.** A later run in the window reads it; if none follows, that period's
story never does. The period's own days do not have this gap.

**Frozen text can mention an article that is later hidden.** The link goes, the
sentence stays. Pulling the text itself is a manual edit of `periodStories`.

**The old `periodProse` documents are left in the database.** Nothing reads
them. Dropping the collection is a manual step.

**What ADR 0003 still says for the skeleton stands**: a 404 only for a malformed
or out-of-range id, an empty period as a valid zero-count skeleton, and
`period.js` held to the app's arithmetic by `test/period-agreement.json`.

Stories live in their own collection, `periodStories`, because `articles` has
spent its one text index slot (ADR 0001). Threads live in `storyThreads`, with
each article's thread on `articles._threadId`, which is the source of truth.
