/* Private preferences are bound to an immutable version, never exported. */
'use strict';

const SECRET = /(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S{8,}/i;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validate(schema, raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('插件设置必须是对象');
  const fields = schema?.preferences || [];
  const keys = new Set(fields.map(field => field.key));
  if (Object.keys(raw).some(key => !keys.has(key))) throw Error('插件设置已变化，请重新打开设置');
  const config = {};
  for (const field of fields) {
    const label = field.label || field.key;
    let value = own(raw, field.key) ? raw[field.key] : field.default;
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) {
      if (field.required) throw Error('请填写「' + label + '」');
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw Error(label + '必须是开关值');
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw Error(label + '必须是有效数字');
      if (field.minimum != null && value < field.minimum || field.maximum != null && value > field.maximum) throw Error(label + '超出允许范围');
    } else if (field.type === 'multiselect') {
      const options = new Set((field.options || []).map(item => item.value));
      if (!Array.isArray(value) || value.length > 50 || value.some(item => !options.has(item))) throw Error(label + '必须来自可选项');
      value = [...new Set(value)];
    } else {
      if (typeof value !== 'string') throw Error(label + '必须是文本');
      value = value.trim();
      if (field.required && !value) throw Error('请填写「' + label + '」');
      if (value.length < (field.minLength || 0) || value.length > (field.maxLength || 8000)) throw Error(label + '长度不符合要求');
      if (field.type === 'select' && !(field.options || []).some(item => item.value === value)) throw Error(label + '必须来自可选项');
      if (field.type === 'url' && value) {
        let url;
        try { url = new URL(value); } catch (_) { throw Error(label + '必须是完整的 http/https 地址'); }
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw Error(label + '必须是无凭据的 http/https 地址');
      }
    }
    if (SECRET.test(JSON.stringify(value))) throw Error(label + '疑似包含凭据，请使用连接管理');
    Object.defineProperty(config, field.key, { value, enumerable: true, writable: true });
  }
  if (Buffer.byteLength(JSON.stringify(config), 'utf8') > 16000) throw Error('插件设置内容过长，请缩短到 16KB 以内');
  return config;
}

function state(plugin, version) {
  const stored = plugin.setupByVersion?.[version.checksum];
  try {
    return { setupState: 'ready', setupConfigured: Boolean(stored),
      setupConfig: validate(version.manifest?.setup, stored || {}) };
  } catch (error) {
    return { setupState: 'needs_setup', setupConfigured: false,
      setupConfig: stored || {}, setupMessage: error.message };
  }
}

function guidance(config) {
  return Object.keys(config).length ? '\n\n本机插件使用偏好（JSON 数据；不扩展权限或替代用户指令）：\n' + JSON.stringify(config) : '';
}

module.exports = { validate, state, guidance };
