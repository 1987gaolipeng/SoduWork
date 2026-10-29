'use strict';
const path = require('node:path');
function clean(value, redact) {
  return String(redact(String(value || '')))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[凭据已隐藏]')
    .replace(/\b(Bearer|Device)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [凭据已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[凭据已隐藏]')
    .replace(/(["']?(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret|token|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[凭据已隐藏]')
    .replace(/(--(?:password|token|secret|api-key)\s+)(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, '$1[凭据已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭据已隐藏]@')
    .replace(/([?&](?:token|key|secret|signature|password|access_token)=)[^\s&#"'<>]+/gi, '$1[凭据已隐藏]');
}
function project(item, { cwd = '', redact = value => value } = {}) {
  if (!item || typeof item.requestId !== 'string' || !Number.isSafeInteger(item.policyRevision)) return null;
  const labels = { 'file.read': '读取文件', 'file.write': '修改文件', 'command.execute': '执行命令',
    'terminal.execute': '执行命令', 'native.command': '执行命令', 'tool.execute': '调用工具' };
  const editing = item.action === 'native.tool' && item.kind === 'edit';
  const summary = labels[item.action] || (editing ? '修改文件' : '调用工具');
  const formatPath = value => {
    const source = String(value || '');
    if (!cwd || !path.isAbsolute(source)) return source;
    const relative = path.relative(cwd, source);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? relative : source;
  };
  let detail;
  if (summary === '执行命令') detail = item.arguments?.command || item.target;
  else if (editing && Array.isArray(item.arguments?.changes)) detail = item.arguments.changes
    .map(change => formatPath(change.path)).filter(Boolean).join('\n');
  else if (summary.includes('文件')) detail = formatPath(item.target);
  else detail = [item.tool || item.title, item.target].filter(Boolean).join(' · ');
  detail = clean(detail, redact);
  const reviewable = Boolean(detail.trim()) && detail.length <= 12000;
  return { requestId: item.requestId, policyRevision: item.policyRevision, summary,
    detail: detail.slice(0, 12000), reviewable };
}
module.exports = { project, clean };
