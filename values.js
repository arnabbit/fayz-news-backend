// Reading a value that may be missing or of the wrong type, from a stored
// document or a model reply alike. Pure.

// A trimmed string, or '' for anything that is not a string.
const clean = value => (typeof value === 'string' ? value.trim() : '');
// The array itself, or [] for anything that is not an array.
const list = value => (Array.isArray(value) ? value : []);

module.exports = { clean, list };
