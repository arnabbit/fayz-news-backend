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
filed into, chosen explicitly by the publisher or defaulted to the current IST
date. Set once on insert, so a re-push updates a story without moving it.

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
accumulating editions. **Closed period** — one whose last day has passed. It is
normally settled but can still change: its story grows through the grace
window, and a late article filed into one of its editions is new evidence for
it.

**Empty period** — a valid, in-range period containing no editions. The
commonest answer, not a failure. Distinct from a period outside the year bounds,
which does not resolve at all.

## A period view

**Skeleton** — the deterministic half: edition count, article count,
per-category counts, and the day-by-day timeline. Always present, always
truthful, computable retroactively.

**Thread** — one running story across editions ("the ceasefire talks"). Global
and shared by every period, so a week and a year agree on what one story is.
Every article belongs to exactly one.

**Important story** — a thread that passes four checks inside a given period:
**verified**, **material change**, **consequences** and **lasting**. Judged over
the period's evidence to date, never within one day, and against that period's
own range, so a story can be important in its week and not in its year.

**Period story** — the growing article for one period, telling only its
important stories. It grows at the end, one section at a time; what is already
written stays as written. The screen never waits for it.

**Section** — one dated part of a period story, written by one run for one
edition date. Frozen once its date has passed; only a section dated today can
still be rewritten. A run that finds nothing important writes no section.

**Entry** — one item in a section. **New**: an important story told for the
first time, from its start in the period. **Update**: only what is new in an
admitted story since its last entry. **Correction**: what an earlier entry got
wrong, appended; the earlier text is not edited.

**Admitted** — a thread that has a new entry in a period story. Only an
admitted thread gets updates or corrections. Admission is per period.

**Grace window** — the 3 days after a period's last day. Editions inside it are
evidence for the period and can still admit stories that happened inside it;
they are never cited, and a run inside it only admits.

**Ranking** — the story order is the ranking. Sections read by date, and entries
within a section in the editor's order of importance. A period view has no
headline list and nothing re-sorts the story downstream: the order it is stored
in is the order it means.

## Registration and sending

**Push registry** — the `pushTokens` collection. One row per device, holding the
token and the two version axes and nothing joinable to a person.

**Version axes** — `appVersion`, the native build, and `updateId`, the JS bundle
running on top of it. Two installs on the same `appVersion` can be running
different JS.

**Edition birth** — the first time a date key is seen. A birth for the current
IST date is the one occasion a notification is sent; a historical birth and a
same-day re-push are silent.

## Availability

**Backend surface** — whether an endpoint exists to call yet. A fact about this
deployment, and the app has a module of exactly these flags.

**Capability** — whether a *platform* can do a thing. A fact about a device.
The two are separate and are never conflated.
