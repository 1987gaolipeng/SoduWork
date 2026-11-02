/*
 * Stage conversation attachments in the workspace and expose them through agent context.
 * Normalize trusted file-picker paths and clipboard bytes with shared limits and safe
 * names.
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');

const MAX_FILES = 20;
const MAX_BYTES = 256 * 1024 * 1024;
const IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
});
const IMAGE_ANALYSIS_TYPES = Object.freeze({
  ...IMAGE_TYPES,
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
  '.heif': 'image/heif', '.ico': 'image/x-icon', '.jxl': 'image/jxl',
  '.jp2': 'image/jp2', '.j2k': 'image/jp2', '.raw': 'image/x-raw',
  '.cr2': 'image/x-canon-cr2', '.nef': 'image/x-nikon-nef',
  '.arw': 'image/x-sony-arw', '.dng': 'image/x-adobe-dng',
  '.psd': 'image/vnd.adobe.photoshop',
});

function analysisImageMime(file) {
  const declared = String(file?.mimeType || '').toLowerCase().split(';')[0].trim()
    .replace(/^image\/(?:jpg|pjpeg)$/, 'image/jpeg');
  if (/^image\/[a-z0-9][a-z0-9.+-]*$/i.test(declared)) return declared;
  return IMAGE_ANALYSIS_TYPES[path.extname(file?.path || '').toLowerCase()] || '';
}

function safeName(value) {
  const raw = path.basename(String(value || '附件')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim();
  return (raw || '附件').slice(0, 180);
}

/*
 * Electron's structured-clone transport normally preserves Uint8Array, but
 * older preload bridges and a few test/upgrade paths serialise it as either a
 * Buffer JSON envelope or a plain numeric object.  Treat those representations
 * as the same byte payload so non-Pi runtimes receive the attachment too.
 * Keep the conversion strict: arbitrary objects and oversized sparse payloads
 * must never become files silently.
 */
function bytesFromTransport(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (!value || typeof value !== 'object') return null;
  const array = value.type === 'Buffer' && Array.isArray(value.data) ? value.data :
    Array.isArray(value) ? value : null;
  if (array) {
    if (array.length > MAX_BYTES) return null;
    for (const byte of array) if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    return Buffer.from(array);
  }
  // JSON.stringify(new Uint8Array(...)) produces numeric keys rather than an
  // explicit data array.  Require a contiguous, bounded index set to avoid
  // accepting an accidental metadata object as file bytes.
  const keys = Object.keys(value);
  const numericKeys = keys.length && keys.every(key => /^\d+$/.test(key));
  const declaredLength = Number(value.length);
  const length = Number.isSafeInteger(declaredLength) && declaredLength >= 0
    ? declaredLength : (numericKeys ? keys.length : NaN);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES || keys.length !== length) return null;
  for (let index = 0; index < length; index++) {
    const key = String(index);
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    const byte = value[key];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
  }
  return Buffer.from(Array.from({ length }, (_, index) => value[index]));
}

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

async function available(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let index = 0; index < 1000; index++) {
    const candidate = path.join(dir, index ? `${stem}-${index + 1}${ext}` : name);
    try { await fs.access(candidate); } catch (error) { return candidate; }
  }
  throw new Error('附件重名过多');
}

async function stage(cwd, rawItems, options) {
  const release = require('../work-preview-app-attachments.cjs').protect(rawItems);
  try {
    const result = await stageFiles(cwd, rawItems, options);
    if (Array.isArray(rawItems) && rawItems.some(item => String(item?.sourceRef || '').startsWith('app-input:')) && result.files.length !== rawItems.length)
      throw Error('应用附件未完整复制，请重新选择后发送');
    // A transfer lease is transient, not durable provenance for future turns.
    result.files.forEach(file => { if (String(file.sourceRef || '').startsWith('app-input:')) delete file.sourceRef; });
    return result;
  } finally { await release(); }
}

async function stageFiles(cwd, rawItems, options) {
  const items = Array.isArray(rawItems) ? rawItems.slice(0, MAX_FILES) : [];
  const stagingDir = String((options && options.stagingDir) || '').trim();
  const warnings = [];
  const files = [];
  let bytes = 0;
  let inputDir = '';
  if (Array.isArray(rawItems) && rawItems.length > MAX_FILES) warnings.push(`最多接收 ${MAX_FILES} 个附件，其余已忽略`);

  for (const item of items) {
    const source = String((item && item.path) || '').trim();
    const rawData = item && item.data;
    const data = bytesFromTransport(rawData);
    if (!source && !data) { warnings.push('有一个附件没有可用内容'); continue; }
    try {
      if (data) {
        if (bytes + data.byteLength > MAX_BYTES) { warnings.push('附件总大小超过 256 MB，超出的文件已忽略'); break; }
        bytes += data.byteLength;
        inputDir = inputDir || stagingDir || path.join(cwd, '.soduwork-inputs');
        await fs.mkdir(inputDir, { recursive: true });
        const target = await available(inputDir, safeName(item.name || '粘贴附件'));
        await fs.writeFile(target, data);
        files.push({ name: safeName(item.name || target), path: target,
          relative: inside(cwd, target) ? path.relative(cwd, target).replace(/\\/g, '/') : target,
          size: data.byteLength, mimeType: String(item.type || item.mimeType || item.contentType || ''),
          ...(item.attachmentId ? {attachmentId: String(item.attachmentId)} : {}),
          ...(item.role ? {role: String(item.role)} : {}),
          ...(item.sourceRef ? {sourceRef: String(item.sourceRef)} : {}),
          ...(item.evidenceMeta ? {evidenceMeta: item.evidenceMeta} : {}) });
        continue;
      }
      const stat = await fs.stat(source);
      if (stat.isDirectory()) {
        /*
         * Reference folders by path instead of copying potentially large trees; runtime file
         * access remains subject to session permissions.
         */
        files.push({ name: safeName(item.name || source), path: path.resolve(source),
          relative: inside(cwd, source) ? path.relative(cwd, source).replace(/\\/g, '/') : path.resolve(source),
          size: 0, kind: 'dir', mimeType: '' });
        continue;
      }
      if (!stat.isFile()) { warnings.push(`${safeName(item.name || source)} 不是文件`); continue; }
      if (bytes + stat.size > MAX_BYTES) { warnings.push('附件总大小超过 256 MB，超出的文件已忽略'); break; }
      bytes += stat.size;
      /*
       * Every uploaded file gets a session-owned copy, even when the picker
       * happened to select a file that already lives under cwd. The runtime
       * and its tools are allowed to edit their working inputs; pointing them
       * at the user's original path would let an ordinary conversation mutate
       * that file. Directories remain references because copying an entire tree
       * is unbounded and is handled by the explicit folder-input contract.
       */
      inputDir = inputDir || stagingDir || path.join(cwd, '.soduwork-inputs');
      await fs.mkdir(inputDir, { recursive: true });
      const target = await available(inputDir, safeName(item.name || source));
      await fs.copyFile(source, target);
      files.push({
        name: safeName(item.name || target), path: target,
        relative: inside(cwd, target) ? path.relative(cwd, target).replace(/\\/g, '/') : target,
        size: stat.size,
        mimeType: String((item && (item.type || item.mimeType || item.contentType)) || ''),
        ...(item.attachmentId ? {attachmentId: String(item.attachmentId)} : {}),
        ...(item.role ? {role: String(item.role)} : {}),
        ...(item.sourceRef ? {sourceRef: String(item.sourceRef)} : {}),
        ...(item.evidenceMeta ? {evidenceMeta: item.evidenceMeta} : {}),
      });
    } catch (error) {
      warnings.push(`${safeName((item && item.name) || source)} 无法读取`);
    }
  }
  return { files, warnings, bytes };
}

function prompt(files) {
  if (!files || !files.length) return '';
  const rows = files.map((file) => `- ${file.name}${file.kind === 'dir' ? '（文件夹）' : ''}` +
    (file.attachmentId ? `（附件 ID: ${file.attachmentId}）` : '') + `：${file.relative}`).join('\n');
  const hasDir = files.some((file) => file.kind === 'dir');
  return [
    '用户在开始本次会话时提供了以下输入附件，后面是可直接读取的路径：', rows,
    '需要时直接读取这些路径。普通文件已复制为本轮上传输入的工作副本，只能读取；不要覆盖、重命名或删除输入文件。',
    '如需编辑、转换或生成结果，请在当前会话工作目录创建新的输出文件，并保留输入副本。',
    hasDir ? '标注为文件夹的条目是只读路径引用，可以直接列目录、读取其中的文件；不要在原目录中创建或修改文件。' : '',
  ].filter(Boolean).join('\n');
}

async function images(files) {
  const out = [];
  for (const file of (files || []).slice(0, MAX_FILES)) {
    if (file.kind === 'dir') continue;
    const mimeType = analysisImageMime(file);
    if (!/^image\/[a-z0-9][a-z0-9.+-]*$/i.test(mimeType) || Number(file.size || 0) > IMAGE_BYTES) continue;
    const stat = await fs.stat(file.path);
    if (!stat.isFile() || stat.size > IMAGE_BYTES) continue;
    const data = await fs.readFile(file.path);
    if (data.length > IMAGE_BYTES) continue;
    out.push({ type: 'image', data: data.toString('base64'), mimeType });
  }
  return out;
}

async function readImage(target) {
  const file = path.resolve(String(target || ''));
  const mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()] || '';
  if (!mimeType) throw new Error('当前附件不是可预览的图片');
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('图片附件已经不在了');
  if (stat.size > IMAGE_BYTES) throw new Error('图片超过 20 MB，无法在对话中预览');
  return { file, mimeType, size: stat.size, data: await fs.readFile(file) };
}

module.exports = { stage, prompt, images, readImage, safeName, inside, bytesFromTransport,
  MAX_FILES, MAX_BYTES, IMAGE_BYTES };
