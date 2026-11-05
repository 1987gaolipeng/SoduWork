'use strict';
// Metadata only. Every lookup follows path validation and a fresh lstat by the
// store; an entry never grants access to another account or work root.
const entries = new Map();
const LIMIT = 32 * 1024 * 1024;
let bytes = 0;
function signature(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); }
function remove(key) { const item = entries.get(key); if (item) bytes -= item.size; entries.delete(key); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function get(key, stat) {
  const item = entries.get(key);
  if (!item || item.signature !== signature(stat)) { remove(key); return null; }
  entries.delete(key); entries.set(key, item); return item.value;
}
function set(key, stat, value) {
  remove(key);
  if (stat.size > LIMIT) return;
  entries.set(key, { signature: signature(stat), size: stat.size, value: freeze(value) }); bytes += stat.size;
  while (entries.size > 8 || bytes > LIMIT) remove(entries.keys().next().value);
}
module.exports = { get, set, remove, signature };
