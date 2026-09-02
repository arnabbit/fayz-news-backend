# 0004 — Explicit historical edition filing invalidates derived views

**Status:** accepted

`POST /api/articles` accepts an optional, non-future IST `date` so the publisher
can file delayed Instagram posts into the edition in which they were published;
omitting it remains today's edition for compatibility. Historical filing is
preferred over assigning delayed work to ingestion day, despite making past
editions mutable: the backend therefore invalidates prose for the containing
week, month, quarter and year, gives edition and period responses a five-minute
cache window, selects `latest` by date key rather than insertion time, and sends
no notification for a historical edition.
