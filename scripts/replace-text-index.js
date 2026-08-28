// Replaces whatever text index `articles` carries with the one search is
// specified against (docs/adr/0001).
//
//   node scripts/replace-text-index.js            report only, touches nothing
//   node scripts/replace-text-index.js --apply    drop the old, build the new
//
// Why this is a script and not something `connectDB` does at boot: dropping an
// index somebody else created is a deliberate act, and a server that does it
// automatically would do it again on every deploy that raced a rebuild.
//
// It is safe to re-run. It is also reversible — the previous index's definition
// is printed before the drop, so it can be recreated verbatim.

require('dotenv').config();
const { MongoClient } = require('mongodb');

const WANTED_NAME = 'article_text';
const WANTED_KEY = { headline: 'text', body: 'text', 'developments.summary': 'text' };
const WANTED_WEIGHTS = { headline: 10, body: 1, 'developments.summary': 3 };

// The fields ADR 0001 excludes on principle. `sourcePosts` holds *other
// outlets'* headlines, kept for audit — matching them surfaces an article for
// words the article itself never says. `category` makes every article in a
// section match that section's name.
const EXCLUDED = ['sourcePosts', 'category'];

const apply = process.argv.includes('--apply');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Refusing to guess.');
    process.exit(2);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'fayznews');
  const articles = db.collection('articles');

  const indexes = await articles.indexes();
  const text = indexes.filter(index => JSON.stringify(index.key).includes('_fts'));

  console.log(`database: ${db.databaseName}`);
  console.log(`documents: ${await articles.countDocuments({})}`);

  if (text.length === 0) {
    console.log('no text index present.');
  }
  for (const index of text) {
    const fields = Object.keys(index.weights || {});
    const offenders = fields.filter(f => EXCLUDED.some(bad => f === bad || f.startsWith(`${bad}.`)));
    console.log(`\nexisting text index: ${index.name}`);
    console.log(`  fields:  ${fields.map(f => `${f}(${index.weights[f]})`).join(', ')}`);
    if (offenders.length) {
      console.log(`  PROBLEM: searches ${offenders.join(' and ')}, which ADR 0001 excludes.`);
    }
    // Rebuilt from the weights, not from `index.key` — Mongo reports a text
    // index's key as the internal `{_fts, _ftsx}` pair, which createIndex will
    // not take back. The weights are the only faithful record of the fields.
    const spec = Object.fromEntries(fields.map(f => [f, 'text']));
    console.log('  to restore it later:');
    console.log(`    db.articles.createIndex(${JSON.stringify(spec)}, `
      + `${JSON.stringify({ weights: index.weights, name: index.name })})`);
  }

  const already = text.find(index => index.name === WANTED_NAME
    && JSON.stringify(index.weights) === JSON.stringify(
      Object.fromEntries(Object.keys(WANTED_WEIGHTS).sort().map(k => [k, WANTED_WEIGHTS[k]]))));
  if (already) {
    console.log('\nthe wanted index is already in place. Nothing to do.');
    await client.close();
    return;
  }

  console.log(`\nwanted: ${WANTED_NAME}`);
  console.log(`  fields:  ${Object.entries(WANTED_WEIGHTS).map(([f, w]) => `${f}(${w})`).join(', ')}`);

  if (!apply) {
    console.log('\nreport only. Re-run with --apply to drop the existing text index and build this one.');
    console.log('Search returns nothing for a few seconds while the new index builds.');
    await client.close();
    return;
  }

  for (const index of text) {
    console.log(`\ndropping ${index.name} ...`);
    await articles.dropIndex(index.name);
  }
  console.log(`building ${WANTED_NAME} ...`);
  await articles.createIndex(WANTED_KEY, { weights: WANTED_WEIGHTS, name: WANTED_NAME });

  const after = (await articles.indexes()).filter(i => JSON.stringify(i.key).includes('_fts'));
  console.log('\ndone. text indexes now:');
  for (const index of after) {
    console.log(`  ${index.name}: ${Object.keys(index.weights).map(f => `${f}(${index.weights[f]})`).join(', ')}`);
  }

  await client.close();
})().catch(err => {
  console.error('failed:', err.message);
  process.exit(1);
});
