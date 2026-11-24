'use strict';

(function (global) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

  function runtimeName(row, overview) {
    const key = row.agent;
    if (!key || key === 'unknown' || key === 'app-ai') return '';
    const names = overview.agentNames || {};
    if (Object.hasOwn(names, key) && names[key]) return names[key];
    // Older summaries may lack the display-name map. Match known IDs exactly.
    const labels = global.AgentBrand?.LABELS || {};
    return key !== 'custom' && Object.hasOwn(labels, key) ? labels[key] : '';
  }

  function agentKind(row, overview) {
    if (row.agent === 'app-ai') return 'direct';
    return runtimeName(row, overview) ? 'runtime' : 'unidentified';
  }

  function otherAgentTokens(overviews) {
    const totals = {direct: 0, unidentified: 0};
    for (const overview of overviews) {
      for (const row of overview.byAgent || []) {
        const kind = agentKind(row, overview);
        if (kind !== 'runtime') totals[kind] += count(row.tokens) || 0;
      }
    }
    return totals;
  }

  function rank(overviews, dimension) {
    const groups = new Map();
    for (const overview of overviews.filter(Boolean)) {
      const scene = dimension === 'scene';
      for (const row of (scene ? overview.bySource : overview.byAgent) || []) {
        let key, label;
        if (scene) {
          key = row.key;
          label = row.label;
        } else if (dimension === 'model') {
          key = JSON.stringify([row.provider || '', row.modelRef || row.model || '']);
          label = row.model || '未知模型';
        } else {
          if (agentKind(row, overview) !== 'runtime' || !count(row.tokens)) continue;
          key = row.agent;
          label = runtimeName(row, overview);
        }
        const group = groups.get(key);
        const tokens = count(row.tokens) || 0;
        if (group) {
          group.tokens += tokens;
          // One conversation may span models, runtimes or funding sources.
          // The grouped rows do not carry session IDs for deduplication.
          group.sessions = undefined;
        } else {
          groups.set(key, { key, label, tokens, sessions: count(row.sessions) });
        }
      }
    }
    return [...groups.values()].sort((a,b) => b.tokens - a.tokens || String(a.label).localeCompare(String(b.label)));
  }

  function quotaPeriods(quota) {
    if (!quota || typeof quota.enabled !== 'boolean') return [];
    const period = { period: quota.period, resetAt: quota.resetsAt, expiresAt: quota.expiresAt };
    const unlimited = quota.totalLimited === false || quota.enabled === false;
    const rows = [{ ...period, label: quota.planName || '总额度',
      limit: unlimited ? null : count(quota.limit), used: count(quota.used),
      remaining: unlimited ? null : count(quota.remaining) }];
    for (const model of quota.models || []) {
      rows.push({ ...period, label: [model.provider, model.model].filter(Boolean).join(' · '),
        limit: count(model.limit), used: count(model.used), remaining: count(model.remaining) });
    }
    return rows;
  }

  const metrics = { rank, quotaPeriods, runtimeName, agentKind, otherAgentTokens };
  if (typeof module !== 'undefined' && module.exports) module.exports = metrics;
  else global.SoduWorkUsageMetrics = metrics;
})(globalThis);
