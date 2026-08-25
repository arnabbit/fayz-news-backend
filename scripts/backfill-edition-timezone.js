#!/usr/bin/env node
/**
 * One-off backfill: re-derive every article's edition from its `_createdAt`
 * interpreted in Asia/Kolkata instead of in server-local (UTC) time.
 *
 *   node scripts/backfill-edition-timezone.js            # dry run, writes nothing
 *   node scripts/backfill-edition-timezone.js --apply    # write, after a JSON backup
 *
 * `todayISO()` / `todayStr()` used to read the day off the host clock, and
 * Render runs UTC. Pushes cluster at 18:00-20:00 UTC = 23:30-01:30 IST, so
 * late-night stories were filed under the previous day. Fixed in editionDate.js;
 * this script repairs the rows already written.
 *
 * `_dateKey` is part of the article id hash (see articleId.js), so every
 * document that changes edition also changes identity, and `id` is recomputed
 * in the same pass with the very same helpers the POST handler uses. Re-dating
 * can also drop a story into an edition that already holds a different story on
 * the same base id, so the headline-qualification rule is applied here too: the
 * oldest story on a base id keeps it, later distinct stories are qualified.
 * Same base id AND same normalized headline is a genuine duplicate — the script
 * refuses to write rather than collapse two rows into one.
 *
 * Safe to re-run: the derivation is a pure function of `_createdAt`, so a second
 * run is a no-op.
 */
require('dotenv').config(); // run from the repo root, same as server.js
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { computeArticleId, qualifyArticleId, normalizeHeadline } = require('../articleId');
const { EDITION_TIME_ZONE, editionDateKey, editionDateLabel } = require('../editionDate');

const APPLY = process.argv.includes('--apply');
const MONGODB_URI = process.env.MONGODB_URI;

// An edition's composition is *which* documents it holds, not how many, so the
// comparison is between member sets and not between counts.
function editionDiff(before, after) {
  const group = rows => {
    const map = new Map();
    for (const [docId, dateKey] of rows) {
      if (!map.has(dateKey)) map.set(dateKey, new Set());
      map.get(dateKey).add(docId);
    }
    return map;
  };
  const was = group(before);
  const now = group(after);
  const changed = [];
  for (const dateKey of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(dateKey) || new Set();
    const b = now.get(dateKey) || new Set();
    const gained = [...b].filter(docId => !a.has(docId)).length;
    const lost = [...a].filter(docId => !b.has(docId)).length;
    if (gained || lost) changed.push({ dateKey, before: a.size, after: b.size, gained, lost });
  }
  changed.sort((x, y) => x.dateKey.localeCompare(y.dateKey));
  return changed;
}

function usableDate(value) {
  return value instanceof Date && !isNaN(value.getTime());
}

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI not set');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const articles = client.db(process.env.MONGODB_DB || 'fayznews').collection('articles');

  const before = await articles.countDocuments({});
  console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`timezone: ${EDITION_TIME_ZONE}`);
  console.log(`documents before: ${before}`);

  const projection = {
    _id: 1, id: 1, headline: 1, sourcePosts: 1,
    _dateKey: 1, published_date: 1, _createdAt: 1
  };

  // Oldest first, so a base id shared by several stories is claimed in the same
  // order the earlier id backfill claimed it — unaffected editions keep exactly
  // the ids they already have.
  const docs = await articles.find({}, { projection })
    .sort({ _createdAt: 1, _id: 1 })
    .toArray();

  const undated = docs.filter(d => !usableDate(d._createdAt));
  if (undated.length > 0) {
    console.log(`\nno usable _createdAt — left untouched: ${undated.length}`);
    for (const d of undated) console.log(`  _id=${d._id} _dateKey=${d._dateKey}`);
  }

  // ---- pass 1: re-derive each edition from _createdAt in IST ----
  const plan = new Map(); // String(_id) -> entry
  const baseGroups = new Map(); // baseId -> [entry, ...], oldest first
  for (const doc of docs) {
    if (!usableDate(doc._createdAt)) continue;
    const dateKey = editionDateKey(doc._createdAt);
    const entry = {
      doc,
      dateKey,
      publishedDate: editionDateLabel(doc._createdAt),
      baseId: computeArticleId(doc, dateKey),
      finalId: null
    };
    plan.set(String(doc._id), entry);
    if (!baseGroups.has(entry.baseId)) baseGroups.set(entry.baseId, []);
    baseGroups.get(entry.baseId).push(entry);
  }

  // ---- pass 2: assign ids the way POST /api/articles assigns them ----
  const qualified = [];
  const duplicates = [];
  for (const [baseId, group] of baseGroups.entries()) {
    const owners = new Map(); // normalized headline -> finalId
    for (const entry of group) {
      const headline = normalizeHeadline(entry.doc.headline);
      if (owners.has(headline)) {
        entry.finalId = owners.get(headline);
        duplicates.push(entry);
      } else if (owners.size === 0) {
        entry.finalId = baseId;
        owners.set(headline, entry.finalId);
      } else {
        entry.finalId = qualifyArticleId(baseId, entry.doc.headline);
        owners.set(headline, entry.finalId);
        qualified.push(entry);
      }
    }
  }

  // ---- report ----
  const entries = [...plan.values()];
  const reDated = entries.filter(e => e.dateKey !== e.doc._dateKey);
  const rePublished = entries.filter(e => e.publishedDate !== e.doc.published_date);
  const reIded = entries.filter(e => e.finalId !== e.doc.id);
  const editionsChanged = editionDiff(
    docs.map(d => [String(d._id), d._dateKey]),
    docs.map(d => {
      const entry = plan.get(String(d._id));
      return [String(d._id), entry ? entry.dateKey : d._dateKey];
    })
  );

  console.log(`\n_dateKey changes:       ${reDated.length}`);
  console.log(`published_date changes: ${rePublished.length}`);
  console.log(`id changes:             ${reIded.length}`);
  console.log(`headline-qualified ids: ${qualified.length}`);
  console.log(`true duplicates:        ${duplicates.length}`);
  console.log(`editions changing composition: ${editionsChanged.length}`);
  for (const e of editionsChanged) {
    console.log(`  ${e.dateKey}: ${e.before} -> ${e.after} docs (+${e.gained} / -${e.lost})`);
  }

  // A base id group holding both a moved and an unmoved story is the case the
  // qualification rule exists for: re-dating pushed a story into an edition
  // another story already occupied.
  const mixed = [...baseGroups.values()].filter(g =>
    g.length > 1 &&
    g.some(e => e.dateKey !== e.doc._dateKey) &&
    g.some(e => e.dateKey === e.doc._dateKey)
  );
  console.log(`base ids mixing moved + unmoved stories: ${mixed.length}`);
  for (const group of mixed) {
    console.log(`  base ${group[0].baseId} in ${group[0].dateKey}`);
    for (const e of group) {
      const origin = e.dateKey !== e.doc._dateKey ? `moved from ${e.doc._dateKey}` : 'already there';
      console.log(`    ${e.finalId} (${origin}) ${JSON.stringify(e.doc.headline)}`);
    }
  }
  for (const e of qualified.slice(0, 40)) {
    console.log(`  qualified ${e.baseId} -> ${e.finalId}  ${e.dateKey} ${JSON.stringify(e.doc.headline)}`);
  }
  if (qualified.length > 40) console.log(`  ... and ${qualified.length - 40} more`);
  for (const e of duplicates) {
    console.log(`  DUP ${e.finalId} ${e.dateKey} _id=${e.doc._id} ${JSON.stringify(e.doc.headline)}`);
  }

  // ---- collision checks, before a single write ----
  const finalIds = new Map(); // finalId -> [String(_id), ...]
  const claim = (id, docId) => {
    if (!finalIds.has(id)) finalIds.set(id, []);
    finalIds.get(id).push(docId);
  };
  for (const e of entries) claim(e.finalId, String(e.doc._id));
  // Untouched rows still occupy their id, and the unique index is collection-wide.
  for (const d of undated) claim(d.id, String(d._id));
  const collisions = [...finalIds.entries()].filter(([, ids]) => ids.length > 1);

  // The unique index rejects intermediate states too: writing A's new id fails
  // while B still holds it. Detect that overlap up front rather than half way
  // through a bulkWrite.
  const oldIdOwner = new Map(docs.map(d => [d.id, String(d._id)]));
  const transient = entries.filter(e => {
    if (e.finalId === e.doc.id) return false;
    const owner = oldIdOwner.get(e.finalId);
    return owner !== undefined && owner !== String(e.doc._id);
  });

  console.log(`\nid collisions (two documents on one final id): ${collisions.length}`);
  for (const [id, ids] of collisions) console.log(`  ${id} <- ${ids.join(', ')}`);
  console.log(`transient collisions (new id still held by another doc): ${transient.length}`);
  for (const e of transient) {
    console.log(`  ${e.finalId} wanted by _id=${e.doc._id}, held by _id=${oldIdOwner.get(e.finalId)}`);
  }

  if (!APPLY) {
    console.log('\ndry run: nothing written. Re-run with --apply to write.');
    await client.close();
    return;
  }

  if (duplicates.length > 0 || collisions.length > 0 || transient.length > 0) {
    console.error('\nrefusing to apply: id collisions present. Resolve them first — writing would overwrite a story.');
    await client.close();
    process.exitCode = 1;
    return;
  }

  // ---- fresh backup before the first write ----
  const backupPath = path.join(process.cwd(), `backup-articles-${editionDateKey()}-pre-tz-backfill.json`);
  const full = await articles.find({}).sort({ _createdAt: 1, _id: 1 }).toArray();
  if (full.length !== before) {
    console.error(`backup read ${full.length} documents but the count was ${before} — aborting, the collection is changing under us.`);
    await client.close();
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(backupPath, JSON.stringify(full, null, 1), 'utf8');
  console.log(`\nbackup written: ${backupPath} (${full.length} documents)`);

  const ops = [];
  for (const e of entries) {
    const set = {};
    if (e.dateKey !== e.doc._dateKey) set._dateKey = e.dateKey;
    if (e.publishedDate !== e.doc.published_date) set.published_date = e.publishedDate;
    if (e.finalId !== e.doc.id) set.id = e.finalId;
    if (Object.keys(set).length === 0) continue;
    ops.push({ updateOne: { filter: { _id: e.doc._id }, update: { $set: set } } });
  }

  if (ops.length === 0) {
    console.log('nothing to write; every edition is already IST-derived.');
  } else {
    const result = await articles.bulkWrite(ops, { ordered: false });
    console.log(`documents modified: ${result.modifiedCount} (of ${ops.length} updates issued)`);
  }

  // ---- verification, read back from the database ----
  const after = await articles.countDocuments({});
  const dupAgg = await articles.aggregate([
    { $group: { _id: '$id', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }
  ]).toArray();
  const missingId = await articles.countDocuments({ id: { $in: [null, ''] } });

  const verify = await articles.find({}, { projection }).toArray();
  const stillOff = verify.filter(d =>
    usableDate(d._createdAt) &&
    (d._dateKey !== editionDateKey(d._createdAt) || d.published_date !== editionDateLabel(d._createdAt))
  );
  const unexpectedId = verify.filter(d => {
    const entry = plan.get(String(d._id));
    return entry && d.id !== entry.finalId;
  });

  console.log(`\ndocuments after:  ${after} (${after === before ? 'unchanged — no documents lost' : 'MISMATCH'})`);
  console.log(`duplicate ids:    ${dupAgg.length}`);
  for (const d of dupAgg) console.log(`  ${d._id} x${d.n}`);
  console.log(`missing/empty id: ${missingId}`);
  console.log(`rows still off-timezone:    ${stillOff.length}`);
  console.log(`rows with an unexpected id: ${unexpectedId.length}`);

  const clean = after === before && dupAgg.length === 0 && missingId === 0 &&
    stillOff.length === 0 && unexpectedId.length === 0;
  console.log(clean ? '\nOK — every edition is now IST-derived.' : '\nNOT clean — investigate before serving.');
  if (!clean) process.exitCode = 1;

  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
