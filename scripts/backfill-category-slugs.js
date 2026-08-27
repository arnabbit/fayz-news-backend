#!/usr/bin/env node
/**
 * One-off backfill: normalise every article's `category` to a lowercase slug.
 *
 *   node scripts/backfill-category-slugs.js            # dry run, writes nothing
 *   node scripts/backfill-category-slugs.js --apply    # write, after a JSON backup
 *
 * Categories were stored Title-cased ('Politics') while the nav spoke lowercase
 * slugs, and a case-insensitive regex in the article filter papered over the
 * gap. What that hid: `Education` sits outside CATEGORY_ORDER, so it was
 * filtered out of the nav entirely and its one article was reachable only under
 * `home`. v2 appends unknown slugs after the canonical order instead of
 * dropping them, and this makes the stored value agree with the wire.
 *
 * Unlike the two id backfills, this one cannot change identity:
 * `computeArticleId()` hashes `sourcePosts[].postUrl`, `headline` and `dateKey`
 * — never `category`. So there is no collision analysis to do here, and no
 * third id migration.
 *
 * Safe to re-run: slugifyCategory() is idempotent, so a second run is a no-op.
 */
require('dotenv').config(); // run from the repo root, same as server.js
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { slugifyCategory, CATEGORY_ORDER, categoryName } = require('../categories');
const { editionDateKey } = require('../editionDate');

const APPLY = process.argv.includes('--apply');
const MONGODB_URI = process.env.MONGODB_URI;
const KNOWN = new Set(CATEGORY_ORDER);

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI not set');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const articles = client.db(process.env.MONGODB_DB || 'fayznews').collection('articles');

  const before = await articles.countDocuments({});
  console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`documents before: ${before}`);

  const docs = await articles
    .find({}, { projection: { _id: 1, id: 1, category: 1, headline: 1 } })
    .toArray();

  // ---- report, grouped by the transition rather than by document ----
  const moves = new Map(); // `${from} -> ${to}` -> count
  const changing = [];
  const emptied = [];
  for (const doc of docs) {
    const from = String(doc.category == null ? '' : doc.category);
    const to = slugifyCategory(from);
    if (!to) {
      emptied.push(doc);
      continue;
    }
    if (to === from) continue;
    changing.push({ doc, to });
    const key = `${JSON.stringify(from)} -> ${to}`;
    moves.set(key, (moves.get(key) || 0) + 1);
  }

  console.log(`\ndocuments changing category: ${changing.length}`);
  for (const [move, count] of [...moves.entries()].sort()) {
    console.log(`  ${move}  x${count}`);
  }

  // A slug outside CATEGORY_ORDER is not an error — v2 title-cases it and
  // appends it after the canonical order. Reported because it is the thing the
  // old nav silently swallowed.
  const slugs = new Map();
  for (const doc of docs) {
    const slug = slugifyCategory(doc.category);
    if (slug) slugs.set(slug, (slugs.get(slug) || 0) + 1);
  }
  const unknown = [...slugs.entries()].filter(([slug]) => !KNOWN.has(slug)).sort();
  console.log(`\ndistinct slugs after: ${slugs.size}`);
  console.log(`outside CATEGORY_ORDER (visible in v2, appended last): ${unknown.length}`);
  for (const [slug, count] of unknown) {
    console.log(`  ${slug} ("${categoryName(slug)}") x${count}`);
  }

  if (emptied.length > 0) {
    console.log(`\ncategory slugifies to nothing — left untouched: ${emptied.length}`);
    for (const doc of emptied.slice(0, 20)) {
      console.log(`  _id=${doc._id} category=${JSON.stringify(doc.category)}`);
    }
    if (emptied.length > 20) console.log(`  ... and ${emptied.length - 20} more`);
  }

  if (!APPLY) {
    console.log('\ndry run: nothing written. Re-run with --apply to write.');
    await client.close();
    return;
  }

  if (changing.length === 0) {
    console.log('\nnothing to write; every category is already a slug.');
    await client.close();
    return;
  }

  // ---- fresh backup before the first write ----
  const backupPath = path.join(
    process.cwd(),
    `backup-articles-${editionDateKey()}-pre-category-backfill.json`
  );
  const full = await articles.find({}).sort({ _createdAt: 1, _id: 1 }).toArray();
  if (full.length !== before) {
    console.error(`backup read ${full.length} documents but the count was ${before} — aborting, the collection is changing under us.`);
    await client.close();
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(backupPath, JSON.stringify(full, null, 1), 'utf8');
  console.log(`\nbackup written: ${backupPath} (${full.length} documents)`);

  const result = await articles.bulkWrite(
    changing.map(({ doc, to }) => ({
      updateOne: { filter: { _id: doc._id }, update: { $set: { category: to } } },
    })),
    { ordered: false }
  );
  console.log(`documents modified: ${result.modifiedCount} (of ${changing.length} updates issued)`);

  // ---- verification, read back from the database ----
  const after = await articles.countDocuments({});
  const verify = await articles.find({}, { projection: { _id: 1, category: 1 } }).toArray();
  const stillOff = verify.filter(d => {
    const slug = slugifyCategory(d.category);
    return slug && slug !== d.category;
  });

  console.log(`\ndocuments after:  ${after} (${after === before ? 'unchanged — no documents lost' : 'MISMATCH'})`);
  console.log(`rows still not slugs: ${stillOff.length}`);
  for (const d of stillOff.slice(0, 20)) {
    console.log(`  _id=${d._id} category=${JSON.stringify(d.category)}`);
  }

  const clean = after === before && stillOff.length === 0;
  console.log(clean ? '\nOK — every category is now a slug.' : '\nNOT clean — investigate before serving.');
  if (!clean) process.exitCode = 1;

  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
