'use strict';
const fs = require('node:fs'), path = require('node:path');
const ID = /^[a-z][a-z0-9-]{1,60}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function readOnly(tool) {
  // POST can carry fixed read-only queries for GraphQL, Notion, and Slack; validate the operation.
  // PUT, PATCH, and DELETE require write permission even if a definition labels them read-only.
  return tool.readOnly === true && ['GET', 'HEAD', 'POST'].includes(tool.method || 'GET');
}
function provider(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw Error('连接器标识无效');
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers', id + '.json'), 'utf8')); }
  catch { throw Error('当前执行机缺少此连接器，请升级客户端或 Runner'); }
  if (!plain(value) || value.schemaVersion !== 1 || value.id !== id || !Array.isArray(value.tools)
    || !value.tools.length || !Array.isArray(value.fields)) throw Error('连接器定义无效');
  const fields = new Set(), names = new Set();
  for (const field of value.fields) {
    if (!plain(field) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(field.key) || fields.has(field.key)) throw Error('连接器字段定义无效');
    fields.add(field.key);
  }
  for (const tool of value.tools) {
    if (!plain(tool) || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(tool.name) || names.has(tool.name)
      || !plain(tool.inputSchema)) throw Error('连接器工具定义无效');
    names.add(tool.name);
  }
  if (value.tools.some(tool => !readOnly(tool)) && !fields.has('ALLOW_WRITES')) {
    value.fields.push({ key: 'ALLOW_WRITES', label: '写入权限', default: 'false', pattern: '^(true|false)$' });
  }
  return value;
}
function spend(value, budget) {
  if (++budget.nodes > 10000) throw Error('参数结构过大');
  if (typeof value === 'string') budget.bytes += Buffer.byteLength(value);
  if (budget.bytes > MAX_JSON_BYTES) throw Error('参数内容超过 2 MB');
}
function keys(value) {
  const entries = Object.entries(value);
  if (Object.getOwnPropertySymbols(value).length || entries.some(([key]) => UNSAFE.has(key))) throw Error('参数键无效');
  return entries;
}
// additionalProperties:true permits bounded JSON, including objects nested inside arrays.
// Strict objects still reject unknown fields without imposing that rule on sibling parameters.
function jsonValue(value, depth, budget) {
  if (depth > 12) throw Error('参数嵌套过深');
  spend(value, budget);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 10000) throw Error('文本参数无效或过长');
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw Error('数组参数无效或过大');
    for (const item of value) jsonValue(item, depth + 1, budget);
    return;
  }
  if (!plain(value)) throw Error('参数应为 JSON 值');
  const entries = keys(value);
  if (entries.length > 100) throw Error('参数字段过多');
  for (const [key, item] of entries) { budget.bytes += Buffer.byteLength(key); jsonValue(item, depth + 1, budget); }
}
function input(value, schema = {}, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (depth > 12) throw Error('参数嵌套过深');
  if (!plain(schema)) throw Error('连接器参数定义无效');
  if (depth > 0 && !Object.keys(schema).length) { jsonValue(value, depth, budget); return value; }
  spend(value, budget);
  const kind = schema.type || (depth > 0 ? (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value) : 'object');
  if (kind === 'null') { if (value !== null) throw Error('参数应为空值'); }
  else if (kind === 'object') {
    if (!plain(value)) throw Error('参数应为对象');
    const props = schema.properties || {};
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw Error('缺少参数：' + key);
    const entries = keys(value);
    if (entries.length > Math.min(schema.maxProperties ?? 100, 100)) throw Error('参数字段过多');
    for (const [key, item] of entries) {
      budget.bytes += Buffer.byteLength(key);
      if (Object.hasOwn(props, key)) input(item, props[key], depth + 1, budget);
      else if (schema.additionalProperties === true) jsonValue(item, depth + 1, budget);
      else if (plain(schema.additionalProperties)) input(item, schema.additionalProperties, depth + 1, budget);
      else throw Error('不支持参数：' + key);
    }
  } else if (kind === 'array') {
    if (!Array.isArray(value) || value.length > Math.min(schema.maxItems ?? 100, 100) || value.length < (schema.minItems ?? 0)) throw Error('数组参数无效或过大');
    for (const item of value) input(item, schema.items || {}, depth + 1, budget);
  } else if (kind === 'string') {
    if (typeof value !== 'string' || value.length > Math.min(schema.maxLength ?? 10000, 10000) || value.length < (schema.minLength ?? 0)) throw Error('文本参数无效或过长');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw Error('参数格式不正确');
  } else if (kind === 'integer' || kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || kind === 'integer' && !Number.isInteger(value)
      || value < (schema.minimum ?? -1e12) || value > (schema.maximum ?? 1e12)) throw Error('数值参数不在允许范围内');
  } else if (kind === 'boolean') { if (typeof value !== 'boolean') throw Error('参数应为布尔值'); }
  else throw Error('暂不支持此参数类型');
  if (schema.enum && !schema.enum.includes(value)) throw Error('参数不在可选范围内');
  return value;
}
function settings(def, values = {}) {
  if (!plain(values)) throw Error('连接器配置必须为对象');
  const result = {};
  for (const key of Object.keys(values)) if (UNSAFE.has(key) || !def.fields.some(field => field.key === key)) throw Error('连接器配置包含未声明字段');
  for (const field of def.fields) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(field.key)) throw Error('连接器字段定义无效');
    const raw = values[field.key] ?? field.default ?? '';
    if (!['string', 'boolean', 'number'].includes(typeof raw)) throw Error('连接器字段必须为文本：' + field.label);
    const value = String(raw);
    if (field.required && !value) throw Error('请先配置连接器：' + field.label);
    if (value.length > 16384 || /[\x00-\x1f\x7f]/.test(value) || field.pattern && value && !new RegExp(field.pattern).test(value)) throw Error('连接器字段格式不正确：' + field.label);
    result[field.key] = value;
  }
  return result;
}
module.exports = { provider, input, settings, plain, readOnly };
