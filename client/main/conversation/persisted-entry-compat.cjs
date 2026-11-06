'use strict';

// Read-only aliases for the preceding SoduWork archive format. Never rewrite
// archives or normalize arbitrary prefixes, user text, or unknown schemas.
const aliases = new Map([
  ['sodo.access.policy', 'soduwork.access.policy'],
  ['sodo.access.pending', 'soduwork.access.pending'],
  ['sodo.model.selection', 'soduwork.model.selection'],
  ['sodo.work-entry', 'soduwork.work-entry'],
]);
function canonicalEntry(entry) {
  if (entry?.type !== 'custom' || !aliases.has(entry.customType)) return entry;
  const customType = aliases.get(entry.customType);
  const data = customType.startsWith('soduwork.access.') && entry.data?.schema === 'sodo.access-policy/v1'
    ? { ...entry.data, schema: 'soduwork.access-policy/v1' } : entry.data;
  return { ...entry, customType, data };
}
function entriesOf(manager) { return manager.getEntries().map(canonicalEntry); }
module.exports = { canonicalEntry, entriesOf };
