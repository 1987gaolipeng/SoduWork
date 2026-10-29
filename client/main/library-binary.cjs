'use strict';
const fs = require('node:fs');
const MAX_BYTES = 64 * 1024 * 1024;
const TOO_LARGE = '文件超过 64MB，请在资料库中直接上传或下载后使用';

// IPC/base64 transfer needs a bounded working set even when the server accepts
// large streamed uploads. Read one extra byte to detect a growing local file.
function readFile(filename, limit = MAX_BYTES) {
  const fd = fs.openSync(filename, 'r');
  const chunks = [];
  let size = 0;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('这个结果不是可上传的文件');
    if (stat.size > limit) throw new Error(TOO_LARGE);
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, limit + 1 - size));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > limit) throw new Error(TOO_LARGE);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, size);
  } finally { fs.closeSync(fd); }
}

async function readResponse(response, limit = MAX_BYTES) {
  if (Number(response.headers.get('content-length') || 0) > limit) {
    await response.body?.cancel?.();
    throw new Error(TOO_LARGE);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error(TOO_LARGE); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}
module.exports = { MAX_BYTES, TOO_LARGE, readFile, readResponse };
