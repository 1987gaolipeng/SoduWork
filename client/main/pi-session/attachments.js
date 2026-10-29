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

function safeName(value) {
  const raw = path.basename(String(value || '附件')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim();
  return (raw || '附件').slice(0, 180);
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
    const data = Buffer.isBuffer(rawData) ? rawData
      : rawData instanceof Uint8Array ? Buffer.from(rawData)
      : rawData instanceof ArrayBuffer ? Buffer.from(new Uint8Array(rawData)) : null;
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
          size: data.byteLength, mimeType: String(item.type || item.mimeType || ''),
          ...(item.attachmentId ? {attachmentId: String(item.attachmentId)} : {}),
          ...(item.role ? {role: String(item.role)} : {}),
          ...(item.sourceRef ? {sourceRef: String(item.sourceRef)} : {}),
          ...(item.evidenceMeta ? {evidenceMeta: item.evidenceMeta} : {}) });
        continue;
      }
      const stat = await fs.stat(source);
      if (stat.isDirectory()) {


        files.push({ name: safeName(item.name || source), path: path.resolve(source),
          relative: inside(cwd, source) ? path.relative(cwd, source).replace(/\\/g, '/') : path.resolve(source),
          size: 0, kind: 'dir', mimeType: '' });
        continue;
      }
      if (!stat.isFile()) { warnings.push(`${safeName(item.name || source)} 不是文件`); continue; }
      if (bytes + stat.size > MAX_BYTES) { warnings.push('附件总大小超过 256 MB，超出的文件已忽略'); break; }
      bytes += stat.size;
      let target = path.resolve(source);
      if (!inside(cwd, target) || (item.appTemporary === true && String(item.sourceRef || '').startsWith('app-input:'))) {
        inputDir = inputDir || stagingDir || path.join(cwd, '.soduwork-inputs');
        await fs.mkdir(inputDir, { recursive: true });
        target = await available(inputDir, safeName(item.name || source));
        await fs.copyFile(source, target);
      }
      files.push({
        name: safeName(item.name || target), path: target,
        relative: inside(cwd, target) ? path.relative(cwd, target).replace(/\\/g, '/') : target,
        size: stat.size,
        mimeType: String((item && (item.type || item.mimeType)) || ''),
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
    '需要时直接读取这些路径。它们是用户输入，不要把它们当作你的产出。',
    hasDir ? '标注为文件夹的条目可以直接列目录、读取其中的文件；同样只作为输入材料使用。' : '',
  ].filter(Boolean).join('\n');
}

async function images(files) {
  const out = [];
  for (const file of (files || []).slice(0, MAX_FILES)) {
    if (file.kind === 'dir') continue;
    const declared = String(file.mimeType || '').toLowerCase().split(';')[0].trim()
      .replace(/^image\/(?:jpg|pjpeg)$/, 'image/jpeg');
    const mimeType = /^image\/(?:png|jpeg|webp|gif)$/.test(declared) ? declared
      : IMAGE_TYPES[path.extname(file.path).toLowerCase()] || '';
    if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(mimeType) || Number(file.size || 0) > IMAGE_BYTES) continue;
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

module.exports = { stage, prompt, images, readImage, safeName, inside, MAX_FILES, MAX_BYTES, IMAGE_BYTES };
