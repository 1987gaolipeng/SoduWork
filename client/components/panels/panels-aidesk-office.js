/*
 * Project /ai-desks execution facts into the agent workbench. Open standard task details
 * for conversations, evidence, approvals, and retries rather than duplicating task state.
 */

const _DK_OFFICE_MAX_DELIVERIES = 8;
let _dkOfficeDeliveriesOpen = false;

function _dkOfficePhase(t) {
  const phase = String((t || {}).phase || 'running');
  return _DK_PHASE[phase] ? phase : 'running';
}

function _dkOfficeFlowStep(t) {
  const flow = (t || {}).workflow || {};
  return String(flow.nodeName || ((t || {}).ms || {}).cur ||
    (_dkOfficePhase(t) === 'done' ? '交付完成' : 'AI 执行'));
}

function _dkOfficeIsQuality(t) {
  const flow = (t || {}).workflow || {};
  const kind = String(flow.nodeType || '').toLowerCase();
  const name = String(flow.nodeName || '').toLowerCase();
  return /(quality|test|verify|security|build|review|测试|验证|质检|构建|扫描)/.test(kind + ' ' + name);
}

function _dkOfficeArtifactCount(t) {
  const value = (t || {}).artifacts;
  if (Array.isArray(value)) return value.length;
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _dkOfficeVisibleDesks(desks) {
  return (desks || []).filter(d => !d.historyOnly);
}

function _dkOfficeStatusText(d) {
  if (d.online === false) return '离线';
  if (d.busy) return '正在工作' + (d.attention ? ' · ' + d.attention + ' 条待处理' : '');
  if (d.attention) return d.attention + ' 条待处理';
  return '在线待命';
}

function _dkOfficeIcon(name) {
  const paths = {
    people: '<path d="M8 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20a5 5 0 0 1 10 0M13 19a4 4 0 0 1 8 0"/>',
    shield: '<path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-5"/>',
    pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    file: '<path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    brief: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6M9 12h3m-3 4 2 2 4-4"/>',
    chat: '<path d="M7 4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-6l-5 3v-4a4 4 0 0 1-3-4V8a4 4 0 0 1 4-4Z"/><path d="M8 9h8M8 13h5"/>',
    route: '<rect x="3" y="9" width="6" height="6" rx="2"/><rect x="15" y="3" width="6" height="6" rx="2"/><rect x="15" y="15" width="6" height="6" rx="2"/><path d="M9 12h3m3-6h-1a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || paths.spark) + '</svg>';
}

function _dkOfficeAgentHtml(d) {
  const key = d.key || d.name;
  const label = d.alias || d.cli || d.name || 'AI 员工';
  const machine = d.machineLabel || d.host || '';
  const detail = (machine && String(label).indexOf(machine) < 0 ? machine + ' · ' : '') + _dkOfficeStatusText(d);
  const state = d.online === false ? 'off' : (d.busy ? 'live' : (d.attention ? 'wait' : 'idle'));
  return '<button type="button" class="aio-agent is-' + state + (_dkPick === key ? ' is-selected' : '') +
    '" data-ros="' + esc(key) + '" aria-pressed="' + (_dkPick === key ? 'true' : 'false') +
    '" title="' + esc(label + ' · ' + detail) + '" aria-label="查看 ' + esc(label) + '，' + esc(_dkOfficeStatusText(d)) + '">' +
      (typeof AgentBrand !== 'undefined' && AgentBrand ? AgentBrand.html(d, { className: 'aio-agent-avatar' }) : '') +
      '<span class="aio-agent-copy"><b>' + esc(label) + '</b><i>' +
        esc(detail) +
      '</i></span><span class="aio-agent-state" aria-hidden="true"></span>' +
    '</button>';
}

function _dkOfficeAllAgentHtml(desks, activeCount) {
  const available = (desks || []).filter(d => !d.historyOnly);
  const online = available.filter(d => d.online !== false).length;
  return '<button type="button" class="aio-agent aio-agent-all' + (_dkPick === '__all__' ? ' is-selected' : '') +
    '" data-ros="__all__" aria-pressed="' + (_dkPick === '__all__' ? 'true' : 'false') +
    '" aria-label="查看全部执行席位">' +
      '<span class="aio-agent-all-icon" aria-hidden="true">' + _dkOfficeIcon('pulse') + '</span>' +
      '<span class="aio-agent-copy"><b>全部席位</b><i>' + online + ' 个在线 · ' + activeCount + ' 项未结束</i></span>' +
      '<span class="aio-agent-state" aria-hidden="true"></span>' +
    '</button>';
}

function _dkOfficeScopedTasks(desks) {
  const all = _deskData.tasks || [];
  if (_dkPick === '__all__') return all;
  const d = (desks || []).find(x => (x.key || x.name) === _dkPick);
  return d ? _dkTasksFor(d) : all;
}

function _dkOfficeFilteredTasks(tasks) {
  const list = (Array.isArray(tasks) ? tasks : []).filter(t => _dkOfficePhase(t) !== 'done');
  if (_dkPhase === 'done') _dkPhase = 'all';
  if (_dkPhase === 'attention') return list.filter(t => ['waiting', 'failed'].includes(_dkOfficePhase(t)));
  if (_dkPhase === 'running') return list.filter(t => ['dispatching', 'running'].includes(_dkOfficePhase(t)));
  if (_dkPhase !== 'all') return list.filter(t => _dkOfficePhase(t) === _dkPhase);
  const order = { dispatching: 0, running: 1, waiting: 2, failed: 3 };
  return list.slice().sort((a, b) => (order[_dkOfficePhase(a)] - order[_dkOfficePhase(b)]));
}

function _dkOfficeNormalizeSelection(desks) {
  return _dkOfficeFilteredTasks(_dkOfficeScopedTasks(desks));
}

function _dkOfficeTaskHtml(t) {
  const phase = _dkOfficePhase(t);
  const meta = _DK_PHASE[phase] || _DK_PHASE.running;
  const flow = t.workflow || {};
  const agent = t.agent || '工作流自动化';
  let action = String(t.lastAction || _dkOfficeFlowStep(t));
  if (phase === 'waiting' && (flow.waitingOn || []).length) action = '等待 ' + flow.waitingOn.join('、') + ' 处理';
  if (phase === 'failed') action = String(flow.error || t.lastAction || '执行需要处理').slice(0, 150);
  const stateText = phase === 'running' && _dkOfficeIsQuality(t) ? '验证中' : meta.short;
  return '<article class="aio-work-item is-' + phase + '" ' +
    'data-office-enter-task="' + esc(t.id) + '" tabindex="0" role="button" ' +
    'aria-label="检查需求 ' + esc(t.title || '未命名需求') + '">' +
      '<header><div class="aio-work-owner">' +
        (typeof AgentBrand !== 'undefined' && AgentBrand ? AgentBrand.html(
          { cli: t.cli, key: t.deskKey, agent },
          { className: 'aio-work-bot' }) : '') +
        '<span class="aio-work-who"><b' + (t.agent ? ' data-user-content' : '') + ' title="' + esc(agent) + '">' + esc(agent) + '</b></span></div>' +
        '<span class="aio-work-state"><i></i>' + esc(stateText) + '</span></header>' +
      '<h3' + (t.title ? ' data-user-content' : '') + ' title="' + esc(t.title || '未命名需求') + '">' + esc(t.title || '未命名需求') + '</h3>' +
      '<footer class="aio-work-footer"><span class="aio-work-action" title="' + esc(action) + '">' + esc(action) + '</span>' +
        '<span class="aio-work-open">工作详情 ' + _dkOfficeIcon('chevron') + '</span></footer>' +
    '</article>';
}

function _dkOfficeDeliveryHtml(t) {
  const flow = t.workflow || {};
  const agent = t.agent || '工作流自动化';
  const artifacts = _dkOfficeArtifactCount(t);
  const source = flow.pluginName || '直接派活';
  return '<button type="button" class="aio-delivery-item" data-office-enter-task="' + esc(t.id) + '" ' +
    'title="查看 ' + esc(t.title || '未命名需求') + ' 的完整交付">' +
      '<span class="aio-delivery-check" aria-hidden="true">' + _dkOfficeIcon('check') + '</span><span class="aio-delivery-copy"><small>' + esc(source) + '</small>' +
      "<b" + (t.title ? ' data-user-content' : '') + '>' + esc(t.title || '未命名需求') + '</b><i>由 ' + esc(agent) + ' 验收' +
      (artifacts ? ' · ' + artifacts + ' 项成果' : '') + (t.at ? ' · ' + esc(_sinceTxt(t.at)) : '') + '</i></span>' +
      '<em aria-hidden="true">' + _dkOfficeIcon('chevron') + '</em></button>';
}

function _dkOfficeFlowEmpty(filtered, { hasWork = false, selected = false, online = 0 } = {}) {
  if (filtered) {
    return '<div class="aio-filter-empty">' + _dkOfficeIcon('clock') + '<b>这个状态下暂时没有需求</b>' +
      '<span>切回全部，继续查看团队当前的执行情况。</span>' +
      '<button type="button" data-office-phase="all">查看全部</button></div>';
  }
  const title = selected ? '这个席位暂时没有需求' : hasWork ? '没有进行中的需求' : '从第一项工作开始';
  const copy = selected ? '切换到全部席位查看其他需求，或从需求池中安排新的工作。' : hasWork
    ? '已完成的工作可在下方「最近交付」查看。也可以发起一项新工作。'
    : '在对话中描述想完成的事，或从需求池中选择需求派给 AI。进展与成果，在这里查看。';
  return '<section class="aio-flow-empty" aria-labelledby="aioEmptyTitle"><div class="aio-empty-content">' +
    '<div class="aio-empty-intro"><span class="aio-empty-mark" aria-hidden="true">' + _dkOfficeIcon('brief') + '</span>' +
      '<h3 id="aioEmptyTitle">' + title + '</h3><p>' + copy + '</p>' +
      '<div class="aio-empty-actions"><button type="button" class="aio-empty-primary" ' +
        (selected ? 'data-office-overview="1">查看全部席位' : 'data-office-new-chat="1">' + _dkOfficeIcon('chat') + '新对话') + '</button>' +
        '<button type="button" class="aio-empty-secondary" data-open-task-center="1">查看需求池' + _dkOfficeIcon('chevron') + '</button></div>' +
      (online ? '' : '<div class="aio-empty-connection"><span>还没有在线 Agent</span><button type="button" data-open-agents="1">连接 Agent' + _dkOfficeIcon('chevron') + '</button></div>') +
    '</div><ol class="aio-empty-guide" aria-label="从目标到交付">' +
      '<li><span class="aio-empty-step" aria-hidden="true">' + _dkOfficeIcon('chat') + '</span><div><b>描述目标</b><p>说清要做什么，带上相关材料。</p></div></li>' +
      '<li><span class="aio-empty-step" aria-hidden="true">' + _dkOfficeIcon('route') + '</span><div><b>安排执行</b><p>选择 Agent，跟进需求与会话。</p></div></li>' +
      '<li><span class="aio-empty-step" aria-hidden="true">' + _dkOfficeIcon('brief') + '</span><div><b>查看交付</b><p>打开成果、确认结果，留下反馈。</p></div></li>' +
    '</ol></div></section>';
}

function _dkOfficeSceneHtml(desks) {
  const all = _deskData.tasks || [];
  const available = (desks || []).filter(d => !d.historyOnly);
  if (_dkPick !== '__all__' && !available.some(d => (d.key || d.name) === _dkPick)) {
    _dkPick = '__all__';
  }
  const liveDesks = _dkOfficeVisibleDesks(desks);
  const scoped = _dkOfficeScopedTasks(desks);
  if (_dkPhase === 'done') _dkPhase = 'all';
  const visible = _dkOfficeNormalizeSelection(desks);
  const running = scoped.filter(t => ['dispatching', 'running'].includes(_dkOfficePhase(t)));
  const waiting = scoped.filter(t => _dkOfficePhase(t) === 'waiting');
  const failed = scoped.filter(t => _dkOfficePhase(t) === 'failed');
  const done = scoped.filter(t => _dkOfficePhase(t) === 'done');
  const attention = failed.length + waiting.length;
  const abnormalCount = all.filter(t => _dkOfficePhase(t) === 'failed').length;
  const online = available.filter(d => d.online !== false).length;
  const selectedDesk = _dkPick === '__all__' ? null : available.find(d => (d.key || d.name) === _dkPick);
  const context = selectedDesk ? (selectedDesk.alias || selectedDesk.cli || selectedDesk.name) : '全部执行席位';
  const activeCount = running.length + waiting.length + failed.length;
  const totalActiveCount = all.filter(t => _dkOfficePhase(t) !== 'done').length;
  return '<div class="aio-office' + (all.length ? '' : ' is-idle') + '" aria-label="AI 团队 Agent 执行工作台">' +
    '<section class="aio-teamline" aria-label="Agent 席位"><div class="aio-agent-line">' +
      _dkOfficeAllAgentHtml(available, totalActiveCount) +
      (liveDesks.length ? liveDesks.map(_dkOfficeAgentHtml).join('') :
        '<div class="aio-agent-empty"><b>等待 Agent 加入</b><span>' + esc(_deskData.reason || '还没有检测到可用 Agent 或在线 Runner') + '</span></div>') +
      '</div></section>' +
    '<section class="aio-workboard" aria-labelledby="aioWorkTitle"><header class="aio-workboard-head"><div>' +
      '<span data-i18n="eyebrow.live_task_queue">LIVE ISSUE QUEUE</span><h2 id="aioWorkTitle">Agent 操作台</h2><p>' + esc(context) + ' · 点击需求打开 AI 工作详情</p></div>' +
      '<div class="aio-office-filters" role="group" aria-label="按需求状态筛选">' +
        '<button type="button" data-office-phase="all" aria-pressed="' + (_dkPhase === 'all') +
          '" class="' + (_dkPhase === 'all' ? 'is-on' : '') + '">全部 <em>' + activeCount + '</em></button>' +
        '<button type="button" data-office-phase="running" aria-pressed="' + (_dkPhase === 'running') +
          '" class="' + (_dkPhase === 'running' ? 'is-on' : '') + '">进行中 <em>' + running.length + '</em></button>' +
        '<button type="button" data-office-phase="attention" aria-pressed="' + (_dkPhase === 'attention') +
           '" class="' + (_dkPhase === 'attention' ? 'is-on' : '') + '">需处理 <em>' + attention + '</em></button>' +
        (abnormalCount ? '<button type="button" class="aio-office-clean" data-office-clean-abnormal="' + abnormalCount + '" title="清理全部失败需求，保留需求记录和执行证据">清理异常 <em>' + abnormalCount + '</em></button>' : '') +
      '</div></header>' +
      '<div class="aio-work-list' + (visible.length ? '' : ' is-empty') + '">' + (visible.length
        ? visible.map(_dkOfficeTaskHtml).join('')
        : _dkOfficeFlowEmpty(_dkPhase !== 'all', { hasWork: all.length > 0, selected: !!selectedDesk, online })) + '</div>' +
    '</section>' +
    '<section class="aio-deliveries" aria-labelledby="aioDeliveryTitle"><header>' +
      '<button type="button" class="aio-delivery-toggle" id="aioDeliveryToggle" data-office-deliveries-toggle aria-expanded="' + _dkOfficeDeliveriesOpen + '" aria-controls="aioDeliveryContent">' +
        _dkOfficeIcon('chevron') + '<b id="aioDeliveryTitle">最近交付</b><em>' + done.length + '</em></button>' +
      (done.length ? '<button type="button" data-open-history="1">全部 ' + done.length + ' 条</button>' : '') + '</header>' +
      '<div id="aioDeliveryContent"' + (_dkOfficeDeliveriesOpen ? '' : ' hidden') + '>' +
      (done.length ? '<div class="aio-delivery-row">' + done.slice(0, _DK_OFFICE_MAX_DELIVERIES).map(_dkOfficeDeliveryHtml).join('') + '</div>' :
        '<div class="aio-delivery-empty">完成的需求会沉淀在这里，不占用实时操作台。</div>') +
    '</div></section></div>';
}

async function _dkOfficeCleanupAbnormal(button) {
  if (!button || button.disabled || !window.SoduWorkAPI || !SoduWorkAPI.aiDeskCleanupAbnormal) return;
  const count = Number(button.getAttribute('data-office-clean-abnormal') || 0);
  const label = '\u6e05\u7406\u5f02\u5e38';
  button.disabled = true;
  button.classList.add('is-loading');
  button.textContent = '\u6e05\u7406\u4e2d\u2026';
  try {
    const result = await SoduWorkAPI.aiDeskCleanupAbnormal();
    const cleaned = Array.isArray(result && result.cleaned) ? result.cleaned : [];
    if (cleaned.includes(_deskTaskId)) {
      _deskTaskId = '';
      _deskFocusTid = '';
      _dkView = 'board';
    }
    if (typeof petSay === 'function') {
      petSay(cleaned.length
        ? '\u5df2\u6e05\u7406 ' + cleaned.length + ' \u6761\u5f02\u5e38\u9700\u6c42\uff0c\u9700\u6c42\u8bb0\u5f55\u548c\u6267\u884c\u8bc1\u636e\u5df2\u4fdd\u7559'
        : '\u5f02\u5e38\u9700\u6c42\u5df2\u88ab\u5176\u4ed6\u7a97\u53e3\u5904\u7406');
    }
    await _loadDesks('');
  } catch (e) {
    if (typeof petSay === 'function') {
      petSay(typeof _humanErr === 'function' ? _humanErr(e, '\u6e05\u7406\u5f02\u5e38\u9700\u6c42\u5931\u8d25') : '\u6e05\u7406\u5f02\u5e38\u9700\u6c42\u5931\u8d25');
    }
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.innerHTML = label + ' <em>' + count + '</em>';
    }
  }
}

function _dkOfficeBindScene(root) {
  if (!root || root._officeEventsBound) return;
  root._officeEventsBound = true;
  root.addEventListener('keydown', e => {
    const card = e.target.closest('.aio-work-item[data-office-enter-task]');
    if (!card || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    card.click();
  });
  // Delegate once: retained cards must never accumulate click listeners on refresh.
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-ros],[data-office-phase],[data-office-enter-task],'+
      '[data-office-overview],[data-office-new-chat],[data-open-task-center],[data-open-history],[data-open-agents],[data-office-clean-abnormal],[data-office-deliveries-toggle]');
    if (!b || !root.contains(b)) return;
    if (b.hasAttribute('data-office-deliveries-toggle')) {
      _dkOfficeDeliveriesOpen = !_dkOfficeDeliveriesOpen;
      _renderDesks();
    } else if (b.hasAttribute('data-office-clean-abnormal')) {
      _dkOfficeCleanupAbnormal(b);
    } else if (b.hasAttribute('data-office-enter-task')) {
      openTaskConversation(b.getAttribute('data-office-enter-task'), '', {source:'ai-workbench',navigation:true});
    } else if (b.hasAttribute('data-ros')) {
      const next = b.getAttribute('data-ros') || '__all__';
      _dkPick = next === _dkPick && next !== '__all__' ? '__all__' : next;
      _dkView = 'board'; _deskTaskId = ''; _deskFocusTid = '';
      _renderDesks();
    } else if (b.hasAttribute('data-office-phase')) {
      _dkPhase = b.getAttribute('data-office-phase') || 'all'; _renderDesks();
    } else if (b.hasAttribute('data-office-overview')) {
      _dkPick = '__all__'; _dkPhase = 'all'; _dkView = 'board'; _renderDesks();
    } else if (b.hasAttribute('data-office-new-chat')) {
      if (typeof openCreateEntry === 'function') openCreateEntry({newSession:true});
      else if (window.WorkspaceHost) WorkspaceHost.open('create', {newSession:true});
    } else if (b.hasAttribute('data-open-agents')) {
      if (typeof openAgentsEntry === 'function') openAgentsEntry();
      else if (window.WorkspaceHost) WorkspaceHost.open('agents', {});
    } else {
      if (typeof openHistoryEntry === 'function') openHistoryEntry();
      else if (window.WorkspaceHost) WorkspaceHost.open('history', {});
    }
  });
}

/* Patch the generated scene by task/seat identity. A token counter or heartbeat
   is not a visual change; a new action only updates its text, leaving decoded
   images, hover, focus, selection and scroll containers alive. */
function _dkOfficePatchScene(root, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  function key(node) {
    if (node.nodeType !== 1) return '';
    for (const attr of ['id','data-ros','data-office-enter-task','data-office-phase']) {
      if (node.hasAttribute(attr)) return node.tagName + ':' + attr + ':' + node.getAttribute(attr);
    }
    return '';
  }
  function sync(current, wanted) {
    if (current.isEqualNode(wanted)) return;
    if (current.nodeType !== 1) { current.nodeValue = wanted.nodeValue; return; }
    for (const attr of Array.from(current.attributes)) {
      if (!wanted.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of Array.from(wanted.attributes)) {
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
    children(current, wanted);
  }
  function children(current, wanted) {
    const old = Array.from(current.childNodes);
    const keyed = new Map(old.filter(node => key(node)).map(node => [key(node),node]));
    const retained = new Set();
    Array.from(wanted.childNodes).forEach((next, index) => {
      const id = key(next);
      let node = id ? keyed.get(id) : old[index];
      if (!node || retained.has(node) || key(node) !== id || node.nodeType !== next.nodeType || node.nodeName !== next.nodeName) node = next;
      else sync(node, next);
      retained.add(node);
      const at = current.childNodes[index] || null;
      if (node !== at) {
        if (node.parentNode === current && typeof current.moveBefore === 'function') current.moveBefore(node, at);
        else current.insertBefore(node, at);
      }
    });
    old.forEach(node => { if (!retained.has(node)) node.remove(); });
  }
  const active = document.activeElement;
  children(root, template.content);
  if (active && root.contains(active) && document.activeElement !== active) active.focus({preventScroll:true});
  _dkOfficeBindScene(root);
}
