# 0004 — Explicit historical edition filing invalidates derived views

**Status:** accepted; amended by ADR 0005 — a late filing invalidates nothing

`POST /api/articles` accepts an optional, non-future IST `date` so the publisher
can file delayed Instagram posts into the edition in which they were published;
omitting it remains today's edition for compatibility. Historical filing is
preferred over assigning delayed work to ingestion day, despite making past
editions mutable: the backend therefore invalidates prose for the containing
week, month, quarter and year, gives edition and period responses a five-minute
cache window, selects `latest` by date key rather than insertion time, and sends
no notification for a historical edition.

## Amendment — ADR 0005

There is no prose left to invalidate. A late historical filing is now **new
evidence** for every period that contains it, and invalidates nothing: the next
open of such a period reads it, any section that run writes is appended at the
end, dated today, and every earlier section stays as written. `POST /api/articles` does nothing about period stories. The
five-minute cache window, the `latest` selection and the silent historical
edition stand.
