'use strict';

// Only UI transport is bounded. Native receipts, journals and model context
// retain the original values; opening a card retrieves that exact receipt.
const LIMIT = 8 * 1024;
const MARK = '\n…';
// Compute collapsed added/removed line counts from full text with jsdiff.
// Skip exact diff for oversized replacements and report edit counts to bound processing cost.
const DIFF_BUDGET = 256 * 1024;
let DIFF = null;
try { DIFF = require('../../vendor/markdown/diff.min.js'); } catch (_) { DIFF = null; }
function diffLineStat(oldText, newText) {
  if (!DIFF || typeof DIFF.diffLines !== 'function') return null;
  let added = 0, removed = 0;
  DIFF.diffLines(String(oldText || ''), String(newText || '')).forEach((part) => {
    const lines = part.value.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const count = part.count != null ? part.count : lines.length;
    if (part.added) added += count; else if (part.removed) removed += count;
  });
  return { added, removed };
}
// Precompute edit badges before compacting arguments.
// Full source arguments produce accurate counts that truncated renderer projections cannot recover.
function editDiffSummary(args) {
  if (!args || typeof args !== 'object') return null;
  const edits = Array.isArray(args.edits) ? args.edits : null;
  const oldText = typeof args.oldText === 'string' || typeof args.old_string === 'string' ? (args.oldText ?? args.old_string) : null;
  const newText = typeof args.newText === 'string' || typeof args.new_string === 'string' ? (args.newText ?? args.new_string) : null;
  if (!edits && oldText == null && newText == null) return null;
  const parts = edits || [{ oldText, newText }];
  let budget = 0;
  for (const part of parts) {
    budget += (part ? String(part.oldText ?? part.old_string ?? '').length + String(part.newText ?? part.new_string ?? '').length : 0);
  }
  const summary = { editCount: edits ? edits.length : 1 };
  if (budget > DIFF_BUDGET || !DIFF) return summary;
  let added = 0, removed = 0, ok = true;
  for (const part of parts) {
    const stat = diffLineStat(part ? (part.oldText ?? part.old_string ?? '') : '', part ? (part.newText ?? part.new_string ?? '') : '');
    if (!stat) { ok = false; break; }
    added += stat.added; removed += stat.removed;
  }
  if (ok) { summary.added = added; summary.removed = removed; }
  return summary;
}
const cache = new WeakMap();
let revision = 0;
function project(tool) {
  if (!tool || typeof tool !== 'object' || tool.detailsDeferred) return tool;
  const args = tool.args;
  const key = args && typeof args === 'object' ? args : tool;
  const signature = [tool.id, tool.name, tool.state, tool.updatedAt, tool.endedAt,
    tool.result, tool.partial, tool.isError, args?.edits?.length, ...(args && typeof args === 'object' ? Object.entries(args).flat() : [args])];
  const previous = cache.get(key);
  if (previous && signature.length === previous.signature.length &&
      signature.every((value, index) => value === previous.signature[index])) {
    return { ...tool, ...previous.fields };
  }
  let deferred = false, remaining = LIMIT;
  function compact(value, depth = 0) {
    if (typeof value === 'string') {
      const length = Math.min(remaining, LIMIT);
      remaining -= Math.min(value.length, length);
      if (value.length <= length) return value;
      deferred = true; return value.slice(0, length) + MARK;
    }
    if (!value || typeof value !== 'object') return value;
    if (depth >= 6 || remaining <= 0) { deferred = true; return Array.isArray(value) ? [] : {}; }
    const entries = Object.entries(value), result = Array.isArray(value) ? [] : {};
    for (const [name, child] of entries.slice(0, 100)) {
      // A file's identity must survive even when its body exhausts the budget.
      if (depth === 0 && /^(path|file_path|filePath|filename|fileName|file|target|target_path|targetPath)$/.test(name) && typeof child === 'string') {
        Object.defineProperty(result, name, { value: child, enumerable: true, writable: true, configurable: true });
      } else if (/^(content|text|body|data|oldText|newText|old_text|new_text|old_string|new_string|patch|diff)$/.test(name) && typeof child === 'string' && child.length > LIMIT) {
        deferred = true;
      } else {
        Object.defineProperty(result, name, { value: compact(child, depth + 1), enumerable: true, writable: true, configurable: true });
      }
    }
    if (entries.length > 100) deferred = true;
    return result;
  }
  const fields = { args: compact(args) };
  for (const field of ['result', 'partial']) {
    remaining = LIMIT;
    const value = tool[field];
    if (typeof value === 'string' && value.length > LIMIT) {
      deferred = true; fields[field] = MARK + value.slice(-LIMIT);
    } else fields[field] = compact(value);
  }
  // Calculate added and removed lines before large edit text is truncated.
  // Fall back to edit counts when the diff budget or library is unavailable.
  const diffSummary = editDiffSummary(args);
  if (diffSummary) fields.detailSummary = diffSummary;
  else if (deferred && Array.isArray(args?.edits)) fields.detailSummary = { editCount: args.edits.length };
  if (deferred) Object.assign(fields, { detailsDeferred: true, detailVersion: String(++revision) });
  cache.set(key, { signature, fields });
  return { ...tool, ...fields };
}
function find(tools, id) {
  return (tools || []).find(tool => tool && String(tool.id) === String(id)) || null;
}
module.exports = { project, find, LIMIT };
