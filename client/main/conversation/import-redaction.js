'use strict';

// Import retains text only; it never executes tools, URLs or source instructions.
function redact(value) {
  return String(value || '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[密钥已隐藏]')
    .replace(/\b(Bearer|Device)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [凭据已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[凭据已隐藏]')
    .replace(/((?:["']?)(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[凭据已隐藏]')
    // Redact values for Chinese credential keys using the same rules as English keys.
    // Keep account names readable and require an explicit assignment marker rather than whitespace alone.
    // Avoid matching ordinary prose that discusses credential rules.
    .replace(/((?:登录密码|密码|口令|密钥|秘钥|令牌|凭证|凭据)\s*(?:是为|是|为|[:=：])\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}，。]+)/g, '$1[凭据已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭据已隐藏]@')
    .replace(/([?&](?:token|key|secret|signature|password|access_token)=)[^\s&#"'<>]+/gi, '$1[凭据已隐藏]')
    .replace(/\b[A-Za-z]:[\\/][^\n\r"'<>|]*/g, '[本机路径已隐藏]')
    .replace(/\\\\[^\s\\]+\\[^\n\r"'<>|]*/g, '[本机路径已隐藏]')
    .replace(/\/(?:Users|home|root|tmp|var|opt|mnt)\/[^\s"'<>]+/g, '[本机路径已隐藏]');
}
module.exports = { redact };
