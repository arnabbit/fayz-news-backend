#!/usr/bin/env node
/**
 * One-off backfill: recompute `id` for every existing article using the
 * content-derived scheme in ../articleId.js (was crypto.randomBytes).
 *
 *   node scripts/backfill-article-ids.js            # dry run, writes nothing
 *   node scripts/backfill-article-ids.js --apply    # write the new ids
 *
 * A base id can be claimed by more than one story, because a single roundup
 * reel yields several unrelated articles on the same day. The oldest document
 * of such a group keeps the base id; the rest get a headline-qualified id, the
 * same rule POST /api/articles applies. Only documents that are byte-identical
 * stories (same base id AND same normalized headline) are a true duplicate, and
 * --apply refuses to run if any exist unless --allow-collisions is passed.
 */
require('dotenv').config(); // run from the repo root, same as server.js
const { MongoClient } = require('mongodb');
const { computeArticleId, qualifyArticleId, normalizeHeadline } = require('../articleId');

const APPLY = process.argv.includes('--apply');
const ALLOW_COLLISIONS = process.argv.includes('--allow-collisions');
const MONGODB_URI = process.env.MONGODB_URI;

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI not set');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const articles = client.db(process.env.MONGODB_DB || 'fayznews').collection('articles');

  const before = await articles.countDocuments({});
  console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`documents before: ${before}`);

  const docs = await articles
    .find({}, { projection: { _id: 1, id: 1, headline: 1, sourcePosts: 1, _dateKey: 1, _createdAt: 1 } })
    .sort({ _createdAt: 1, _id: 1 })
    .toArray();

  const baseGroups = new Map(); // baseId -> [doc, ...] in oldest-first order
  let noSourcePosts = 0;

  for (const doc of docs) {
    const baseId = computeArticleId(doc, doc._dateKey);
    if (!Array.isArray(doc.sourcePosts) || doc.sourcePosts.length === 0) noSourcePosts++;
    if (!baseGroups.has(baseId)) baseGroups.set(baseId, []);
    baseGroups.get(baseId).push(doc);
  }

  // Assign final ids: oldest story on a base id keeps it, later distinct
  // stories are headline-qualified. Same base id + same headline is a real
  // duplicate and is reported rather than silently split.
  const assignment = new Map(); // doc._id -> finalId
  const trueDuplicates = [];
  const qualified = [];
  let unchanged = 0;

  for (const [baseId, list] of baseGroups.entries()) {
    const owners = new Map(); // normalized headline -> finalId
    for (const doc of list) {
      const headline = normalizeHeadline(doc.headline);
      let finalId;
      if (owners.has(headline)) {
        finalId = owners.get(headline);
        trueDuplicates.push({ doc, finalId });
      } else if (owners.size === 0) {
        finalId = baseId;
        owners.set(headline, finalId);
      } else {
        finalId = qualifyArticleId(baseId, doc.headline);
        owners.set(headline, finalId);
        qualified.push({ doc, baseId, finalId });
      }
      assignment.set(String(doc._id), finalId);
      if (doc.id === finalId) unchanged++;
    }
  }

  console.log(`distinct base ids: ${baseGroups.size}`);
  console.log(`ids already correct:   ${unchanged}`);
  console.log(`fallback (no sourcePosts): ${noSourcePosts}`);
  console.log(`headline-qualified (shared base id, distinct story): ${qualified.length}`);
  console.log(`true duplicates (same base id AND headline): ${trueDuplicates.length}`);

  for (const q of qualified) {
    console.log(`  base ${q.baseId} -> ${q.finalId}  _id=${q.doc._id} date=${q.doc._dateKey} ${JSON.stringify(q.doc.headline)}`);
  }
  for (const t of trueDuplicates) {
    console.log(`  DUP ${t.finalId}  _id=${t.doc._id} date=${t.doc._dateKey} ${JSON.stringify(t.doc.headline)}`);
  }
  const collisions = trueDuplicates;

  if (!APPLY) {
    console.log('\ndry run: nothing written. Re-run with --apply to write.');
    await client.close();
    return;
  }

  if (collisions.length > 0 && !ALLOW_COLLISIONS) {
    console.error('\nrefusing to apply: true duplicates present. Resolve them, or pass --allow-collisions.');
    await client.close();
    process.exitCode = 1;
    return;
  }

  // True duplicates keep their current id — nothing is merged or deleted; they
  // are listed above for manual review.
  const dupIds = new Set(trueDuplicates.map(t => String(t.doc._id)));
  const ops = [];
  const skipped = [];
  for (const doc of docs) {
    const key = String(doc._id);
    if (dupIds.has(key)) { skipped.push(doc); continue; }
    const finalId = assignment.get(key);
    if (doc.id !== finalId) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { id: finalId } } } });
    }
  }

  if (ops.length > 0) {
    const result = await articles.bulkWrite(ops, { ordered: false });
    console.log(`\nmodified: ${result.modifiedCount}`);
  } else {
    console.log('\nnothing to write; all ids already correct.');
  }

  if (skipped.length > 0) {
    console.log(`left untouched (true duplicates, review manually): ${skipped.length}`);
    for (const s of skipped) console.log(`  _id=${s._id} keeps id=${s.id}`);
  }

  // ---- verification ----
  const after = await articles.countDocuments({});
  const distinctAfter = (await articles.distinct('id')).length;
  const missingId = await articles.countDocuments({ id: { $in: [null, ''] } });
  const dupAgg = await articles.aggregate([
    { $group: { _id: '$id', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }
  ]).toArray();

  console.log(`\ndocuments after:  ${after} (${after === before ? 'unchanged — no documents lost' : 'MISMATCH'})`);
  console.log(`distinct ids:     ${distinctAfter}`);
  console.log(`missing/empty id: ${missingId}`);
  console.log(`duplicate ids:    ${dupAgg.length}`);
  if (dupAgg.length > 0) {
    for (const d of dupAgg) console.log(`  ${d._id} x${d.n}`);
  }

  if (after === before && dupAgg.length === 0 && missingId === 0) {
    console.log('\nOK — safe to create the unique index on `id`.');
  } else {
    console.log('\nNOT clean — do not create the unique index yet.');
    process.exitCode = 1;
  }

  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
