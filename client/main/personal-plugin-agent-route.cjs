'use strict';

const catalog = require('./agent-runtime/runtime-catalog');
const spelling = value => String(value).normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');

// Resolve only known runtime names and IDs; never replace an unknown runtime with the current agent.
// Apply compatibility resolution to immutable versions without rewriting plugin files or hashes.
function normalize(value, runtimeCatalog = catalog) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw || raw === 'hosted') return raw;
  const name = raw.replace(/^local:/, '');
  const exact = runtimeCatalog.runtime(name);
  if (exact) return 'local:' + exact.id;
  const matches = runtimeCatalog.runtimes().filter(row =>
    spelling(row.id) === spelling(name) || spelling(row.displayName) === spelling(name));
  return matches.length === 1 ? 'local:' + matches[0].id : raw;
}

function read(config = {}, runtimeCatalog = catalog) {
  const nested = config.execution && typeof config.execution === 'object' && !Array.isArray(config.execution)
    ? config.execution : {};
  const misplaced = ['agent', 'agentId', 'adapterId', 'runtime'].some(key =>
    Object.hasOwn(config, key) || Object.hasOwn(nested, key));
  if (misplaced) throw new Error('底座路由字段不受支持；请使用 config.agentKind（Pi 为 local:pi，Qwen Code 为 local:qwen）');
  return {
    agentKind: normalize(nested.agentKind || config.agentKind, runtimeCatalog),
    model: nested.model || config.model || '',
    fallbackMode: nested.fallbackMode || config.fallbackMode || '',
    runnerTags: nested.runnerTags || config.runnerTags || [],
  };
}

function localCheck(graph) {
  const issues = [];
  for (const node of graph.nodes || []) {
    if (require('./personal-plugin-workflow').ENTERPRISE_TYPES.has(node.type)) {
      issues.push('“' + node.name + '”需要企业项目执行');
      continue;
    }
    if (!['ai', 'ai_review'].includes(node.type)) continue;
    const route = read(node.config), agent = route.agentKind.replace(/^local:/, '');
    if ((route.runnerTags || []).length) issues.push('“' + node.name + '”使用执行机标签，本机协作应改用 config.agentKind');
    else if (agent && !catalog.runtime(agent)) issues.push('“' + node.name + '”需要当前客户端未支持的执行底座');
  }
  return { key: 'local-workflow', ok: !issues.length, label: issues.length
    ? '本机执行限制：' + issues.join('；')
    : '本机工作流结构有效；运行前仍须检查底座、模型、能力与权限' };
}

module.exports = { normalize, read, localCheck };
