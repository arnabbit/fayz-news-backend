# 0003 — Periods: the skeleton is always served, prose is generated lazily

**Status:** accepted (F11, F12, F14); historical invalidation amended by ADR 0004

## Decision

`GET /api/v2/periods/:id` answers for a week, month, quarter or year with a
**skeleton** — edition count, article count, per-category counts, and a timeline
with one entry per day in the range — plus `prose` and a `proseStatus` of
`ready | pending | none`.

The prose is generated **lazily on first view of a closed period**, from that
period's **headlines only**, and stored in its own `periodProse` collection. A
late historical filing invalidates the affected period prose as recorded in ADR
0004. The generator is OpenRouter's chat completions endpoint, with both
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

**A cron or a queue for generation.** Historical writes invalidate the affected
stored prose synchronously; regeneration remains lazy and off the request path.

**A separate rate limiter for the generator.** Only closed periods generate and
each generation lifecycle retains the existing three-attempt cap. Late filings
can begin a new lifecycle by invalidating obsolete prose.

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

**The response never waits on the model.** The first implementation of this ADR
contradicted the ADR: it awaited the call inline, with a 90-second timeout, so a
first view of a closed period could time out at the gateway and return no
skeleton — the exact alternative rejected above. Generation now runs after the
response. The first view of a closed period gets the skeleton and
`proseStatus: "pending"`; a later view gets the summary.

That makes the cache header part of the contract: historical filings mean even
a settled period can change, so period responses cache for five minutes rather
than a day.

Generation is claimed, not merely attempted: `periodProse.periodId` carries a
unique index, and the claim counts attempts and gives up after three. Without
that cap a period the model cannot summarise is retried on every view for ever,
which is the one way the immutability-as-rate-limit argument above can be
defeated. The claim bounds spend rather than serialising perfectly — two requests
in the same instant can both claim — which is a fair trade against a lease that
has to expire correctly, for something that happens once per period.

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
