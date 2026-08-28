// The push registry's shape rules, kept pure so they are testable without a
// database or a device.
//
// Registration is open and sending is behind the key, and the asymmetry is
// deliberate: a device has no credential to present, and `X-Chronicle-Key`
// lives in extension source, so putting it in a public APK would weaken the one
// thing it protects. Because the upsert is on `token`, the worst a spammer
// achieves is rows that the ninety-day sweep removes.

// `ExponentPushToken[...]` is the only form the app can produce. The inner
// segment is opaque — Expo does not document its alphabet, so it is checked for
// being non-empty and bracket-free rather than for a shape that could change.
const EXPO_PUSH_TOKEN = /^ExponentPushToken\[[^\[\]\s]+\]$/;

function isExpoPushToken(value) {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value.trim());
}

// A short, optional string field. Absent, null, a number and an empty string
// all become '' — a build with no update channel sends nothing for `updateId`,
// and that must register successfully rather than fail validation.
function optionalString(value, cap = 120) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, cap);
}

// Exactly six fields, and no seventh. There is no user id, no device id and
// nothing joinable to a person: the token is the sole server-side per-device
// record, and this function is where that promise is actually kept.
//
// `createdAt` is returned separately from the rest because it belongs in
// `$setOnInsert` — a re-registration must not rewrite the day the device first
// appeared.
function pushTokenDocument(body, now) {
  const token = String((body && body.token) || '').trim();
  if (!isExpoPushToken(token)) return null;
  return {
    token,
    // Android is the only platform that ships; the field is stored as sent so
    // an iOS build later is a data question rather than a migration.
    platform: optionalString(body.platform, 16) || 'android',
    // The native build.
    appVersion: optionalString(body.appVersion),
    // The JS bundle. Two installs on the same appVersion can be running
    // completely different JS, so this is a second axis, not a detail.
    updateId: optionalString(body.updateId),
    lastSeen: now,
    createdAt: now,
  };
}

// Ninety days of silence. The app re-POSTs on every launch, so a token that has
// not been seen in three months belongs to an install that is gone or to a
// reader who has stopped opening the paper; either way a notification to it is
// undeliverable or unwanted.
const STALE_TOKEN_DAYS = 90;

function staleTokenCutoff(now) {
  return new Date(now.getTime() - STALE_TOKEN_DAYS * 24 * 60 * 60 * 1000);
}

module.exports = {
  EXPO_PUSH_TOKEN,
  STALE_TOKEN_DAYS,
  isExpoPushToken,
  pushTokenDocument,
  staleTokenCutoff,
};
