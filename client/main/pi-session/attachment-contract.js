/* Attachment context exposes paths to the model but only filenames to the conversation UI. */
'use strict';

const START = '<soduwork-input-attachments>';
const END = '</soduwork-input-attachments>';
const PREVIEW_PREFIX = 'att1.';

/*
 * Opaque preview references identify attachments without exposing managed paths. They do
 * not authorize reads; validate workspace or managed-input boundaries each time.
 */
function previewRef(value) {
  const source = String(value || '').trim();
  return source ? PREVIEW_PREFIX + Buffer.from(source, 'utf8').toString('base64url') : '';
}

function previewPath(value) {
  const token = String(value || '');
  if (!token.startsWith(PREVIEW_PREFIX) || token.length > 8192) return '';
  try { return Buffer.from(token.slice(PREVIEW_PREFIX.length), 'base64url').toString('utf8'); }
  catch (_) { return ''; }
}

function publicFiles(files) {
  return (Array.isArray(files) ? files : []).map((item) => ({
    name: String((item && (item.name || item.filename)) || '附件'),
    type: String((item && (item.type || item.mimeType || item.contentType)) || ''),
    size: Number((item && item.size) || 0),
    previewRef: String((item && item.previewRef) || previewRef(item && item.path)),
  }));
}

function compact(files) {
  return (files || []).map((file) => ({
    name: String(file.name || '附件'),
    path: String(file.relative || file.path || ''),
    type: String(file.mimeType || file.type || ''),
    size: Number(file.size || 0),
  })).filter((file) => file.path);
}

function augment(text, files) {
  const items = compact(files);
  const visible = String(text || '').trim();
  if (!items.length) return visible;
  return visible + '\n\n' + START + '\n' + JSON.stringify({ files: items }) + '\n' + END;
}

function parse(value) {
  const source = String(value || '');
  const at = source.lastIndexOf(START);
  const end = source.lastIndexOf(END);
  if (at < 0 || end < at) return { text: source, files: [] };
  let files = [];
  try {
    const payload = JSON.parse(source.slice(at + START.length, end).trim());
    files = publicFiles(payload && payload.files);
  } catch (_) { files = []; }
  return { text: source.slice(0, at).trimEnd(), files };
}

module.exports = { START, END, augment, parse, compact, publicFiles, previewRef, previewPath };
