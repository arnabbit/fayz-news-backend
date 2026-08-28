# 0001 — The collection's one text index slot is spent on search

**Status:** accepted (F08, F09)

## Decision

`articles` carries a single MongoDB `$text` index over `headline` (weight 10),
`body` (1) and `developments.summary` (3). `GET /api/v2/search` queries it and
orders results by `_id` descending — recency — not by `textScore`.

## Alternatives rejected

**Atlas Search.** The usual argument for it is performance, and the whole
searchable corpus here is roughly 700 KB, so that argument is not in play.
`$text` also works on any Atlas tier, which removes a dependency on how the
cluster happens to be provisioned. What is given up is typo tolerance, and that
is recoverable: swapping in Atlas Search later changes the query, not the wire
contract.

**Client-side search.** Would require shipping the archive to every device.

**Indexing `sourcePosts`.** Rejected on principle rather than on cost. Those are
other outlets' headlines, kept for audit; matching them would surface an article
for words the article itself never says.

**Ranking by `textScore`.** `$text` scores on term frequency normalised by
document length, and over 83-word digests that is statistical noise dressed as
relevance. In a newspaper archive, someone searching a running story almost
always wants the most recent mention. It would also mean paginating on a
computed float where every other v2 endpoint paginates on `_id`.

## Correction — the slot was never free

An earlier revision of this ADR said `articles` carried only `{_dateKey, _id}`
and `{_dateKey, category, _id}`, "so the slot is free". **That was wrong**, and it
was wrong about production rather than about the code: the deployed collection
already carried a text index named `article_archive_text`, over

```
body(1)  category(1)  developments.summary(1)  headline(1)  sourcePosts.sourceHeadline(1)
```

created outside this repository and recorded nowhere in it. So the first deploy
of the search work could not build `article_text`, and — because `$text` uses
whichever text index exists — **search has been answering against that index
instead.** Two consequences were live in production and reported as verified when
they were not:

- **`sourcePosts.sourceHeadline` is searched**, so an article matches words only
  its *sources* say. The criterion "matching a word that appears only in
  `sourcePosts` returns nothing" held locally and failed in production.
- **`category` is searched**, so every article in a section matches that
  section's name. Confirmed against the live API: a search for `entertainment`
  returns an article whose headline, body and developments never use the word.

Weights are the harmless half of the difference. This endpoint sorts by `_id`
descending and never reads `textScore`, so the flat weights change nothing about
what order results come back in — only which documents match at all.

`scripts/replace-text-index.js` reports the discrepancy and, with `--apply`,
drops the old index and builds the specified one. It is deliberately a script
rather than something `connectDB` does at boot: dropping an index somebody else
created should be a decision, not a side effect of a deploy.

The lesson worth keeping is not about indexes. **The ADR asserted a fact about a
database it had not read**, and the assertion then justified leaving the create
call unguarded, which took the whole API down on the first deploy that met
reality.

## Consequences

**MongoDB allows exactly one text index per collection, and this is it.** Read
this before adding an index to `articles`:

1. `$text` queries every indexed field at once, so a **headline-only search mode
   is impossible** without dropping and rebuilding this index.
2. **Nothing else on `articles` can ever have its own text index.** Anything
   future that wants one must share this index or live in its own collection.
   Period prose is the likeliest candidate, and does live in its own collection
   (`periodProse`) for exactly this reason.

`$text` combined with `sort: {_id: -1}` cannot use an index for the sort, so
Mongo sorts in memory. Verified rather than assumed: the limit is 32 MB against
a corpus of roughly 700 KB.

No rate limiter is added. A `$text` query against an index this size is
microseconds; the query length bounds (2–100 characters) are validation, not
throttling.
