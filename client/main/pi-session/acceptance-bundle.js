'use strict';

// Reuse the Hub's immutable delivery ZIP instead of repacking a mutable workspace.
const crypto = require('node:crypto');
const { MAX_BYTES } = require('./attachments');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

async function load(identity, route, bundle) {
  const url = String(identity.hub).replace(/\/+$/, '') + '/api/v1' + route +
    '/artifacts.zip?artifactVersionId=' + encodeURIComponent(bundle.artifactVersionId);
  const response = await fetchWithDeviceAuthRetry(identity, url, {
    redirect: 'error', signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const fallback = response.status === 401 || response.status === 403
      ? '交付文件访问权限已变化，请重新打开需求后重试'
      : '交付压缩包读取失败（HTTP ' + response.status + '），请刷新需求后重试';
    throw Error(await require('../delivery-download-error.cjs').message(response, fallback));
  }
  const digest = response.headers.get('X-Artifact-SHA256') || '';
  if (!response.body || response.headers.get('X-Artifact-Version') !== bundle.artifactVersionId ||
      !/^[a-f0-9]{64}$/i.test(digest) || Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw Error('本次交付压缩包未能完整读取，请刷新需求后重试');
  }
  const chunks = [], hash = crypto.createHash('sha256');
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw Error('交付压缩包超过 256 MB，无法引入本轮验收');
      hash.update(part.value); chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!size || hash.digest('hex') !== digest.toLowerCase()) throw Error('交付压缩包完整性校验失败，请重试');
  return { name: bundle.filename, data: Buffer.concat(chunks), mimeType: 'application/zip',
    role: 'output', sourceRef: bundle.artifactVersionId,
    evidenceMeta: { artifactVersionId: bundle.artifactVersionId, sourceAttachmentIds: bundle.attachmentIds } };
}

module.exports = { load };
