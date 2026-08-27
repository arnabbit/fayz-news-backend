// Category is a lowercase slug on disk and on the wire.
//
// It used to be stored Title-cased ('Politics') while the nav spoke lowercase
// slugs, and a case-insensitive regex papered over the gap. What that hid:
// `Education` sat outside CATEGORY_ORDER, so it was filtered out of the nav
// entirely and its one article was reachable only under `home`. Unknown slugs
// are now title-cased and appended rather than dropped — a new LLM category is
// visible the day it appears.
//
// Safe to normalise the stored value because `category` is not part of the id
// hash (see articleId.js), so no third id migration.

const CATEGORY_ORDER = [
  'home', 'politics', 'world', 'sports', 'economy',
  'technology', 'entertainment', 'science', 'health', 'legal', 'environment',
];

const CATEGORY_NAMES = {
  home: 'Home', politics: 'Politics', world: 'World', sports: 'Sports',
  economy: 'Economy', technology: 'Technology', entertainment: 'Entertainment',
  science: 'Science', health: 'Health', legal: 'Legal', environment: 'Environment',
};

const KNOWN = new Set(CATEGORY_ORDER);

function slugifyCategory(value) {
  const slug = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug;
}

// The display name for a slug. Unknown slugs are title-cased, which is exactly
// what the client does as its own fallback — the two must agree or a category
// renders differently depending on which of them named it.
function categoryName(slug) {
  if (CATEGORY_NAMES[slug]) return CATEGORY_NAMES[slug];
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// `home` is server-injected and first, always. The client must not special-case
// it: it is a slug like any other, and it simply carries no filter.
function editionCategories(slugs) {
  const found = new Set();
  for (const value of slugs || []) {
    const slug = slugifyCategory(value);
    if (slug && slug !== 'home') found.add(slug);
  }
  const known = CATEGORY_ORDER.filter(slug => slug !== 'home' && found.has(slug));
  const unknown = [...found].filter(slug => !KNOWN.has(slug)).sort();
  return ['home', ...known, ...unknown].map(slug => ({ slug, name: categoryName(slug) }));
}

module.exports = {
  CATEGORY_ORDER,
  CATEGORY_NAMES,
  slugifyCategory,
  categoryName,
  editionCategories,
};
