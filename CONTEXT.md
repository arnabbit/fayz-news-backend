# Context

The vocabulary this backend uses. A glossary and nothing else — no
implementation detail, no decisions. Decisions live in `docs/adr/`.

Every term here also appears in the app's own `CONTEXT.md` and means the same
thing on both sides. One system, one vocabulary; when a term changes, it changes
in both files or it has not changed.

## The paper

**Edition** — one day's paper. There is no editions collection: an edition *is*
the set of articles sharing a **date key**, which is why every listing of them
is a `$group`. Addressed by its IST date (`2026-08-27`) or by the sentinel
`latest`.

**Date key** — `_dateKey`, `YYYY-MM-DD` in IST. The edition an article was first
filed into. Set once on insert and never rewritten, so a re-push updates a story
without moving it to another day.

**Article** — one piece in one edition. Its **identity** is derived from its
content and its date key, so an id names fixed content for life. Two stories
that derive the same base id are separated by qualifying the second, which keeps
a retried payload deriving exactly the same ids.

**Hidden** — an article excluded from every read, the one lever for pulling a
bad story. **Withdrawn** is what a reader experiences when an id that used to
resolve now 404s. A hidden article is a 404 and not a tombstone: a tombstone
would confirm the story existed.

**Dek** — the standfirst under a headline. Never null on the wire: the stored
value when there is one, a fallback computed per request when there is not.

**Developments** — the running updates attached to an article.

**Source posts** — the upstream posts a story was assembled from, kept for
audit. Never searched and never summarised: they are other outlets' words.

## Time

**IST** — the paper's timezone, UTC+5:30, fixed, with no daylight saving. Every
date here is an IST calendar date, never a moment. The host is UTC; nothing may
depend on that or on the `TZ` variable.

**Period** — a calendar interval over the archive: a **week** (ISO-8601,
`2026-W35`), a **month** (`2026-08`), a **quarter** (`2026-Q3`) or a **year**
(`2026`). These four are its **kind**. A period always exists as an interval,
whether or not any paper was published inside it.

**Open period** — one whose last day is today or in the future; still
accumulating. **Closed period** — one whose last day has passed. A closed period
can never change, because a new article can never be given a past date key.

**Empty period** — a valid, in-range period containing no editions. The
commonest answer, not a failure. Distinct from a period outside the year bounds,
which does not resolve at all.

## A period view

**Skeleton** — the deterministic half: edition count, article count,
per-category counts, and the day-by-day timeline. Always present, always
truthful, computable retroactively.

**Prose** — the synthesised half: a written retrospective generated once from
the period's headlines when a closed period is first viewed, then stored for
ever. Its three parts are the **lede**, one paragraph **per category**, and the
**fold-in line** covering categories too thin to earn a paragraph.

**Ranking** — prose *is* the ranking. A period view has no headline list and
nothing is re-sorted downstream, because the data cannot supply an ordering and
the generated sentences can. The order prose is stored in is the order it means.

## Registration and sending

**Push registry** — the `pushTokens` collection. One row per device, holding the
token and the two version axes and nothing joinable to a person.

**Version axes** — `appVersion`, the native build, and `updateId`, the JS bundle
running on top of it. Two installs on the same `appVersion` can be running
different JS.

**Edition birth** — the first time a date key is seen. The one occasion a
notification is sent; a same-day re-push is not a birth.

## Availability

**Backend surface** — whether an endpoint exists to call yet. A fact about this
deployment, and the app has a module of exactly these flags.

**Capability** — whether a *platform* can do a thing. A fact about a device.
The two are separate and are never conflated.
