/* Portable Agent/model directory shared by plugin authoring and execution entry points. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SoduWorkPluginRoutes = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const LOCAL_KIND = /^local:[a-z0-9][a-z0-9-]{0,31}$/;
  const DEFAULTS = [
    { key: '', name: '跟随企业默认', modelPick: true },
    { key: 'local:pi', name: 'Pi', modelPick: true },
    { key: 'local:opencode', name: 'OpenCode', modelPick: true },
    { key: 'local:codex', name: 'Codex', modelPick: false },
    { key: 'hosted', name: '托管 Agent', modelPick: false },
  ];

  function isPortableAgentKind(value) {
    const key = String(value || '').trim().toLowerCase();
    return key === '' || key === 'hosted' || LOCAL_KIND.test(key);
  }

  function capabilityList(value) {
    const report = value && typeof value === 'object' ? value : {};
    const source = Array.isArray(value) ? value :
      (Array.isArray(report.available) ? report.available : []);
    return [...new Set(source.map(item => String(item || '').trim().toLowerCase())
      .filter(Boolean))];
  }

  function capableSeats(kind, required) {
    const needs = capabilityList(required);
    const seats = Array.isArray(kind && kind.seats) ? kind.seats : [];
    if (!needs.length) return Number(kind && kind.onlineSeats || 0);
    return seats.filter(seat => {
      const available = new Set(capabilityList(seat && seat.capabilities));
      return needs.every(key => available.has(key));
    }).length;
  }

  function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const byKey = new Map(DEFAULTS.map(item => [
      item.key, { ...item, onlineSeats: 0, seats: [] },
    ]));
    (Array.isArray(source.kinds) ? source.kinds : []).forEach(function (item) {
      const key = String(item && item.key || '').trim().toLowerCase();
      if (!isPortableAgentKind(key)) return;
      const previous = byKey.get(key) || { key, onlineSeats: 0, seats: [] };
      byKey.set(key, {
        ...previous, key, name: String(item.name || previous.name || key),
        modelPick: item.modelPick !== false, note: String(item.note || ''),
      });
    });
    (Array.isArray(source.agents) ? source.agents : []).forEach(function (agent) {
      if (!agent || agent.online === false) return;
      const cli = String(agent.cli || '').trim().toLowerCase();
      const id = String(agent.id || '');
      let key = cli ? 'local:' + cli : '';
      if (key && !LOCAL_KIND.test(key)) key = '';
      if (!key && id && !id.startsWith('local:') && !id.startsWith('runner:')) key = 'hosted';
      if (!key) return;
      const previous = byKey.get(key) || {
        key, name: String(agent.cliName || cli || key),
        modelPick: agent.modelPick !== false, onlineSeats: 0, seats: [],
      };
      previous.onlineSeats = Number(previous.onlineSeats || 0) + 1;
      if (!Array.isArray(previous.seats)) previous.seats = [];
      previous.seats.push({
        capabilities: capabilityList(agent.capabilities),
      });
      byKey.set(key, previous);
    });
    const modelSource = [source.defaultModel].concat(
      Array.isArray(source.models) ? source.models : []);
    return {
      loaded: Boolean(raw), kinds: [...byKey.values()],
      models: [...new Set(modelSource.map(value => String(value || '').trim()).filter(Boolean))],
      defaultModel: String(source.defaultModel || ''),
      reason: String(source.reason || ''),
    };
  }

  return { capableSeats, isPortableAgentKind, normalize };
});
