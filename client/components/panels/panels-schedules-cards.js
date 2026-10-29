/* Automation reading surface. Scheduling, editing and execution remain in their existing controllers. */
function _schRenderLoadWarning(body) {
  if (!_schLoadError || !(_schRows || []).length) return;
  body.insertAdjacentHTML('afterbegin', '<div class="sch-stale-notice" role="status" aria-live="polite">' +
    '<div><b>刷新失败</b><span>当前显示上次读取的数据，状态可能已变化。</span>' +
    '<small>' + esc(_schLoadError) + '</small></div>' +
    '<button type="button" class="btn-mini" data-sch-refresh>重新加载</button></div>');
  const retry = body.querySelector('[data-sch-refresh]');
  retry.addEventListener('click', async () => {
    if (retry.disabled) return;
    retry.disabled = true; retry.textContent = '正在重新加载…';
    try { await _loadSch(); }
    finally {
      if (retry.isConnected) { retry.disabled = false; retry.textContent = '重新加载'; }
    }
  });
}

function _schVisualIcon(name) {
  const paths = {
    daily: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    template: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16M9 9v11"/>',
    weekly: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 17h2"/>',
    inspect: '<rect x="3" y="4" width="18" height="15" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01m-2 7 2.5 2.5 5-5"/>',
    form: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v4H9zM9 12h6M9 16h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    agent: '<rect x="5" y="7" width="14" height="13" rx="4"/><path d="M12 3v4M2 12v4M22 12v4M9 12h.01M15 12h.01M9 16h6"/>',
    folder: '<path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (paths[name] || paths.clock) + '</svg>';
}

function _schCardAssignee(id) {
  const raw = String(id || '');
  const known = (_schAgents.find(a => a.id === id) || {}).name;
  if (known && !/^runner:/i.test(known)) return known;
  // Older schedules store a routing key; show the known runtime without changing that key.
  const runtime = raw.split(':').pop().toLowerCase();
  const names = { pi: 'Pi', opencode: 'OpenCode', codex: 'Codex', 'codex-harness': 'Codex Harness',
    'claude-code': 'Claude Code', claude: 'Claude Code', 'qwen-code': 'Qwen Code', qwencode: 'Qwen Code',
    qwen: 'Qwen Code', 'deepseek-harness': 'DeepSeek Harness', harness2: 'Google Harness²' };
  return names[runtime] || (raw.startsWith('runner:') ? 'Agent' : known || raw || 'Agent');
}

function _schCardNote(note) {
  const value = String(note || '');
  if (!value) return '';
  if (value.length <= 110 && !value.includes('\n')) return '<p class="sch-i-note" data-user-content>' + esc(value) + '</p>';
  return '<details class="sch-i-description"><summary><span class="sch-i-note" data-user-content>' + esc(value) +
    '</span><span class="sch-i-expand"><span class="sch-expand-label">展开说明</span>' +
    '<span class="sch-collapse-label">收起说明</span>' + _schVisualIcon('chevron') + '</span></summary></details>';
}

function _schCardHtml(s) {
  const fired = s.every === 'once' && s.onceFired;
  const who = _schCardAssignee(s.assigneeId);
  const plugin = s.pluginBindingId ? _schFindPlugin(s.pluginBindingId) : _schmFind(s.personalPluginKey);
  const method = s.pluginBindingId ? (plugin && plugin.name) || '企业插件'
    : s.personalPluginKey ? (plugin && plugin.name) || s.personalPluginKey : '';
  const repo = s.repoId ? (_schRepos.find(r => r.id === s.repoId) || {}).name || s.repoId : '';
  const rh = _schRhythm(s).split(' ');
  const retry = s.retrying ? ' · 自动重试 ' + Number(s.retryCount || 0) + '/' + Number(s.retryLimit || 0) : '';
  // Keep the runtime identity visual and consistent with the chat composer.
  // The old card repeated the runtime name beside a generic robot, which made
  // the header noisy and could show the wrong base for older routing keys.
  const agentBrand = (typeof AgentBrand !== 'undefined' && AgentBrand)
    ? AgentBrand.html(s.assigneeId || who, { className: 'sch-i-agent-brand', title: who })
    : '<span class="sch-i-agent-brand" title="' + esc(who) + '">' + _schVisualIcon('agent') + '</span>';
  const executor = '<span class="sch-i-executor" aria-label="' + esc(who) + '">' + agentBrand + '</span>';
  const methodLabel = method
    ? '<span class="sch-i-method" data-user-content title="' + esc(method) + '">' + esc(method) + '</span>' : '';
  return '<article class="sch-item' + (s.enabled ? '' : ' off') + '" data-sid="' + esc(s.id) + '">' +
    '<div class="sch-i-body"><div class="sch-i-head"><div class="sch-i-when">' + _schVisualIcon('clock') +
      '<b>' + esc(rh[0]) + '</b><i>' + esc(rh.slice(1).join(' ')) + '</i></div>' +
      '<div class="sch-i-assignment">' + executor + methodLabel + '</div>' +
      '<span class="sch-i-state' + (s.enabled && !fired ? ' is-enabled' : '') + '">' +
      (fired ? '本次预约已触发' : s.enabled ? '已启用' : '已停用') + '</span></div>' +
    '<div class="sch-i-main"><div class="sch-i-top"><b class="sch-i-title" data-user-content title="' + esc(s.title) + '">' +
      esc(s.title) + '</b></div>' + _schCardNote(s.note) +
      (repo ? '<div class="sch-i-meta"><span class="sch-i-project">' + _schVisualIcon('folder') + '<b data-user-content title="' + esc(repo) + '">' + esc(repo) + '</b></span>' +
      (s.flow ? '<span class="sch-i-flow">（按研发流程走）</span>' : '') + '</div>' : '') +

      (s.lastError ? '<span class="sch-i-err" title="' + esc(s.lastError) + '">' + (s.retrying ? '等待重试' : '上次没派出去') + '</span>' : '') +
    '</div></div><div class="sch-i-foot"><span class="sch-i-timing"><span class="sch-i-next">' +
      esc(_schCardNext(s)) + '</span>' +
      (s.lastRunAt ? '<span class="sch-i-last">上次 ' + esc(_schLocal(s.lastRunAt)) + esc(retry) + '</span>' : '') +
    '</span><span class="sch-i-ops" role="group" aria-label="自动化操作">' +
      _schActionButton('run', '立刻跑一次') + _schActionButton('runs', '执行记录') +
      _schActionButton('edit', '编辑自动化') + _schActionButton('del', '删除自动化') + '</span></div></article>';
}

function _schCardNext(s) {
  if (s.every === 'once' && s.onceFired) return s.retrying ? '等待重试' : '不再自动触发';
  if (!s.enabled) return '已停用，不会自动跑';
  if (s.every === 'once') {
    if (Date.parse(s.runAt) <= Date.now()) return '等待补跑一次';
    const local = window.ScheduleTiming?.localInput(s.runAt, s.timeZone || _schBrowserTimeZone()) || '';
    return '下次 ' + (s.nextRunLocal || local.replace('T', ' ')) + ' · ' + _schTimeZoneLabel(s.timeZone);
  }
  return '下次 ' + (s.nextRunLocal || _schLocal(s.nextRunAt));
}
