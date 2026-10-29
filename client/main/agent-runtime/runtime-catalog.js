'use strict';

// Hub, Runner and desktop use the same reviewed Agent declarations. Only
// presentation and capability metadata cross into the renderer.
const fs = require('node:fs');
const path = require('node:path');
const { RuntimeContractError } = require('./contract');

function invalid(message) {
  throw new RuntimeContractError('INVALID_RUNTIME_CATALOG', message);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function normalize(row) {
  if (!row || !/^[a-z][a-z0-9-]{0,39}$/.test(row.id || '')) invalid('Invalid Agent id');
  if (typeof row.displayName !== 'string' || !row.displayName.trim()) invalid('Missing Agent name: ' + row.id);
  if (!['direct', 'runner'].includes(row.transport) ||
      !['managed', 'account'].includes(row.modelMode) ||
      !['native', 'none'].includes(row.goalMode)) invalid('Invalid runtime modes: ' + row.id);
  if (row.transport === 'direct' && row.id !== 'pi') invalid('Direct runtimes require a dedicated adapter: ' + row.id);
  const policy = row.accessControl;
  if (!policy || policy.schema !== 'soduwork.access-policy/v1' || typeof policy.supported !== 'boolean' ||
      JSON.stringify(policy.modes) !== JSON.stringify(policy.supported ? ['standard', 'readonly', 'full'] : [])) {
    invalid('Invalid access declaration: ' + row.id);
  }
  return freeze({
    id: row.id, displayName: row.displayName.trim(), summary: String(row.summary || ''),
    transport: row.transport, modelMode: row.modelMode, goalMode: row.goalMode,
    group: row.group === 'recommended' ? 'recommended' : 'more',
    order: Number.isFinite(row.order) ? row.order : 999,
    accessControl: { schema: policy.schema, supported: policy.supported,
      modes: [...new Set(policy.modes)], approval: String(policy.approval || ''), sandbox: policy.sandbox === true },
  });
}

function createRuntimeCatalog(document) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.agents) || !document.agents.length) {
    invalid('Unsupported or empty Agent catalog');
  }
  const rows = document.agents.map(normalize).sort((a, b) => a.order - b.order);
  const byId = new Map();
  rows.forEach(row => {
    if (byId.has(row.id)) invalid('Duplicate Agent id: ' + row.id);
    byId.set(row.id, row);
  });
  const runtime = id => byId.get(String(id || '')) || null;
  return Object.freeze({
    RUNTIMES: Object.freeze(rows), runtime,
    runtimes: () => rows.slice(),
    runnerRuntimes: () => rows.filter(row => row.transport === 'runner'),
    publicRuntime(item, capabilities) {
      const row = typeof item === 'string' ? runtime(item) : item && runtime(item.id);
      if (!row) return null;
      return freeze({ ...row, capabilities: (Array.isArray(capabilities) ? capabilities : [])
        .map(value => String(value && value.id || value || '')).filter(Boolean) });
    },
  });
}

function loadCatalog({ resourcesPath = process.resourcesPath,
  isPackaged = /(?:^|[/\\])[^/\\]+\.asar(?:[/\\]|$)/.test(__dirname),
  sourceFile = path.resolve(__dirname, '../../../hub-backend/app/agent_catalog.json') } = {}) {
  const packaged = resourcesPath && path.join(resourcesPath, 'agent_catalog.json');
  if (isPackaged && (!packaged || !fs.existsSync(packaged))) {
    invalid('Installed Agent catalog is missing; repair or reinstall SoduWork');
  }
  const file = packaged && fs.existsSync(packaged) ? packaged : sourceFile;
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { invalid('Agent catalog cannot be read; repair the configuration or reinstall SoduWork'); }
  return createRuntimeCatalog(document);
}

function mutableCatalog(initial) {
  let catalog = initial;
  return Object.freeze({
    get RUNTIMES() { return catalog.RUNTIMES; },
    runtime: id => catalog.runtime(id), runtimes: () => catalog.runtimes(),
    runnerRuntimes: () => catalog.runnerRuntimes(),
    publicRuntime: (item, capabilities) => catalog.publicRuntime(item, capabilities),
    addRuntime(row) {
      const normalized = normalize(row), existing = catalog.runtime(normalized.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(normalized)) invalid('Agent already registered: ' + normalized.id);
        return existing;
      }
      catalog = createRuntimeCatalog({ schemaVersion: 1, agents: [...catalog.runtimes(), normalized] });
      return catalog.runtime(normalized.id);
    },
  });
}
const catalog = mutableCatalog(loadCatalog());
module.exports = { ...catalog, get RUNTIMES() { return catalog.RUNTIMES; },
  createRuntimeCatalog, loadCatalog, mutableCatalog, normalize };
