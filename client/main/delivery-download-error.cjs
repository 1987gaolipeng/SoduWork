'use strict';

// Only known service messages may cross into the UI; proxy bodies and storage paths stay private.
async function message(response, fallback) {
  let detail = '';
  try {
    const bytes = await require('./library-binary.cjs').readResponse(response, 16 * 1024);
    const body = JSON.parse(bytes.toString('utf8'));
    if (typeof body.detail === 'string') detail = body.detail;
  } catch (_) { /* Malformed and oversized error bodies use the status-based fallback. */ }
  if ((response.status === 404 && detail === '附件文件已丢失') ||
      (response.status === 502 && detail === '当前固定版本的源文件已丢失，拒绝返回不完整压缩包'))
    return '源文件已丢失，请从原执行电脑或服务器备份恢复附件后重试';
  return fallback;
}

module.exports = { message };
