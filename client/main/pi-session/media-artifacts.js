'use strict';

/*
 * Conversation plugins return media through the signed attachment URL issued
 * by Hub.  The model event is deliberately kept out of the renderer; this
 * module turns a successful soduwork-media result into a normal file in the
 * conversation's outputs directory.  The existing output/artifact pipeline
 * then gives the user preview, open and download actions for free.
 */

const fs = require('fs');
const path = require('path');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

// Keep the desktop ceiling aligned with the server's documented upper bound.
// The server still applies the configured per-deployment VIDEO_MAX_MB limit.
const MAX_BYTES = 2048 * 1024 * 1024;
const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
const ATTACHMENT_PATH = /^\/(?:api\/v1\/)?attachments\/[A-Za-z0-9-]{8,64}$/;
const INDEX_NAME = '.soduwork-media-index.json';
const outputQueues = new Map();
const VIDEO_EXTENSIONS = new Map([
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['video/ogg', '.ogv'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);

function _jsonText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* tool bridges may add prose */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
}

function _walk(value, seen, visit) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  const found = visit(value);
  if (found) return found;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = _walk(item, seen, visit);
      if (result) return result;
    }
  } else {
    for (const item of Object.values(value)) {
      const result = _walk(item, seen, visit);
      if (result) return result;
    }
  }
  return null;
}

function _artifact(value) {
  return _walk(value, new Set(), (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const artifact = node.artifact && typeof node.artifact === 'object'
      ? node.artifact : node;
    if (!['video', 'image'].includes(String(artifact.kind || '').toLowerCase())) return null;
    const attachmentId = String(artifact.attachmentId || artifact.id || '').trim();
    const url = String(artifact.url || '').trim();
    if (!attachmentId || !url) return null;
    return {
      kind: String(artifact.kind).toLowerCase(),
      attachmentId: attachmentId.slice(0, 80),
      url: url.slice(0, 5000),
      filename: String(artifact.filename || 'soduwork-video.mp4').slice(0, 200),
      mimeType: String(artifact.mimeType || artifact.contentType || 'video/mp4').slice(0, 80),
      size: Number.isFinite(Number(artifact.size)) ? Number(artifact.size) : 0,
    };
  });
}

function _fromGatewayEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (String(value.server || '').trim() !== 'soduwork-media' ||
      !['generate_video', 'generate_image'].includes(String(value.tool || '').trim())) return null;
  const result = value.result;
  if (!result || typeof result !== 'object' || result.ok !== true) return null;
  return _artifact(result);
}

/** Extract a generated video artifact from a Pi tool_execution_end event. */
function fromToolEvent(event) {
  if (!event || event.type !== 'tool_execution_end' || event.isError) return null;
  // The current Pi bridge invokes plugin_mcp_call through the guarded shell
  // command (`node mcp.mjs ...`), so the outer event is usually named `bash`,
  // while a future native MCP adapter may report `plugin_mcp_call` directly.
  // The artifact shape and same-origin signed URL below are the authority;
  // do not key materialization on the outer tool name.
  const result = event.result;
  const content = result && Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text') {
      const parsed = _jsonText(block.text);
      const found = _fromGatewayEnvelope(parsed);
      if (found) return found;
    } else {
      const found = _fromGatewayEnvelope(block);
      if (found) return found;
    }
  }
  return _fromGatewayEnvelope(result);
}

function _safeFilename(raw, mimeType) {
  const normalizedType = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  const wantedExtension = VIDEO_EXTENSIONS.get(normalizedType);
  if (!wantedExtension) throw new Error('视频结果的文件类型不受支持');
  let name = path.basename(String(raw || '').replace(/\\/g, '/'));
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
  if (!name) name = 'soduwork-video';
  const ext = path.extname(name);
  if (ext) name = name.slice(0, -ext.length);
  name = name.replace(/[. ]+$/, '') || 'soduwork-video';
  return (name.slice(0, Math.max(1, 200 - wantedExtension.length)) + wantedExtension);
}

function _videoSignature(prefix, mimeType) {
  const type = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  const raw = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix || []);
  if (type === 'video/mp4' || type === 'video/quicktime') {
    return raw.length >= 12 && raw.subarray(4, 8).equals(Buffer.from('ftyp'));
  }
  if (type === 'video/webm') {
    return raw.length >= 4 && raw.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (type === 'video/ogg') return raw.length >= 4 && raw.subarray(0, 4).equals(Buffer.from('OggS'));
  if (type === 'image/png') return raw.length >= 8 && raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return raw.length >= 3 && raw[0] === 255 && raw[1] === 216 && raw[2] === 255;
  if (type === 'image/webp') return raw.length >= 12 && raw.subarray(0, 4).toString() === 'RIFF' && raw.subarray(8, 12).toString() === 'WEBP';
  return false;
}

async function _writeResponse(response, temp, mimeType, maxBytes) {
  let handle;
  let total = 0;
  let prefix = Buffer.alloc(0);
  const writeChunk = async (raw) => {
    const chunk = Buffer.from(raw || []);
    if (!chunk.length) return;
    total += chunk.length;
    if (total > maxBytes) throw new Error(`视频文件超过 ${Math.floor(maxBytes / (1024 * 1024))}MB 限制`);
    if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
      if (!bytesWritten) throw new Error('视频文件写入未完成');
      offset += bytesWritten;
    }
  };
  try {
    handle = await fs.promises.open(temp, 'wx');
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeChunk(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch (_) { /* best effort */ }
      }
    } else {
      if (!response.arrayBuffer) throw new Error('视频下载响应不可读取');
      await writeChunk(Buffer.from(await response.arrayBuffer()));
    }
    if (!total) throw new Error('视频文件为空');
    if (!_videoSignature(prefix, mimeType)) throw new Error('下载结果不是可识别的视频文件');
    await handle.sync();
    await handle.close();
    handle = null;
    return total;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function _attachmentUrl(raw, hub) {
  const base = String(hub || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('当前会话没有可用的 SoduWork 服务地址');
  let parsed;
  try { parsed = new URL(String(raw || ''), base + '/'); } catch (_) {
    throw new Error('视频结果地址无效');
  }
  let origin;
  try { origin = new URL(base).origin; } catch (_) { throw new Error('SoduWork 服务地址无效'); }
  if (parsed.origin !== origin || !ATTACHMENT_PATH.test(parsed.pathname) ||
      !parsed.searchParams.get('ticket') || parsed.username || parsed.password || parsed.hash) {
    throw new Error('视频结果未返回受信任的附件地址');
  }
  return parsed.href;
}

async function _refreshAttachmentUrl(artifact, identity, fetchImpl, signal) {
  const base = String(identity && identity.hub || '').trim().replace(/\/+$/, '');
  if (!base || !identity || (!identity.session && !identity.secret)) return '';
  const aid = encodeURIComponent(String(artifact && artifact.attachmentId || ''));
  const response = await fetchWithDeviceAuthRetry(identity, `${base}/api/v1/attachments/${aid}/access`, {
    method: 'POST',
    redirect: 'error',
    signal,
  }, fetchImpl);
  if (!response || !response.ok || typeof response.json !== 'function') return '';
  const payload = await response.json();
  const refreshed = _attachmentUrl(payload && payload.url, base);
  if (!new URL(refreshed).pathname.endsWith('/attachments/' + aid)) {
    throw new Error('刷新后的视频附件标识不一致');
  }
  return refreshed;
}

function _targetPath(outputDir, filename) {
  const root = path.resolve(outputDir);
  let candidate = path.resolve(root, filename);
  if (!candidate.startsWith(root + path.sep)) candidate = path.join(root, 'soduwork-video.mp4');
  return candidate;
}

async function _uniqueTarget(outputDir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length) || 'soduwork-video';
  let candidate = _targetPath(outputDir, filename);
  for (let index = 2; index < 1000; index += 1) {
    try { await fs.promises.access(candidate); } catch (_) { return candidate; }
    candidate = _targetPath(outputDir, `${stem}-${index}${ext}`);
  }
  throw new Error('视频输出目录中文件过多，请先整理旧结果');
}

async function _readIndex(outputDir) {
  try {
    const raw = await fs.promises.readFile(path.join(outputDir, INDEX_NAME), 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}

async function _indexedFile(outputDir, artifact, origin) {
  const aid = String(artifact && artifact.attachmentId || '');
  if (!aid) return null;
  const index = await _readIndex(outputDir);
  const relative = String(index[origin + ':' + aid] || '');
  if (!relative || path.isAbsolute(relative)) return null;
  const target = path.resolve(outputDir, relative);
  if (!target.startsWith(path.resolve(outputDir) + path.sep)) return null;
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || !stat.size) return null;
    if (_safeFilename(path.basename(target), artifact.mimeType) !== path.basename(target)) return null;
    if (Number(artifact.size || 0) > 0 && Number(artifact.size) !== stat.size) return null;
    const handle = await fs.promises.open(target, 'r');
    const prefix = Buffer.alloc(16);
    const read = await handle.read(prefix, 0, prefix.length, 0).finally(() => handle.close());
    if (!_videoSignature(prefix.subarray(0, read.bytesRead), artifact.mimeType)) return null;
    return {
      path: target,
      name: path.basename(target),
      size: stat.size,
      at: stat.mtimeMs,
      changedInTurn: false,
      primary: true,
      artifactId: aid,
      mimeType: String(artifact.mimeType || 'video/mp4'),
    };
  } catch (_) { return null; }
}

async function _rememberFile(outputDir, attachmentId, target, origin) {
  const aid = String(attachmentId || '');
  if (!aid) return;
  const index = await _readIndex(outputDir);
  const key = origin + ':' + aid;
  delete index[key];
  index[key] = path.relative(outputDir, target).split(path.sep).join('/');
  const entries = Object.entries(index).slice(-500);
  // Keep JSON protection rules identical for the temporary and final files;
  // otherwise some Windows filters reject this same-directory atomic rename.
  const temp = path.join(outputDir, `${INDEX_NAME}.part-${process.pid}-${Date.now()}.json`);
  await fs.promises.writeFile(temp, JSON.stringify(Object.fromEntries(entries)), { flag: 'wx' });
  await fs.promises.rename(temp, path.join(outputDir, INDEX_NAME));
}

/** Download one signed Hub attachment into cwd/outputs and return its file row. */
async function materialize(artifact, identity, cwd, fetchImpl = global.fetch, abortSignal) {
  const key = path.resolve(String(cwd || ''), 'outputs');
  const previous = outputQueues.get(key) || Promise.resolve();
  const running = previous.catch(() => {}).then(() => {
    abortSignal?.throwIfAborted();
    return _materialize(artifact, identity, cwd, fetchImpl, abortSignal);
  });
  outputQueues.set(key, running);
  try { return await running; }
  catch (error) {
    if (artifact?.kind === 'image' && typeof error?.message === 'string' && error.message.includes('视频')) {
      throw new Error(error.message.replace(/视频/g, '图片'), { cause: error });
    }
    throw error;
  }
  finally { if (outputQueues.get(key) === running) outputQueues.delete(key); }
}

async function _materialize(artifact, identity, cwd, fetchImpl, abortSignal) {
  if (!artifact || !['video', 'image'].includes(String(artifact.kind || '').toLowerCase())) {
    throw new Error('视频结果格式无效');
  }
  const maxBytes = artifact.kind === 'image' ? IMAGE_MAX_BYTES : MAX_BYTES;
  let url = _attachmentUrl(artifact.url, identity && identity.hub);
  if (!String(artifact.mimeType || '').startsWith(artifact.kind + '/')) throw new Error('媒体类型与结果不一致');
  const parsedUrl = new URL(url);
  const pathMatch = parsedUrl.pathname.match(/(?:^|\/)attachments\/([A-Za-z0-9-]{8,64})$/);
  if (!pathMatch || (artifact.attachmentId && pathMatch[1] !== String(artifact.attachmentId))) {
    throw new Error('视频结果附件标识不一致');
  }
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持视频下载');
  const outputDir = path.resolve(String(cwd || ''), 'outputs');
  await fs.promises.mkdir(outputDir, { recursive: true });
  const existing = await _indexedFile(outputDir, artifact, parsedUrl.origin);
  if (existing) {
    existing.relative = path.relative(String(cwd), existing.path).split(path.sep).join('/');
    return existing;
  }
  const filename = _safeFilename(artifact.filename, artifact.mimeType);
  const target = await _uniqueTarget(outputDir, filename);
  if (Number(artifact.size || 0) > maxBytes) {
    throw new Error(`媒体文件超过 ${Math.floor(maxBytes / (1024 * 1024))}MB 限制`);
  }
  const timeout = AbortSignal.timeout(5 * 60 * 1000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  let response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal });
  if (response && [401, 403].includes(Number(response.status))) {
    const refreshed = await _refreshAttachmentUrl(artifact, identity, fetchImpl, signal);
    if (refreshed) {
      url = refreshed;
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal });
    }
  }
  if (!response || !response.ok) {
    throw new Error(`视频下载失败（HTTP ${response && response.status || 0}）`);
  }
  const advertised = Number(response.headers && response.headers.get
    ? response.headers.get('content-length') : 0);
  if (advertised > maxBytes) {
    throw new Error(`媒体文件超过 ${Math.floor(maxBytes / (1024 * 1024))}MB 限制`);
  }
  const responseType = String(response.headers && response.headers.get
    ? response.headers.get('content-type') : '').split(';', 1)[0].trim().toLowerCase();
  const expectedType = String(artifact.mimeType || '').split(';', 1)[0].trim().toLowerCase();
  if (!VIDEO_EXTENSIONS.has(expectedType) || responseType !== expectedType) {
    throw new Error('视频下载响应的文件类型不一致');
  }
  const temp = `${target}.part-${process.pid}-${Date.now()}`;
  try {
    const size = await _writeResponse(response, temp, expectedType, maxBytes);
    if ((Number(artifact.size) > 0 && size !== Number(artifact.size)) ||
        (advertised > 0 && size !== advertised)) {
      throw new Error('视频下载不完整，请重新获取成果');
    }
    await fs.promises.rename(temp, target);
    await _rememberFile(outputDir, artifact.attachmentId, target, parsedUrl.origin).catch(() => {});
    return {
      path: target,
      relative: path.relative(String(cwd), target).split(path.sep).join('/'),
      name: path.basename(target),
      size,
      at: Date.now(),
      changedInTurn: true,
      primary: true,
      artifactId: String(artifact.attachmentId || ''),
      mimeType: expectedType,
    };
  } catch (error) {
    try { await fs.promises.unlink(temp); } catch (_) { /* best effort */ }
    throw error;
  }
}

async function recover(identity, conversationId, cwd, fetchImpl = global.fetch) {
  const base = String(identity && identity.hub || '').trim().replace(/\/+$/, '');
  const ref = String(conversationId || '').trim();
  if (!base || !identity || (!identity.session && !identity.secret) || !ref || typeof fetchImpl !== 'function') {
    return { files: [], errors: [] };
  }
  const response = await fetchWithDeviceAuthRetry(identity,
    `${base}/api/v1/conversations/${encodeURIComponent(ref)}/media`, {
      method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(30000),
    }, fetchImpl);
  if (response && Number(response.status) === 404) return { files: [], errors: [] };
  if (!response || !response.ok || typeof response.json !== 'function') {
    return { files: [], errors: ['无法读取会话视频成果'] };
  }
  const payload = await response.json();
  const files = [];
  const errors = [];
  for (const artifact of (Array.isArray(payload && payload.items) ? payload.items : []).slice(0, 10)) {
    try { files.push(await materialize(artifact, identity, cwd, fetchImpl)); }
    catch (error) { errors.push(String(error && error.message || error).slice(0, 300)); }
  }
  return { files, errors };
}

module.exports = {
  MAX_BYTES, fromToolEvent, materialize, _jsonText, _safeFilename,
  _attachmentUrl, _artifact, _fromGatewayEnvelope, _videoSignature,
  _refreshAttachmentUrl, recover, _readIndex,
};
