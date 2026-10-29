'use strict';

// Capability declarations are names, never connector configuration or a map
// of inferred permissions. Preserve the established comma-separated shorthand.
function normalize(value, field) {
  if (value != null && typeof value !== 'string' && !Array.isArray(value) ||
      Array.isArray(value) && value.some(item => typeof item !== 'string')) {
    throw new Error('插件 ' + field + ' 必须是字符串数组' + (field === 'mcpServers'
      ? '（无连接器时填写 []）；连接器配置对象应保存在随包连接模板中'
      : '，例如 ["files"]；不能使用 {"files":true} 这类对象'));
  }
  const values = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
  return [...new Set(values.map(item => item.trim().slice(0, 80)).filter(Boolean))].slice(0, 30);
}

module.exports = { normalize };
