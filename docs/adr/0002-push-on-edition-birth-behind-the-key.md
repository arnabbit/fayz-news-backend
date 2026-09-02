# 0002 — Push: registration is open, sending is behind the key

**Status:** accepted (F04, F06, F07)

## Decision

`POST /api/v2/push/tokens` is **unauthenticated**. Sending is gated on
`REQUIRE_PUSH_KEY`, the same flag that closes `POST /api/articles` to
unauthenticated writes.

A notification is sent when the **current IST edition is born** —
`countDocuments` on the date key, evaluated *before* the write, returning zero —
inline and fire-and-forget after the response. Historical edition births are
silent as recorded in ADR 0004. Title is the paper's name; body is `<Weekday>'s
edition — N articles`, with the weekday derived from the date key's digits in
IST and N excluding hidden articles. The payload is
`{edition: "YYYY-MM-DD"}` and nothing else: no article id, no URL.

Tokens are pruned on two signals, both inline on that same request: a
ticket-level `DeviceNotRegistered` in the send response, and `lastSeen` older
than ninety days.

## Alternatives rejected

**Authenticating registration.** A device has no credential to present, and
`X-Chronicle-Key` lives in extension source — putting it in a public APK would
weaken the one thing it protects. Because the upsert is on `token`, the worst a
spammer achieves is rows the ninety-day sweep removes.

**Sending during the unauthenticated write phase.** A spurious article is one
bad row in a list; a spurious push is a notification on every reader's phone.
While the write endpoint accepts unauthenticated pushes, anyone who found the
URL could wake every device. Gating the sender on the same flag makes the
cutover one switch rather than a checklist item somebody has to remember.

**"Did anything upsert" as the trigger.** It would fire again on every same-day
re-push.

**Naming a headline in the notification.** Article order is
newest-inserted-first, which is arbitrary — there is no importance signal in the
data — so naming one would present a random story as *the* story of the day,
every day.

**Fetching receipts to prune.** The tempting scheme was to store today's ticket
ids and read receipts on the *next* edition's POST, since the dyno is awake then
and Expo retains receipts for 24 hours. **The publishing cadence kills it:**
editions average roughly one every four days, so the next POST is usually well
past retention and the scheme would silently never prune.

**A cron job or a queue.** The free dyno sleeps. The push POST is the one moment
this process is provably awake, holding exactly the facts needed.

## Consequences

A re-push that adds forty genuinely new stories to an existing edition sends
nothing. Tolerable only because the app revalidates `latest` on a five-minute
stale time.

A tap lands inside that five-minute window while the dyno is still warm — the
one notification-driven request in the app that will not hit a cold start.

Sends are unretried. A failure is logged and dropped; the edition is published
either way.

The registry stores exactly `{token, platform, appVersion, updateId, createdAt,
lastSeen}`. No user id, no device id, nothing joinable to a person. The token is
the sole server-side per-device record.
