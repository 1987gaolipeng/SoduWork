'use strict';
const fs = require('node:fs');
const path = require('node:path');
const outputs = require('./pi-session/outputs');
const binary = require('./library-binary.cjs');
const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.txt': 'text/plain',
  '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

// Resolve public artifact IDs in the main process; never interpret an ID as a path.
function read(session, target) {
  if (!session) return { ok: false, reason: '会话不在了' };
  try {
    let candidate;
    if (target && typeof target === 'object' && target.artifactId) {
      const artifact = require('./conversation/artifact-runtime').resolve(session, target.artifactId);
      if (!artifact.ok) return artifact;
      candidate = artifact.path;
    } else if (typeof target === 'string' && target.trim()) {
      candidate = path.resolve(session.cwd, target);
    } else return { ok: false, reason: '当前成果暂时无法上传到资料库' };
    if (!outputs.inside(session.cwd, candidate)) return { ok: false, reason: '这个文件不在这条对话的工作目录里' };
    const resolved = fs.realpathSync(candidate);
    const data = binary.readFile(resolved);
    return { ok: true, name: path.basename(resolved), size: data.length,
      mimeType: MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', data: data.toString('base64') };
  } catch (error) { return { ok: false, reason: String(error.message || error) }; }
}
async function readAsync(session, target) {
  if (session && target && typeof target === 'object' && target.artifactId) {
    try {
      const artifact = await require('./conversation/artifact-runtime').resolveAsync(session, target.artifactId);
      if (!artifact.ok) return artifact;
      return read(session, artifact.path);
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  }
  return read(session, target);
}
module.exports = { read, readAsync };
