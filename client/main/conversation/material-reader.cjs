'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TOTAL_TEXT = 240000;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml', '.html', '.htm', '.yaml', '.yml']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp']);

function entriesOf(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  return [].concat(snapshot?.attachments || [], snapshot?.files || [], snapshot?.materials || [], snapshot?.materialReferences || snapshot?.references || []);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('Material read aborted');
}

function withAbort(task, signal) {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(new Error('Material read aborted'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; cleanup(); callback(value);
    };
    const onAbort = () => finish(reject, new Error('Material read aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(task).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

function sourceRanges(text) {
  const ranges = [];
  let start = 0, line = 1;
  for (const part of text.split(/\n/)) {
    const end = start + part.length;
    ranges.push({ line, start, end });
    start = end + 1; line++;
  }
  return ranges;
}

async function readPrefix(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, limit));
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally { await handle.close(); }
}

async function readMaterials(snapshot, options = {}) {
  const signal = options.signal;
  throwIfAborted(signal);
  const readers = options.readers || {};
  const includeImageBytes = options.includeImageBytes === true;
  const maxImageBytes = Number.isFinite(options.maxImageBytes) ? Math.max(0, options.maxImageBytes) : 1024 * 1024;
  const totalLimit = Number.isFinite(options.maxTotalText) ? Math.max(0, options.maxTotalText) : MAX_TOTAL_TEXT;
  const fileLimit = Number.isFinite(options.maxFileBytes) ? Math.max(0, options.maxFileBytes) : MAX_FILE_BYTES;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const materials = [];
  let totalText = 0;
  try {
    for (const entry of entriesOf(snapshot)) {
      throwIfAborted(signal); throwIfAborted(controller.signal);
      const name = String(entry?.name || entry?.filename || path.basename(entry?.stagedPath || entry?.path || '') || 'unnamed');
      const attachmentId = entry?.attachmentId ?? entry?.id ?? null;
      const file = entry?.stagedPath || entry?.path || entry?.source?.stagedPath || entry?.source?.path;
      const base = { attachmentId, name, source: file || null,
        ...(entry?.role ? { role: entry.role } : {}) };
      if (!file || entry?.trusted === false || (entry?.trusted !== true && !entry?.stagedPath && !entry?.source?.stagedPath)) {
        materials.push({ ...base, status: 'excluded', reason: 'untrusted-or-unstaged' }); continue;
      }
      const ext = path.extname(name).toLowerCase();
      try {
        if (TEXT_EXTENSIONS.has(ext)) {
          const bytes = await fs.readFile(file, { signal: controller.signal });
          const hash = crypto.createHash('sha256').update(bytes).digest('hex');
          let text = bytes.toString('utf8').replace(/^\uFEFF/, '');
          const available = Math.max(0, totalLimit - totalText);
          const partial = text.length > available || bytes.length > fileLimit;
          if (bytes.length > fileLimit) text = bytes.subarray(0, fileLimit).toString('utf8').replace(/^\uFEFF/, '');
          if (text.length > available) text = text.slice(0, available);
          totalText += text.length;
          materials.push({ ...base, status: partial ? 'partial' : 'read', kind: 'text', hash, text, bytes: bytes.length, sourceRanges: sourceRanges(text) });
        } else if (IMAGE_EXTENSIONS.has(ext)) {
          const stat = await fs.stat(file);
          const item = { ...base, status: 'read', kind: 'image', mime: entry.mime || `image/${ext.slice(1)}`, bytes: stat.size, visualUnderstanding: false };
          if (includeImageBytes) item.data = await readPrefix(file, maxImageBytes);
          if (typeof readers.imageObserve === 'function') item.observation = await withAbort(Promise.resolve(readers.imageObserve({ ...item }, { signal: controller.signal })), controller.signal);
          materials.push(item);
        } else if (OFFICE_EXTENSIONS.has(ext) || ext === '.pdf') {
          const stat = await fs.stat(file);
          if (stat.size > fileLimit) {
            materials.push({ ...base, status: 'unreadable', reason: 'file-too-large', bytes: stat.size });
            continue;
          }
          const reader = ext === '.pdf' ? readers.pdf : readers.office;
          if (typeof reader !== 'function') { materials.push({ ...base, status: 'unreadable', reason: 'reader-unavailable' }); continue; }
          const result = await withAbort(Promise.resolve(reader({ ...entry, path: file, name }, { signal: controller.signal, maxBytes: fileLimit })), controller.signal);
          const text = typeof result === 'string' ? result : String(result?.text || '');
          const available = Math.max(0, totalLimit - totalText);
          const clipped = text.slice(0, available); totalText += clipped.length;
          const bytes = await fs.readFile(file);
          const hash = crypto.createHash('sha256').update(bytes).digest('hex');
          materials.push({ ...base, status: clipped.length < text.length ? 'partial' : 'read', kind: ext === '.pdf' ? 'pdf' : 'office', text: clipped, bytes: stat.size, hash, sourceRanges: sourceRanges(clipped), metadata: result?.metadata });
        } else materials.push({ ...base, status: 'unreadable', reason: 'unsupported-type' });
      } catch (error) {
        if (controller.signal.aborted || signal?.aborted) throw new Error('Material read aborted');
        materials.push({ ...base, status: 'unreadable', reason: error?.message || 'read-failed' });
      }
    }
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  return { materials, text: materials.filter(x => x.text).map(x => x.text).join('\n\n'), totalText };
}

module.exports = { readMaterials, MAX_TOTAL_TEXT, MAX_FILE_BYTES };
