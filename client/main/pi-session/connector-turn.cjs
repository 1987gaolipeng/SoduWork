'use strict';
const context = require('./connector-context.cjs');
const unavailable = '本轮额外会话连接器暂时无法确认。正常处理不需要连接器的请求；需要外部数据时如实说明暂不可用，不声称已查询或成功执行。显式插件已有的授权保持独立。';
async function prepare(options, cancelled = () => false, excludeServers = []) {
  if (typeof options?.resolveConnectors !== 'function') return { cleanup() {}, redact: value => String(value || ''),
    augment: (value, extraGuide) => extraGuide ? context.augment(value, extraGuide) : value };
  let grant = null, cleaned = false;
  const cleanup = () => { if (!cleaned) { cleaned = true; try { grant?.cleanup?.(); } catch (_) {} } };
  const redact = value => grant?.redact ? grant.redact(String(value || '')) : String(value || '');
  try {
    grant = await options.resolveConnectors({
      readOnly: Boolean(options.readOnly || options.accessPolicy?.mode === 'readonly'),
      cancelled, excludeServers,
    });
    if (cancelled()) { cleanup(); return { cleanup, redact, augment: value => value }; }
    return { cleanup, redact, hasSecrets: Boolean(grant?.servers?.length && grant?.redact),
      augment: (value, extraGuide) => context.augment(value, [grant?.guide || unavailable, extraGuide].filter(Boolean).join('\n\n')) };
  } catch (_) {
    cleanup();
    return { cleanup, redact,
      augment: (value, extraGuide) => context.augment(value, [unavailable, extraGuide].filter(Boolean).join('\n\n')) };
  }
}
module.exports = { prepare };
