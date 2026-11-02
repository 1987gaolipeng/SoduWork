/*
 * Runner management identifies where tasks run and whether hosts accept work. Keep runtime
 * capability distinct from the machine hosting it.
 */
let _rnConfirm = '';
const _rnWorking = Object.create(null);
const _rnProbe = Object.create(null);
const _rnComponentJobs = Object.create(null);
let _rnCapabilityOpen = '';
let _rnCardOpen = '';
let _rnScopeVersion = 0;
/*
 * Rename input by machine: undefined means inactive, while an empty string intentionally
 * restores automatic naming.
 */
const _rnNaming = Object.create(null);
let _rnRefresh = null;

const _RN_ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/>' +
  '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/></svg>';
const _RN_PEN = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/></svg>';
const _RN_FLOW = '<svg viewBox="0 0 24 24"><path d="M5 6h9a4 4 0 0 1 4 4v8"/>' +
  '<path d="M14 14l4 4 4-4"/><circle cx="5" cy="6" r="2"/></svg>';
const _RN_TERM = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/>' +
  '<path d="M7 9l3 3-3 3M12 15h5"/></svg>';

const _RN_CAP_KEYS = ['files', 'terminal', 'repository', 'browser', 'computer'];
const _RN_CAP_LABELS = {
  files: '文件处理', terminal: '命令与构建', repository: '代码仓库',
  browser: '浏览与检索', computer: '操作电脑',
};

function _rnCapabilities(report) {
  report = report && typeof report === 'object' ? report : {};
  const raw = Array.isArray(report.items) ? report.items : [];
  const available = new Set(Array.isArray(report.available) ? report.available.map(String) : []);
  const indexed = Object.create(null);
  raw.forEach((item) => {
    if (!item || !item.key) return;
    indexed[String(item.key)] = item;
    if (item.available) available.add(String(item.key));
  });
  const extras = Object.keys(indexed).filter((key) => !_RN_CAP_KEYS.includes(key)).sort();
  const items = _RN_CAP_KEYS.concat(extras).map((key) => {
    const item = indexed[key] || {};
    return {
      key,
      label: item.label || _RN_CAP_LABELS[key] || key,
      available: available.has(key),
      installed: Object.prototype.hasOwnProperty.call(item, 'installed')
        ? Boolean(item.installed) : available.has(key),
      authorized: Object.prototype.hasOwnProperty.call(item, 'authorized')
        ? Boolean(item.authorized) : available.has(key),
      configurable: Object.prototype.hasOwnProperty.call(item, 'configurable')
        ? Boolean(item.configurable) : ['browser', 'computer'].includes(key),
      detail: String(item.detail || ''),
      installable: Boolean(item.installable),
      componentKind: String(item.componentKind || ''),
      componentVersion: String(item.componentVersion || ''),
      targetVersion: String(item.targetVersion || ''),
      componentReason: String(item.componentReason || ''),
    };
  });
  return { reported: Number(report.reportedAt || 0) > 0, items };
}

function _rnCapabilitiesHtml(report, runner, working) {
  const caps = _rnCapabilities(report);
  if (!caps.reported) {
    return '<div class="rn-capabilities is-pending"><div class="rn-cap-head"><b>能力护照</b>' +
      '<span>等待上报</span></div><p>升级或重启 Runner 1.7.0 后，系统会自动识别它能接什么任务。</p></div>';
  }
  const ready = caps.items.filter((item) => item.available);
  const id = String((runner && runner.runnerId) || '');
  const local = Boolean(runner && runner.embedded && runner.owned);
  const expanded = local && _rnCapabilityOpen === id;
  const managed = caps.items.filter((item) => ['browser', 'computer'].includes(item.key));
  const controls = expanded ? '<div class="rn-cap-settings"><div class="rn-cap-note">' +
    '授权只保存在这台电脑。企业开放范围、任务要求和操作护栏仍会继续生效。</div>' +
    managed.map((item) => {
      const jobKey = id + '::' + item.key;
      const job = _rnComponentJobs[jobKey] || null;
      const needsManagedVersion = item.installable && (!item.componentVersion ||
        (item.targetVersion && item.componentVersion !== item.targetVersion));
      const version = item.componentVersion ? ' · ' + item.componentVersion : '';
      const state = item.available ? '已就绪' + version : item.installed
        ? (item.authorized ? '暂不可用' : '等待本机授权') : (item.detail || '运行条件未就绪');
      const canToggle = item.configurable && item.installed;
      const canInstall = local && needsManagedVersion;
      const installLabel = item.installed ? (item.componentVersion ? '升级并测通' : '纳管版本') : '安装并测通';
      const action = canInstall
        ? '<button class="rn-cap-install" data-rn-cap-install="' + esc(id) +
          '" data-cap="' + esc(item.key) + '"' + (working ? ' disabled' : '') + '>' +
          (job && job.state === 'running' ? '安装中…' : installLabel) + '</button>'
        : canToggle
        ? '<button class="rn-cap-toggle' + (item.authorized ? ' is-on' : '') +
          '" data-rn-cap-set="' + esc(id) + '" data-cap="' + esc(item.key) +
          '" data-enable="' + (item.authorized ? '0' : '1') + '"' +
          (working ? ' disabled' : '') + '>' + (item.authorized ? '停用' : '授权') + '</button>'
        : '<span class="rn-cap-unavailable">不可用</span>';
      const logs = job && Array.isArray(job.lines) ? job.lines.slice(-8).join('\n') : '';
      const progress = job ? '<div class="rn-component-job ' +
        (job.state === 'done' ? (job.ok ? 'is-ok' : 'is-bad') : 'is-running') +
        '"><span>' + esc(job.detail || (job.state === 'running' ? '正在准备组件…' : '安装已结束')) +
        '</span>' + (logs ? '<details><summary>安装记录</summary><pre>' + esc(logs) +
        '</pre></details>' : '') + '</div>' : '';
      return '<div class="rn-cap-setting-wrap"><div class="rn-cap-setting"><i class="' +
        (item.available ? 'is-ready' :
        item.installed ? 'is-waiting' : '') + "\"></i><span><b>" + esc(item.label) +
        '</b><small>' + esc(state || item.componentReason) + '</small></span>' + action +
        '</div>' + progress + '</div>';
    }).join('') + '</div>' : '';
  return '<div class="rn-capabilities"><div class="rn-cap-head"><div><b>能力护照</b><span>已就绪 ' +
    ready.length + ' 项</span></div>' + (local
      ? '<button class="rn-cap-manage" data-rn-cap-open="' + esc(id) + '">' +
        (expanded ? '收起' : '管理本机能力') + '</button>' : '') +
    '</div><div class="rn-cap-list">' + caps.items.map((item) =>
      '<span class="rn-cap ' + (item.available ? 'is-ready' : 'is-missing') + '" title="' +
        esc(item.detail || (item.available ? '可以接收需要这项能力的任务' : '这台机器尚未接入这项能力')) +
        '"><i></i>' + esc(item.label) + '</span>').join('') + '</div>' + controls + '</div>';
}
function _rnAgo(sec) {
  const d = Date.now() / 1000 - Number(sec || 0);
  if (!sec) return '从未上线';
  if (d < 50) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  return Math.floor(d / 86400) + ' 天前';
}

function _rnBytes(n) {
  n = Number(n || 0);
  if (!n) return '';
  if (n >= 1073741824) return (n / 1073741824).toFixed(n >= 10737418240 ? 0 : 1) + ' GB';
  return Math.round(n / 1048576) + ' MB';
}

function _rnWaiting(r) {
  return Math.max(0, Number(r.queueDepth || 0),
    Number(r.queuedConversations || 0) + Number(r.queuedTasks || 0));
}

function _rnLimit(r) {
  return Math.max(1, Number(r.adaptiveLimit || r.maxConcurrent || 1));
}

function _rnPercent(value) {
  const n = Number(value || 0);
  return Math.max(0, Math.min(100, Math.round(n)));
}

function _rnState(r) {
  if (!r.online) return { key: 'offline', text: '离线' };
  if (r.mode === 'disabled') return { key: 'disabled', text: '已禁用' };
  if (r.mode === 'draining') return { key: 'draining', text: '暂停接单' };
  if (Number(r.busy || 0) > 0) return { key: 'busy', text: '执行中' };
  if (_rnWaiting(r) > 0) return { key: 'queued', text: '等待中' };
  return { key: 'ready', text: '可接任务' };
}

function _rnHealth(r) {
  if (!r.online) return { key: 'bad', title: '节点离线', detail: '现有记录仍保留，等待此执行环境恢复' };
  if (r.mode === 'disabled') return { key: 'bad', title: '调度已禁用', detail: '不会接收新任务' };
  if (r.mode === 'draining') return { key: 'warn', title: '正在排空', detail: '现有会话继续，暂不接收新任务' };
  if (!(r.agents || []).length) return { key: 'bad', title: '没有可用 Agent', detail: '先安装并测通至少一个 Agent' };
  if (!r.workRoot) return { key: 'warn', title: '工作目录未设置', detail: '依赖工程的任务无法准备工作区' };
  if (!_rnCapabilities(r.capabilities).reported) {
    return { key: 'warn', title: '能力等待确认', detail: '升级或重启 Runner 1.7.0 后自动上报' };
  }
  const pressure = String(r.resourcePressure || '');
  const waiting = _rnWaiting(r);
  const busy = Number(r.busy || 0);
  const limit = _rnLimit(r);
  if (pressure === 'critical') {
    return { key: 'warn', title: '资源压力较高',
      detail: '已暂停拉起新进程，' + waiting + ' 项工作安全排队' };
  }
  if (pressure === 'busy') {
    return { key: 'warn', title: '资源繁忙',
      detail: '自适应并发已降至 ' + limit + '，资源恢复后自动提速' };
  }
  if (busy > 0) return { key: 'run', title: '运行正常',
    detail: '正在运行 ' + busy + ' / ' + limit + (waiting ? '，另有 ' + waiting + ' 项等待' : '') };
  if (waiting > 0) return { key: 'run', title: '正在调度',
    detail: waiting + ' 项工作等待资源，释放后自动执行' };
  return { key: 'ok', title: '节点健康', detail: '心跳、工作目录与 Agent 能力均已就绪' };
}

function _rnSessionHtml(s) {
  const tid = String(s.taskId || '');
  return '<div class="rn-session">' +
    '<button class="rn-session-main" data-rn-task="' + esc(tid) + '"' + (tid ? '' : ' disabled') + '>' +
      "<i></i><span><b" + (s.title ? ' data-user-content' : '') + '>' + esc(s.title || '未命名任务') + '</b><small>' +
        esc(s.engine || s.status || '运行中') + '</small></span></button>' +
    '<button class="rn-session-term" data-rn-console="' + esc(tid) + '"' + (tid ? '' : ' disabled') +
      ' title="打开这条任务的真实会话">' + _RN_TERM + '<span>控制台</span></button></div>';
}

async function _rnCopy(text, btn) {
  if (!text) return;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { ok = document.execCommand('copy'); } catch (x) { ok = false; }
    t.remove();
  }
  const em = btn && btn.querySelector('em');
  if (em) { em.textContent = ok ? '已复制' : '复制失败'; setTimeout(() => { em.textContent = '复制'; }, 1200); }
}

async function _rnSetMode(id, mode) {
  const scope = _rnScopeVersion;
  _rnConfirm = '';
  _rnWorking[id] = 'mode';
  if (typeof _agRender === 'function') _agRender();
  try {
    await SoduWorkAPI.runnerMode(id, mode);
    if (scope !== _rnScopeVersion) return;
    if (_rnRefresh) await _rnRefresh(true);
  } catch (e) {
    if (scope !== _rnScopeVersion) return;
    _rnProbe[id] = { ok: false, detail: typeof _humanErr === 'function' ? _humanErr(e, '状态更新失败') : '状态更新失败' };
  } finally {
    if (scope === _rnScopeVersion) {
      delete _rnWorking[id];
      if (typeof _agRender === 'function') _agRender();
    }
  }
}

async function _rnDoProbe(id) {
  const scope = _rnScopeVersion;
  _rnWorking[id] = 'probe';
  if (typeof _agRender === 'function') _agRender();
  try {
    const r = await SoduWorkAPI.runnerProbe(id);
    if (scope !== _rnScopeVersion) return;
    const d = (r && r.data) || {};
    _rnProbe[id] = r && r.ok
      ? { ok: true, detail: (r.latencyMs || 0) + ' ms · 剩余 ' + (_rnBytes(d.freeBytes) || '未知') +
          ' · ' + ((d.agents || []).length) + ' 个底座', capabilities: d.capabilities || null }
      : { ok: false, detail: (r && r.error) || '执行节点没有回应' };
  } catch (e) {
    if (scope !== _rnScopeVersion) return;
    _rnProbe[id] = { ok: false, detail: typeof _humanErr === 'function' ? _humanErr(e, '执行节点没有回应') : '执行节点没有回应' };
  } finally {
    if (scope === _rnScopeVersion) {
      delete _rnWorking[id];
      if (typeof _agRender === 'function') _agRender();
    }
  }
}

async function _rnSetCapability(id, key, enabled, nodes) {
  const scope = _rnScopeVersion;
  const node = (nodes || []).find((item) => String(item.runnerId) === String(id)) || {};
  if (!node.owned || !node.embedded) {
    _rnProbe[id] = { ok: false, detail: '只能在这台电脑上修改它自己的能力授权' };
    if (typeof _agRender === 'function') _agRender();
    return;
  }
  _rnWorking[id] = 'capability';
  if (typeof _agRender === 'function') _agRender();
  try {
    if (!window.soduWorkAPI || !window.soduWorkAPI.setRunnerCapability) {
      throw new Error('客户端版本尚不支持本机能力授权');
    }
    const saved = await window.soduWorkAPI.setRunnerCapability(key, enabled);
    if (scope !== _rnScopeVersion) return;
    if (saved && saved.canceled) return;
    if (!saved || !saved.ok) throw new Error((saved && saved.error) || '本机授权没有保存');
    _rnProbe[id] = { ok: true, detail: '本机授权已更新，Runner 正在重新连接…' };
    if (typeof _agRender === 'function') _agRender();
    let probe = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 650 + attempt * 250));
      if (scope !== _rnScopeVersion) return;
      try { probe = await SoduWorkAPI.runnerProbe(id); } catch (e) { probe = null; }
      if (scope !== _rnScopeVersion) return;
      if (probe && probe.ok) break;
    }
    if (probe && probe.ok) {
      const data = probe.data || {};
      _rnProbe[id] = {
        ok: true,
        detail: (probe.latencyMs || 0) + ' ms · 授权已生效',
        capabilities: data.capabilities || null,
      };
    } else {
      _rnProbe[id] = { ok: false, detail: '授权已保存，Runner 仍在重连；稍后点“测一下”确认' };
    }
    if (_rnRefresh) await _rnRefresh(true);
  } catch (e) {
    if (scope !== _rnScopeVersion) return;
    _rnProbe[id] = {
      ok: false,
      detail: typeof _humanErr === 'function' ? _humanErr(e, '本机授权没有保存') : '本机授权没有保存',
    };
  } finally {
    if (scope === _rnScopeVersion) {
      delete _rnWorking[id];
      if (typeof _agRender === 'function') _agRender();
    }
  }
}

async function _rnInstallComponent(id, key, nodes) {
  const scope = _rnScopeVersion;
  const node = (nodes || []).find((item) => String(item.runnerId) === String(id)) || {};
  const stateKey = id + '::' + key;
  if (!node.owned || !node.embedded) {
    _rnProbe[id] = { ok: false, detail: '本机组件只能由这台电脑的使用者安装' };
    if (typeof _agRender === 'function') _agRender();
    return;
  }
  try {
    if (!window.soduWorkAPI || !window.soduWorkAPI.confirmRunnerComponentInstall) {
      throw new Error('客户端版本尚不支持组件安装');
    }
    const approved = await window.soduWorkAPI.confirmRunnerComponentInstall(key);
    if (scope !== _rnScopeVersion) return;
    if (!approved || approved.canceled) return;
    if (!approved.ok) throw new Error(approved.error || '没有获得本机安装授权');
    _rnWorking[id] = 'component';
    _rnComponentJobs[stateKey] = {
      state: 'running', ok: null, detail: '正在连接本机 Runner…', lines: [],
    };
    if (typeof _agRender === 'function') _agRender();
    const started = await SoduWorkAPI.runnerComponentInstall(id, key);
    if (scope !== _rnScopeVersion) return;
    const jobId = String(started && started.data && started.data.jobId || '');
    if (!jobId) throw new Error('Runner 没有返回安装作业');
    const deadline = Date.now() + 16 * 60 * 1000;
    let result = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (scope !== _rnScopeVersion) return;
      const reply = await SoduWorkAPI.runnerComponentJob(id, jobId);
      if (scope !== _rnScopeVersion) return;
      result = reply && reply.data || null;
      if (!result) throw new Error('读不到安装进度');
      _rnComponentJobs[stateKey] = result;
      if (typeof _agRender === 'function') _agRender();
      if (result.state === 'done') break;
    }
    if (!result || result.state !== 'done') throw new Error('安装等待超时，Runner 会继续安全收尾');
    if (!result.ok) throw new Error(result.detail || '组件没有安装成功');
    _rnProbe[id] = {
      ok: true, detail: result.detail || '组件已安装并测通',
      capabilities: result.capabilities || null,
    };
    if (_rnRefresh) await _rnRefresh(true);
  } catch (e) {
    if (scope !== _rnScopeVersion) return;
    const message = typeof _humanErr === 'function'
      ? _humanErr(e, '组件安装失败') : '组件安装失败';
    const current = _rnComponentJobs[stateKey] || {};
    _rnComponentJobs[stateKey] = {
      ...current, state: 'done', ok: false, detail: message,
    };
    _rnProbe[id] = { ok: false, detail: message };
  } finally {
    if (scope === _rnScopeVersion) {
      delete _rnWorking[id];
      if (typeof _agRender === 'function') _agRender();
    }
  }
}




async function _rnSaveName(id, nodes) {
  const scope = _rnScopeVersion;
  const node = (nodes || []).find(x => String(x.runnerId) === String(id)) || {};
  const key = node.machineKey || '';
  const name = String(_rnNaming[id] || '').trim();
  if (!key) { _rnProbe[id] = { ok: false, detail: '这台机器还没上报身份，刷新后再试' }; return; }
  _rnWorking[id] = 'rename';
  if (typeof _agRender === 'function') _agRender();
  try {
    await SoduWorkAPI.setExecutionName('machine', key, name);
    if (scope !== _rnScopeVersion) return;
    delete _rnNaming[id];
    if (_rnRefresh) await _rnRefresh(true);
  } catch (e) {
    if (scope !== _rnScopeVersion) return;
    _rnProbe[id] = { ok: false, detail: typeof _humanErr === 'function' ? _humanErr(e, '名字没存上') : '名字没存上' };
  } finally {
    if (scope === _rnScopeVersion) {
      delete _rnWorking[id];
      if (typeof _agRender === 'function') _agRender();
    }
  }
}

function _rnBind(box, refresh, nodes) {
  _rnRefresh = refresh;
  box.querySelectorAll('[data-rn-cap-open]').forEach((el) => el.addEventListener('click', () => {
    const id = el.getAttribute('data-rn-cap-open') || '';
    _rnCapabilityOpen = _rnCapabilityOpen === id ? '' : id;
    if (typeof _agRender === 'function') _agRender();
  }));
  box.querySelectorAll('[data-rn-cap-set]').forEach((el) => el.addEventListener('click', () =>
    _rnSetCapability(
      el.getAttribute('data-rn-cap-set') || '',
      el.getAttribute('data-cap') || '',
      el.getAttribute('data-enable') === '1',
      nodes)));
  box.querySelectorAll('[data-rn-cap-install]').forEach((el) => el.addEventListener('click', () =>
    _rnInstallComponent(
      el.getAttribute('data-rn-cap-install') || '',
      el.getAttribute('data-cap') || '',
      nodes)));
  box.querySelectorAll('[data-rn-task]').forEach((el) => el.addEventListener('click', () => {
    const tid = el.getAttribute('data-rn-task') || '';
    if (tid && typeof openDetailEntry === 'function') openDetailEntry(tid);
  }));
  box.querySelectorAll('[data-rn-console]').forEach((el) => el.addEventListener('click', () => {
    const tid = el.getAttribute('data-rn-console') || '';
    const open = (typeof openConsoleEntry === 'function') ? openConsoleEntry :
      ((typeof openConsole === 'function') ? openConsole : null);
    if (tid && open) open(tid);
  }));
  box.querySelectorAll('[data-rn-copy]').forEach(el => el.addEventListener('click', () =>
    _rnCopy(el.getAttribute('data-rn-copy') || '', el)));
  box.querySelectorAll('[data-rn-ren]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-rn-ren') || '';
    const node = (nodes || []).find(x => String(x.runnerId) === String(id)) || {};
    _rnNaming[id] = node.alias || '';
    if (typeof _agRender === 'function') _agRender();
    const inp = document.getElementById('rnRenameInput');
    if (inp) { inp.focus(); inp.select(); }
  }));
  box.querySelectorAll('[data-rn-ren-cancel]').forEach(el => el.addEventListener('click', () => {
    Object.keys(_rnNaming).forEach(k => delete _rnNaming[k]);
    if (typeof _agRender === 'function') _agRender();
  }));
  box.querySelectorAll('[data-rn-ren-save]').forEach(el => el.addEventListener('click', () =>
    _rnSaveName(el.getAttribute('data-rn-ren-save') || '', nodes)));
  const inp = box.querySelector('#rnRenameInput');
  if (inp) {
    /*
     * Persist in-progress rename text in state before polling rebuilds the input DOM.
     */
    const id = Object.keys(_rnNaming)[0] || '';
    inp.addEventListener('input', () => { _rnNaming[id] = inp.value; });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { _rnNaming[id] = inp.value; _rnSaveName(id, nodes); }
      else if (e.key === 'Escape') {
        Object.keys(_rnNaming).forEach(k => delete _rnNaming[k]);
        if (typeof _agRender === 'function') _agRender();
      }
    });
  }
  box.querySelectorAll('[data-rn-probe]').forEach(el => el.addEventListener('click', () =>
    _rnDoProbe(el.getAttribute('data-rn-probe') || '')));
  box.querySelectorAll('[data-rn-mode]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-rn-mode') || '', mode = el.getAttribute('data-mode') || '';
    if (mode === 'draining') { _rnConfirm = id; if (typeof _agRender === 'function') _agRender(); }
    else _rnSetMode(id, mode);
  }));
  box.querySelectorAll('[data-rn-cancel]').forEach(el => el.addEventListener('click', () => {
    _rnConfirm = ''; if (typeof _agRender === 'function') _agRender();
  }));
  box.querySelectorAll('[data-rn-do]').forEach(el => el.addEventListener('click', () =>
    _rnSetMode(el.getAttribute('data-rn-do') || '', el.getAttribute('data-mode') || '')));
}

function _rnCompactAgents(agents) {
  agents = Array.isArray(agents) ? agents : [];
  if (!agents.length) return '<span class="rn-agent-empty">未发现 Agent</span>';
  const visible = agents.slice(0, 5);
  return visible.map((a) => '<span>' + esc(a.name || a.key) +
    (a.version ? ' <i>' + esc(a.version) + '</i>' : '') + '</span>').join('') +
    (agents.length > visible.length ? '<em>+' + (agents.length - visible.length) + '</em>' : '');
}

function _rnCompactCard(r, preferred) {
  const id = String(r.runnerId || '');
  const state = _rnState(r);
  const agents = Array.isArray(r.agents) ? r.agents : [];
  const sessions = Array.isArray(r.sessions) ? r.sessions : [];
  const probe = _rnProbe[id];
  const capabilityReport = (probe && probe.capabilities) || r.capabilities;
  const health = _rnHealth(Object.assign({}, r, { capabilities: capabilityReport }));
  const working = _rnWorking[id] || '';
  const confirm = _rnConfirm === id;
  const naming = _rnNaming[id];
  const expanded = _rnCardOpen === id || naming !== undefined || confirm ||
    _rnCapabilityOpen === id;
  const modeAction = r.mode === 'draining' ? 'accepting' : 'draining';
  const modeText = r.mode === 'draining' ? '恢复接单' : '停止接新任务';
  const environmentLabel = r.scope === 'current-instance' || r.isCurrentDevice === true ? '当前客户端'
    : r.scope === 'personal-cloud' ? '个人云端' : r.scope === 'bound-runner' ? '关联执行机' : '远程执行环境';
  const environment = window.SoduWorkI18n?.translateText?.(environmentLabel) || environmentLabel;
  const sub = [
    r.shared ? '企业公共' : [environment, r.owner || ''].filter(Boolean).join(' · '),
    r.host && String(r.label || '').indexOf(r.host) < 0 ? r.host : '',
    'Runner ' + (r.version || '未知版本'),
    r.online ? ('在线' + (r.lastSeen ? ' · ' + _rnAgo(r.lastSeen) : '')) :
      ('最后在线 ' + _rnAgo(r.lastSeen)),
  ].filter(Boolean);
  const rename = naming === undefined ? '' :
    '<div class="rn-rename"><label>这台机器叫什么</label>' +
      '<input id="rnRenameInput" maxlength="40" spellcheck="false" value="' + esc(naming) +
        '" placeholder="' + esc(r.host || id) + '">' +
      '<div class="rn-rename-tip">这个名字会同步用于机器及其 Agent。留空则恢复自动名称。</div>' +
      '<div class="rn-rename-acts"><button class="btn-mini primary" data-rn-ren-save="' +
        esc(id) + '">保存</button><button class="btn-mini" data-rn-ren-cancel="1">取消</button></div></div>';
  const details = !expanded ? '' :
    '<div class="rn-card-more">' +
      rename +
      ((r.tags || []).length ? '<div class="rn-tags">' +
        r.tags.map((t) => '<span>' + esc(t) + '</span>').join('') + '</div>' : '') +
      _rnCapabilitiesHtml(capabilityReport, r, working) +
      (sessions.length ? '<div class="rn-sessions"><div class="rn-subtitle">正在承载</div>' +
        sessions.map(_rnSessionHtml).join('') + '</div>' : '') +
      '<button class="rn-root" data-rn-copy="' + esc(r.workRoot || '') + '"' +
        (r.workRoot ? '' : ' disabled') + ' title="复制完整工作目录"><span>工作目录</span><code>' +
        esc(r.workRoot || '尚未设置') + '</code><em>复制</em></button>' +
      (probe ? '<div class="rn-probe ' + (probe.ok ? 'is-ok' : 'is-bad') + '"><b>' +
        (probe.ok ? '节点可用' : '节点未通过') + '</b><span>' + esc(probe.detail || '') +
        '</span></div>' : '') +
    '</div>';
  return '<article id="rn-card-' + esc(id) + '" class="rn-card rn-card-compact st-' + state.key +
      (preferred ? ' is-preferred' : '') + (expanded ? ' is-expanded' : '') + '">' +
    '<div class="rn-card-head"><span class="rn-icon">' + _RN_ICON + '</span>' +
      '<div class="rn-name"><strong>' + esc(r.label || r.host || '未命名执行节点') + '</strong>' +
        '<small>' + esc(sub.join(' · ')) + '</small></div>' +
      (r.manageable ? '<button class="rn-ren" data-rn-ren="' + esc(id) +
        '" title="给这台执行机起个名字">' + _RN_PEN + '</button>' : '') +
      (preferred ? '<span class="rn-preferred">首选</span>' : '') +
      '<span class="rn-state">' + esc(state.text) + '</span></div>' +
    '<div class="rn-card-scan"><span class="rn-health-inline is-' + health.key +
      "\"><i></i><span><b>" + esc(health.title) + '</b><small>' + esc(health.detail) +
      '</small></span></span><span class="rn-mini-fact"><b>' + Number(r.busy || 0) +
      '/' + _rnLimit(r) + '</b>运行</span><span class="rn-mini-fact"><b>' + _rnWaiting(r) +
      '</b>等待</span><span class="rn-mini-fact"><b>' + _rnPercent(r.cpuPercent) +
      '%</b>CPU</span><span class="rn-mini-fact"><b>' + _rnPercent(r.memoryPercent) +
      '%</b>内存</span></div>' +
    '<div class="rn-chips rn-chips-compact">' + _rnCompactAgents(agents) + '</div>' +
    details +
    '<div class="rn-actions"><button class="btn-mini rn-detail-toggle" data-rn-card-toggle="' +
      esc(id) + '">' + (expanded ? '收起' : '查看详情') + '</button>' +
      '<button class="btn-mini" data-rn-probe="' + esc(id) + '"' +
        (!r.online || working ? ' disabled' : '') + '>' +
        (working === 'probe' ? '检测中…' : '测一下') + '</button>' +
      (r.manageable && r.mode !== 'disabled' ? '<button class="btn-mini' +
        (r.mode === 'draining' ? ' primary' : '') + '" data-rn-mode="' + esc(id) +
        '" data-mode="' + modeAction + '"' + (!r.online || working ? ' disabled' : '') + '>' +
        esc(working === 'mode' ? '正在更新…' : modeText) + '</button>' : '') +
      '<span class="rn-os" title="' + esc(r.os || '') + '">' + esc(r.os || '系统未知') +
      '</span></div>' +
    (confirm ? '<div class="rn-confirm"><div><b>暂停接收新任务？</b><span>现有 ' +
      sessions.length + ' 个会话不会中断；使用其他环境执行新任务时，请明确选择云端或指定执行机。</span></div><div>' +
      '<button class="btn-mini" data-rn-cancel="1">取消</button>' +
      '<button class="btn-mini primary" data-rn-do="' + esc(id) +
        '" data-mode="draining">确认暂停</button></div></div>' : '') +
  '</article>';
}

function _rnMachineDirectoryHtml(nodes) {
  if (!nodes.length) return '<div class="rn-dir-empty">暂无执行机器</div>';
  return '<div class="rn-dir-machines">' + nodes.map((r) => {
    const state = _rnState(r);
    const agents = Array.isArray(r.agents) ? r.agents : [];
    return '<button class="rn-dir-machine" data-rn-card-jump="' + esc(r.runnerId || '') + '">' +
      '<i class="st-' + state.key + '"></i><span><b>' +
        esc(r.label || r.host || '未命名机器') + '</b><small>' +
        esc(state.text + ' · ' + Number(r.busy || 0) + '/' + _rnLimit(r) +
          ' 运行 · ' + _rnWaiting(r) + ' 等待 · ' + agents.length + ' Agent') +
      '</small></span><em>定位</em></button>' +
      '<div class="rn-dir-agents">' + _rnCompactAgents(agents) + '</div>';
  }).join('') + '</div>';
}

function _rnDirectoryHtml(nodes) {
  return '<aside class="rn-directory"><header><div><b>我的执行机</b>' +
    '<span>查看自己的机器与 Agent</span></div><em>' + nodes.length +
    ' 台</em></header><div class="rn-directory-scroll">' +
    _rnMachineDirectoryHtml(nodes) + '</div></aside>';
}

function _rnOwnedNodes(nodes) {
  return Array.isArray(nodes) ? nodes.filter(node => node && node.owned === true) : [];
}

function _rnWorkspaceRender(nodes) {
  nodes = _rnOwnedNodes(nodes);
  const localReason = (typeof _agData !== 'undefined' && _agData && _agData.localRunnerReason) || '';
  const canTake = (x) => x.online && x.mode !== 'draining' && x.mode !== 'disabled' &&
    x.accepting !== false;
  const online = nodes.filter((x) => x.online).length;
  const accepting = nodes.filter(canTake).length;
  const busy = nodes.reduce((n, x) => n + Number(x.busy || 0), 0);
  const waiting = nodes.reduce((n, x) => n + _rnWaiting(x), 0);
  // Scope comes from the authenticated Hub identity. A matching hostname or
  // embedded flag does not authorize another installation as this instance.
  const preferred = nodes.find((x) => canTake(x) && (x.scope === 'current-instance' || x.isCurrentDevice === true)) || null;
  const active = nodes.reduce((n, x) => n + (x.sessions || []).length, 0);
  const routeText = online + ' 个节点在线，' + accepting + ' 个可接单' +
    (active ? '，' + active + ' 条活跃会话' : '') +
    (waiting ? '，' + waiting + ' 项等待中。' : '。') +
    (preferred ? '当前优先使用「' + esc(preferred.label || preferred.host || '在线节点') + '」。' :
      accepting ? '当前客户端的执行机尚未就绪。使用其他环境时，请明确选择云端或指定执行机。' :
        '当前没有可接单节点，任务会保留等待。');
  const content = nodes.length ? '<div class="rn-grid rn-grid-compact">' +
    nodes.map((x) => _rnCompactCard(x, x === preferred)).join('') + '</div>' :
    '<div class="rn-none">' + _RN_ICON + '<div><b>还没有 Runner 上线</b>' +
      '<span>' + esc(localReason || '启动 Runner 后，这里会显示节点、Agent 与实时负载。') + '</span></div></div>';
  return '<section class="rn-section rn-control-section"><div class="rn-route ' +
    (preferred ? 'is-ready' : 'is-blocked') + '"><span class="rn-route-icon">' +
      _RN_FLOW + '</span><div><b>自动调度</b><span>' + routeText + '</span></div><em>' +
      (waiting ? waiting + ' 项等待' :
        (busy ? busy + ' 条运行中' : (preferred ? '随时可派' : '需要处理'))) + '</em></div>' +
    '<div class="rn-workspace"><main>' + content + '</main>' +
      _rnDirectoryHtml(nodes) + '</div></section>';
}

function _rnWorkspaceBind(box, refresh, nodes) {
  _rnBind(box, refresh, _rnOwnedNodes(nodes));
  box.querySelectorAll('[data-rn-card-toggle]').forEach((el) => el.addEventListener('click', () => {
    const id = el.getAttribute('data-rn-card-toggle') || '';
    _rnCardOpen = _rnCardOpen === id ? '' : id;
    if (typeof _agRender === 'function') _agRender();
  }));
  box.querySelectorAll('[data-rn-card-jump]').forEach((el) => el.addEventListener('click', () => {
    const id = el.getAttribute('data-rn-card-jump') || '';
    _rnCardOpen = id;
    if (typeof _agRender === 'function') _agRender();
    requestAnimationFrame(() => {
      const card = document.getElementById('rn-card-' + id);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }));
}

function _rnResetScope() {
  ++_rnScopeVersion;
  _rnConfirm = ''; _rnCapabilityOpen = ''; _rnCardOpen = ''; _rnRefresh = null;
  for (const cache of [_rnWorking, _rnProbe, _rnComponentJobs, _rnNaming]) {
    Object.keys(cache).forEach(key => delete cache[key]);
  }
}

window.RunnerManager = { render: _rnWorkspaceRender, bind: _rnWorkspaceBind, reset: _rnResetScope };
