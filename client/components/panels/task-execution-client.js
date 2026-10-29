/*
 * Adapt the shared execution-options contract for creation, task details, and conversation
 * conversion. Backend options identify portable agent types, not short-lived Runner
 * instances.
 */
(function (global) {
  'use strict';

  const clean = (value) => String(value == null ? '' : value).trim();
  const keyOf = (value) => clean(value).toLowerCase();

  /* API versions in the wild have returned booleans, numbers and strings for
     availability. Missing availability is kept compatible with the legacy
     contract (the row is usable unless the server explicitly says otherwise). */
  function isAvailable(value) {
    if (!value || typeof value !== 'object') return false;
    const flag = value.available;
    if (flag === false || flag === 0) return false;
    const normalized = clean(flag).toLowerCase();
    return normalized !== 'false' && normalized !== '0' &&
      normalized !== 'no' && normalized !== 'offline' &&
      normalized !== 'unavailable';
  }

  async function load(body) {
    const api = global.SoduWorkAPI || {};
    if (!api.taskExecutionOptions) throw new Error('执行选项服务没有加载成功');
    return (await api.taskExecutionOptions(body || {})) || {};
  }

  function substrates(options, includeBlocked) {
    return ((options || {}).substrates || []).filter((item) =>
      item && item.key && (includeBlocked || isAvailable(item))).map((item) => ({
        id: clean(item.key),
        type: 'agent',
        cli: clean(item.cli),
        cliName: clean(item.name || item.cli),
        name: clean(item.name || item.cli || 'Agent'),
        online: isAvailable(item),
        available: isAvailable(item),
        busy: Number(item.onlineSeats || 0) > 0 &&
          Number(item.busySeats || 0) >= Number(item.onlineSeats || 0),
        onlineSeats: Number(item.onlineSeats || 0),
        modelPick: item.modelPick !== false,
        modelSource: clean(item.modelSource),
        nativeModelPick: item.nativeModelPick === true,
        capabilitySets: Array.isArray(item.capabilitySets) ? item.capabilitySets : [],
        versions: Array.isArray(item.versions) ? item.versions.filter(Boolean) : [],
        locations: Array.isArray(item.locations) ? item.locations : [],
        locationMode: clean(item.locationMode),
        locationLabel: clean(item.locationLabel),
        remote: item.remote === true || clean(item.locationMode) === 'remote',
        local: item.local !== false && clean(item.locationMode) !== 'remote',
        note: clean(item.note),
        requiredCapabilities: Array.isArray(item.requiredCapabilities)
          ? item.requiredCapabilities.filter(Boolean) : [],
      }));
  }

  function workflows(options) {
    return ((options || {}).workflows || []).filter((item) =>
      item && item.bindingId && item.runnable !== false);
  }

  function blockedWorkflows(options) {
    return ((options || {}).blockedWorkflows || []).filter((item) =>
      item && item.bindingId && item.runnable === false);
  }

  /* A binding id only identifies a configured candidate; it is not proof that the
     candidate can run right now. Keep blocked rows available to the UI so it can
     explain the missing setup, but every automatic/default selection must come
     through this helper. */
  function runnableWorkflow(items, value) {
    const wanted = keyOf(value);
    if (!wanted) return null;
    return (items || []).find((item) => item && item.runnable !== false && (
      keyOf(item.bindingId) === wanted || keyOf(item.key) === wanted ||
      keyOf(item.name) === wanted
    )) || null;
  }

  function workflowProblem(options, value) {
    const rows = workflows(options).concat(blockedWorkflows(options));
    const wanted = keyOf(value);
    const exact = wanted ? rows.find((item) => item && (
      keyOf(item.bindingId) === wanted || keyOf(item.key) === wanted ||
      keyOf(item.name) === wanted
    )) : null;
    const row = exact || (!wanted
      ? rows.find((item) => item && item.recommended && item.runnable === false) ||
        rows.find((item) => item && item.runnable === false) : null);
    const readiness = (row && row.readiness) || {};
    return clean((readiness.blockers || [])[0]) ||
      clean((readiness.warnings || [])[0]) ||
      (row ? '\u8fd9\u5957\u5de5\u4f5c\u65b9\u6cd5\u5f53\u524d\u672a\u901a\u8fc7\u8fd0\u884c\u524d\u68c0\u67e5' :
        '\u5f53\u524d\u5de5\u7a0b\u6ca1\u6709\u53ef\u8fd0\u884c\u7684\u5de5\u4f5c\u6d41');
  }

  function repos(options) {
    return ((options || {}).repos || []).filter((item) => item && item.id);
  }

  function pickAgent(options, agents) {
    const rows = (agents || []).filter(isAvailable);
    if (!rows.length) return null;
    const recommended = keyOf(((options || {}).recommendation || {}).substrateKey);
    return rows.find((item) => keyOf(item.id) === recommended) ||
      rows.find((item) => !item.busy) || rows[0];
  }

  function agentSub(agent) {
    if (!agent) return '';
    const parts = [];
    const route = agent.locationLabel || (agent.remote
      ? String.fromCharCode(0x8fdc, 0x7a0b) + ' Runner'
      : String.fromCharCode(0x672c, 0x673a));
    if (!isAvailable(agent)) parts.push(agent.note || '当前设备尚未就绪');
    else {
      parts.push(route);
      if (agent.onlineSeats) parts.push(agent.onlineSeats + ' 个在线席位');
      if (agent.busy) parts.push('正在忙，可排队');
    }
    if ((agent.versions || []).length) parts.push('v' + agent.versions.join(' / '));
    return parts.filter(Boolean).join(' · ');
  }

  function agentKind(agent) {
    const id = clean(agent && agent.id).toLowerCase();
    if (/^local:[a-z0-9][a-z0-9-]{0,47}$/.test(id)) return id;
    const cli = clean(agent && agent.cli).toLowerCase();
    return /^[a-z0-9][a-z0-9-]{0,47}$/.test(cli) ? 'local:' + cli : '';
  }

  function firstAINode(flow) {
    const workflow = flow && flow.workflow;
    const nodes = Array.isArray(workflow) ? workflow : (workflow && workflow.nodes) || [];
    return nodes.find(node => node && ['ai', 'ai_review', 'agent'].includes(keyOf(node.type))) || null;
  }

  function nodeAgentLabel(flow) {
    const node = firstAINode(flow), route = node && node.route || {};
    if (!route.agentKind || !['plugin', 'project'].includes(route.agentSource)) return '';
    return '首个 AI 节点 · ' + clean(node.name || node.key) + ' · ' +
      clean(route.agentKind).replace(/^local:/, '') +
      (route.model ? ' · ' + clean(route.model) : ' · 跟随节点模型配置');
  }

  function context(options, selection) {
    if (global.TaskExecutionContext) {
      return global.TaskExecutionContext.normalize(options || {}, selection || {});
    }
    return { schemaVersion: 1, strategy: clean((selection || {}).strategy) || 'direct' };
  }

  function contextPayload(value, extra) {
    const c = value || {};
    const out = { executionContext: c, execution: execution(c) };
    return Object.assign(out, extra || {});
  }

  function execution(agent, model) {
    const out = {};
    const kind = agentKind(agent);
    if (kind) out.agentKind = kind;
    if (agent && agent.modelPick !== false && clean(model)) out.model = clean(model);
    return out;
  }

  function repoPayload(repo, root) {
    if (!repo) return null;
    const base = clean(root);
    const sep = base.indexOf('\\') >= 0 ? '\\' : '/';
    const sub = clean(repo.localDir || repo.name)
      .replace(/[\\/]+/g, sep).replace(/^[\\/]+|[\\/]+$/g, '');
    return {
      id: repo.id,
      path: base ? (sub ? base + sep + sub : base) : '',
      name: repo.name,
      kind: repo.kind,
      gitUrl: repo.gitUrl,
      branch: repo.branch,
      note: repo.note,
      flow: true,
    };
  }

  global.TaskExecutionClient = {
    load, substrates, workflows, blockedWorkflows, repos, pickAgent,
    runnableWorkflow, workflowProblem,
    agentSub, agentKind, execution, repoPayload, context, contextPayload, isAvailable,
    firstAINode, nodeAgentLabel,
  };
})(window);
