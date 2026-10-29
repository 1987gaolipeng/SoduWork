'use strict';

// Deterministic, source-linked work summaries. Never infer preferences from a
// conversation, and never replace a user correction with an automatic digest.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redact } = require('./import-redaction');
const STATE = '.personal-learning.json';
const MAX_RECENT = 50;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const marker = id => '<!-- soduwork-work-memory:' + id + ' -->';
const end = '<!-- /soduwork-work-memory -->';

function safeRead(file, max) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw Error('Invalid personal memory source');
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function stateOf(root) {
  const raw = safeRead(path.join(root, STATE), MAX_STATE_BYTES);
  if (!raw) return { version: 1, scanned: false, sources: {} };
  const state = JSON.parse(raw);
  if (state.version !== 1 || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)) throw Error('Invalid personal learning state');
  return state;
}
function sourceBlock(content, id) {
  const start = content.indexOf(marker(id));
  if (start < 0) return null;
  const finish = content.indexOf(end, start);
  return finish < 0 ? null : { start, finish: finish + end.length, text: content.slice(start, finish + end.length) };
}
function clean(value, max) {
  return redact(String(value || '')).replace(/<!--\s*\/?soduwork-work-memory[^>]*-->/g, '').trim().slice(0, max);
}
function blockFor(digest, id) {
  const fields = digest.fields || {};
  const title = clean(digest.title || fields.goal || '工作记录', 120).replace(/[\r\n#]/g, ' ');
  const lines = [marker(id), '## ' + title, '', '来源：已完成会话的工作摘要（仅自己可见）', ''];
  for (const [key, label, max] of [['goal', '目标', 800], ['decisions', '已确认决定', 1000], ['constraints', '约束', 1000], ['outcomes', '结果', 2000]]) {
    const value = clean(fields[key], max);
    if (value) lines.push('**' + label + '**', value, '');
  }
  lines.push(end);
  return lines.join('\n');
}
// Stable fingerprint of a work summary, ignoring dates/times so that routine
// jobs (daily reports, recurring regressions) whose outcome text is identical
// modulo the calendar date collapse into one memory block instead of
// accumulating look-alike entries that crowd out the injection budget.
function fieldSignature(digest) {
  const fields = digest.fields || {};
  const parts = ['goal', 'decisions', 'constraints', 'outcomes'].map(name =>
    clean(fields[name], 2000).toLowerCase().replace(/\s+/g, ' ')
      .replace(/\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?/g, '#').replace(/\d{1,2}:\d{2}/g, '#'));
  return hash(parts.join('\u0000'));
}
function importedSources(root) {
  const dir = path.join(root, 'imports');
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid imported memory directory');
  } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  // Each immutable import ID maps to the exact legacy session key. Include
  // tombstones too: deleting evidence must not make its old file learnable.
  // Do not read multi-megabyte evidence on every ordinary conversation turn.
  return new Set(fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^[a-f0-9]{32}\.json$/.test(entry.name))
    .map(entry => hash(entry.name.slice(0, 32))));
}
function history(root, excluded) {
  const dir = path.join(root, 'sessions');
  try { if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) return []; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && /^[a-f0-9]{64}(?:-auto)?\.md$/.test(entry.name))
    .map(entry => ({ file: path.join(dir, entry.name), at: fs.statSync(path.join(dir, entry.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at).slice(0, 100).reverse().flatMap(({ file, at }) => {
      let raw;
      try { raw = safeRead(file, 256 * 1024); } catch (_) { return []; }
      const signed = /^<!-- soduwork-generated-sha256=([a-f0-9]{64}) -->\n([\s\S]*)$/.exec(raw);
      if (!signed || hash(signed[2]) !== signed[1]) return [];
      const managed = /<!-- soduwork-managed-memory scope=session key=([a-f0-9]{64}) -->/.exec(raw);
      if (!managed || excluded.has(managed[1]) || /<!-- soduwork-memory-outcome=incomplete -->/.test(raw)) return [];
      const fields = {};
      for (const match of raw.matchAll(/^## (Summary|Goal|Decisions|Constraints|Pending|Outcomes)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) fields[match[1].toLowerCase()] = match[2].trim();
      if (!fields.outcomes || fields.pending) return [];
      return [{ id: managed[1], at, digest: { title: /^# (.+)$/m.exec(raw)?.[1], fields } }];
    });
}
function reconcile({ root, write, digest, key, backfill = false }) {
  const state = stateOf(root);
  const file = path.join(root, 'personal.md');
  let content = safeRead(file, 16 * 1024 * 1024);
  const before = content;
  const excluded = importedSources(root);
  for (const id of excluded) {
    const prior = state.sources[id], block = sourceBlock(content, id);
    // Old import previews could accidentally trigger a learning backfill.
    // Remove only an unchanged generated block; manual corrections remain.
    if (prior && !prior.ignored) {
      if (block && hash(block.text) === prior.hash) content = content.slice(0, block.start) + content.slice(block.finish);
      state.sources[id] = { ...prior, ignored: true };
    }
  }
  const candidates = [];
  if (!state.scanned && backfill) {
    // An existing canonical tombstone means "forgotten", not "migrate again".
    if (content || !fs.existsSync(path.join(root, '.personal-state.json'))) candidates.push(...history(root, excluded));
    state.scanned = true;
  }
  if (digest?.completed === true && digest.fields?.outcomes && !digest.fields?.pending && key) {
    candidates.push({ id: hash(key), at: Date.now(), digest });
  }
  for (const candidate of candidates) {
    const { id, at } = candidate;
    if (excluded.has(id)) continue;
    const block = blockFor(candidate.digest, id);
    const signature = hash(block);
    const prior = state.sources[id];
    const existing = sourceBlock(content, id);
    if (prior?.ignored || prior?.hash === signature) continue;
    // Missing/edited generated content is a deliberate correction or forgetting.
    if (prior && !prior.pruned && (!existing || hash(existing.text) !== prior.hash)) {
      state.sources[id] = { ...prior, ignored: true };
      continue;
    }
    // Same work captured again (routine/scheduled runs): the full record stays
    // in the session file, the canonical memory keeps the first block. Entries
    // written before this opt-in carry no signature and keep their behavior.
    const sig = fieldSignature(candidate.digest);
    if (!prior && !existing && sig &&
        Object.values(state.sources).some(entry => entry.sig === sig && !entry.ignored && !entry.pruned)) continue;
    if (existing) {
      if (!prior && existing.text !== block) { state.sources[id] = { hash: signature, at, ignored: true }; continue; }
      content = content.slice(0, existing.start) + block + content.slice(existing.finish);
    } else {
      // Newest work first, after any user-authored notes.
      const first = content.indexOf('<!-- soduwork-work-memory:');
      const atIndex = first >= 0 ? first : content.length;
      content = content.slice(0, atIndex).trimEnd() + '\n\n' + block + '\n\n' + content.slice(atIndex);
      if (!before && !content.startsWith('# ')) content = '# 个人记忆\n\n' + content.trimStart();
    }
    state.sources[id] = { hash: signature, at, ...(sig ? { sig } : {}) };
  }
  // Bound automatic context. User-authored/edited material is never pruned.
  const recent = Object.entries(state.sources).filter(([, value]) => !value.ignored && !value.pruned).sort((a, b) => b[1].at - a[1].at);
  for (const [id, prior] of recent.slice(MAX_RECENT)) {
    const block = sourceBlock(content, id);
    if (block && hash(block.text) === prior.hash) {
      content = content.slice(0, block.start) + content.slice(block.finish);
      state.sources[id] = { ...prior, pruned: true };
    } else state.sources[id] = { ...prior, ignored: true };
  }
  if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw Error('个人记忆超过 16 MiB，原有内容已保留');
  const next = JSON.stringify(state);
  if (Buffer.byteLength(next) > MAX_STATE_BYTES) throw Error('个人记忆索引已达到容量上限，原文已保留');
  if (content !== before) {
    write(file, content.trimEnd() + '\n', 0o600);
    if (!fs.existsSync(path.join(root, '.personal-state.json'))) write(path.join(root, '.personal-state.json'), JSON.stringify({ version: 1, aliases: [] }), 0o600);
  }
  if (safeRead(path.join(root, STATE), MAX_STATE_BYTES) !== next) write(path.join(root, STATE), next, 0o600);
}
function forget(root, write) {
  const state = stateOf(root);
  state.scanned = true;
  for (const entry of Object.values(state.sources)) entry.ignored = true;
  write(path.join(root, STATE), JSON.stringify(state), 0o600);
}

function displayContent(content) {
  return String(content || '').replace(/^<!-- soduwork-work-memory:[a-f0-9]{64} -->\r?\n?/gm, '')
    .replace(/^<!-- \/soduwork-work-memory -->\r?\n?/gm, '');
}
function restoreMarkers(previous, edited) {
  if (edited.includes('<!-- soduwork-work-memory:')) return edited;
  const ranges = [];
  for (const match of previous.matchAll(/<!-- soduwork-work-memory:[a-f0-9]{64} -->[\s\S]*?<!-- \/soduwork-work-memory -->/g)) {
    const visible = displayContent(match[0]).trimEnd();
    if (!visible) continue;
    let at = edited.indexOf(visible);
    while (at >= 0 && ranges.some(range => at < range.finish && at + visible.length > range.start)) at = edited.indexOf(visible, at + 1);
    if (at >= 0) ranges.push({ start: at, finish: at + visible.length, text: match[0] });
  }
  for (const range of ranges.sort((a, b) => b.start - a.start)) edited = edited.slice(0, range.start) + range.text + edited.slice(range.finish);
  return edited;
}

module.exports = { reconcile, forget, displayContent, restoreMarkers };
