'use strict';

/* Native account runtimes own their credentials and model catalog. SoduWork only
   reads the small, credential-free Codex cache projection needed by the
   composer. Reading happens on every request so a Codex update never requires
   restarting SoduWork. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const REASONING_EFFORTS = new Set([
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);

function _text(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function _codexHome(options) {
  const opts = options || {};
  const configured = _text(opts.codexHome || (opts.env || process.env).CODEX_HOME, 1200);
  return configured ? path.resolve(configured) : path.join(opts.homeDir || os.homedir(), '.codex');
}

function _reasoningLevels(value) {
  const rows = Array.isArray(value) ? value : [];
  return [...new Set(rows.map((item) => _text(
    item && typeof item === 'object' ? (item.effort || item.name) : item, 24,
  ).toLowerCase()).filter((item) => REASONING_EFFORTS.has(item)))];
}

function listCodexModels(options) {
  const cachePath = path.join(_codexHome(options), 'models_cache.json');
  if (!fs.existsSync(cachePath)) {
    return {
      ok: true, adapterId: 'codex', source: 'codex-cache', models: [],
      reason: 'Codex 尚未生成本机模型目录；可以先使用 Codex 默认模型',
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.models) ? payload.models : []);
    const models = rows.map((item) => {
      const slug = _text(item && (item.slug || item.id || item.name), 160);
      const visibility = _text(item && item.visibility, 24).toLowerCase();
      if (!SAFE_MODEL.test(slug) || visibility === 'hide' || Boolean(item && item.hidden)) return null;
      const reasoningLevels = _reasoningLevels(item &&
        (item.supported_reasoning_levels || item.supportedReasoningLevels));
      const defaultReasoning = _text(item &&
        (item.default_reasoning_level || item.defaultReasoningLevel), 24).toLowerCase();
      return {
        id: slug,
        label: _text(item && (item.display_name || item.displayName), 120) || slug,
        reasoningLevels,
        defaultReasoning: REASONING_EFFORTS.has(defaultReasoning) ? defaultReasoning : '',
      };
    }).filter(Boolean);
    return {
      ok: true,
      adapterId: 'codex',
      source: 'codex-cache',
      fetchedAt: _text(payload && (payload.fetched_at || payload.fetchedAt), 80),
      models,
    };
  } catch (error) {
    return {
      ok: false, adapterId: 'codex', source: 'codex-cache', models: [],
      reason: '本机 Codex 模型目录暂时无法读取，可继续使用 Codex 默认模型',
    };
  }
}

function list(adapterId, options) {
  const id = _text(adapterId, 40).toLowerCase();
  if (id === 'codex') return listCodexModels(options);
  return { ok: true, adapterId: id, source: '', models: [] };
}

module.exports = { list, listCodexModels, REASONING_EFFORTS };
