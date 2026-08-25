#!/usr/bin/env node
/**
 * One-off backfill: recompute `id` for every existing article using the
 * content-derived scheme in ../articleId.js (was crypto.randomBytes).
 *
 *   node scripts/backfill-article-ids.js            # dry run, writes nothing
 *   node scripts/backfill-article-ids.js --apply    # write the new ids
 *
 * Dry run reports: document count, how many ids change, and every collision
 * (two or more documents computing the same id). Collisions are duplicate
 * stories; --apply refuses to run while any exist unless --allow-collisions is
 * passed, in which case the oldest document of each colliding group keeps the
 * computed id and the rest are left untouched and listed for manual review.
 */
require('dotenv').config(); // run from the repo root, same as server.js
const { MongoClient } = require('mongodb');
const { computeArticleId } = require('../articleId');

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

  const groups = new Map(); // newId -> [doc, ...] in oldest-first order
  let unchanged = 0;
  let noSourcePosts = 0;

  for (const doc of docs) {
    const newId = computeArticleId(doc, doc._dateKey);
    if (!Array.isArray(doc.sourcePosts) || doc.sourcePosts.length === 0) noSourcePosts++;
    if (doc.id === newId) unchanged++;
    if (!groups.has(newId)) groups.set(newId, []);
    groups.get(newId).push(doc);
  }

  const collisions = Array.from(groups.entries()).filter(([, list]) => list.length > 1);

  console.log(`distinct computed ids: ${groups.size}`);
  console.log(`ids already correct:   ${unchanged}`);
  console.log(`fallback (no sourcePosts): ${noSourcePosts}`);
  console.log(`collisions: ${collisions.length}`);

  for (const [newId, list] of collisions) {
    console.log(`  ${newId} <- ${list.length} docs:`);
    for (const d of list) {
      console.log(`     _id=${d._id} date=${d._dateKey} headline=${JSON.stringify(d.headline)}`);
    }
  }

  if (!APPLY) {
    console.log('\ndry run: nothing written. Re-run with --apply to write.');
    await client.close();
    return;
  }

  if (collisions.length > 0 && !ALLOW_COLLISIONS) {
    console.error('\nrefusing to apply: collisions present. Resolve them, or pass --allow-collisions.');
    await client.close();
    process.exitCode = 1;
    return;
  }

  const ops = [];
  const skipped = [];
  for (const [newId, list] of groups.entries()) {
    const [keeper, ...rest] = list;
    if (keeper.id !== newId) {
      ops.push({ updateOne: { filter: { _id: keeper._id }, update: { $set: { id: newId } } } });
    }
    for (const dup of rest) skipped.push({ _id: dup._id, wouldBe: newId, id: dup.id });
  }

  if (ops.length > 0) {
    const result = await articles.bulkWrite(ops, { ordered: false });
    console.log(`\nmodified: ${result.modifiedCount}`);
  } else {
    console.log('\nnothing to write; all ids already correct.');
  }

  if (skipped.length > 0) {
    console.log(`left untouched (colliding duplicates, review manually): ${skipped.length}`);
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
