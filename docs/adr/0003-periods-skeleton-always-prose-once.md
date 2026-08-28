# 0003 — Periods: the skeleton is always served, the prose is generated once

**Status:** accepted (F11, F12, F14)

## Decision

`GET /api/v2/periods/:id` answers for a week, month, quarter or year with a
**skeleton** — edition count, article count, per-category counts, and a timeline
with one entry per day in the range — plus `prose` and a `proseStatus` of
`ready | pending | none`.

The prose is generated **lazily, once, on first view of a closed period**, from
that period's **headlines only**, and stored for ever in its own `periodProse`
collection. The generator is OpenRouter's chat completions endpoint, with both
the key (`OPENROUTER_API_KEY`) and the model (`OPENROUTER_MODEL`, falling back
to a constant in `prose.js`) read from the environment — the convention the
`instagram-news-summarizer` extension already uses, reused rather than
reinvented.

The output shape is fixed by the app's ADR 0001 and validated before storage:
`{lede, byCategory: [{slug, name, text}], also}`.

The period arithmetic lives in `period.js`, ported from the app's
`src/lib/period.ts`, and `test/period-agreement.json` holds the two
implementations to identical answers.

## Alternatives rejected

**404 for an empty period.** A period is a calendar interval that always exists,
and sparsity is the normal case here — roughly three days in four carry no
edition, so "a month at a glance" is legitimately one edition. An empty in-range
period returns a valid skeleton with zero counts. 404 is only for a malformed id
or one outside the year bounds.

**Waiting for the prose before serving anything.** The skeleton is deterministic
and always truthful, which is what lets the screen render unconditionally and
treat the summary as a bonus.

**A cron or a queue for generation, and staleness tracking.** Closed periods are
immutable: the date key is derived from push time and is part of the article id,
so an article can never land in a past period and a re-push can never touch one.
There is nothing to invalidate.

**Rate limiting the generator.** Only closed periods generate, generation is
once, and the set of closed periods is finite and small. The worst anyone can
force is "generate every ungenerated period once" — the same spend that would
have happened anyway. **Lifetime cost is bounded by the calendar, not by
traffic; the immutability rule is the rate limit.**

**Nesting summaries.** A year is generated from its own headlines, not from four
quarter summaries, so summarisation error does not compound.

**Sending article bodies to the model.** Headlines only: 78 for a week, roughly
1068 for a year.

**Re-deriving the period arithmetic here from scratch.** ISO week numbering and
year edges are where an off-by-one survives review and then shows a reader the
wrong month. The app's tests were ported first and the module written to pass
them.

**Porting the app's labelling and bucketing too.** Both are presentation the app
owns and the response carries no label, so a port would duplicate copy with
nothing holding the two equal.

## Consequences

**With `OPENROUTER_API_KEY` unset, generation does not run and does not throw.**
The period keeps `proseStatus: "pending"` and its skeleton renders, which is
already the specified state for a closed period with no summary. A backend
deployed without the key is degraded, never broken.

The first view of a closed period pays for the model call. Once per period,
ever.

**The order `byCategory` is stored in is the ranking**, and nothing downstream
re-sorts it — a period view has no headline list, so the data cannot supply an
ordering and the sentences can. The ordering is therefore imposed at generation
time, not at read time.

The per-category `name` is stored alongside the slug, so a frozen summary keeps
the label it was written under even if the category is later renamed.

Prose lives in its own collection because `articles` has spent its one text
index slot (ADR 0001).

Every date operation in `period.js` is arithmetic on IST calendar digits —
`Date.UTC` plus the `getUTC*` readers — and never a timezone conversion. A
previous defect from breaking that rule cost a re-dating backfill of 310
documents and every affected article id.
