/* Personal cloud execution environments. */
(function (global) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
  // Joined rows (label + data in one text node) and aria strings defeat the
  // per-node DOM adapter; translate the UI side of a concatenation here.
  const tr = value => {
    const text = value === undefined || value === null ? '' : String(value);
    return global.SoduWorkI18n ? global.SoduWorkI18n.translateText(text) : text;
  };
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 16H6a4 4 0 0 1-.4-8 6.4 6.4 0 0 1 12.2-1A4.5 4.5 0 0 1 18 16h-1M8 20h8M12 16v4"/></svg>';
  const refreshIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17"/></svg>';
  let panel = null, data = null, timer = null, generation = 0, loading = false, owner = '';
  const agentJobs = Object.create(null);
  const ownerScope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
  function scopeChanged() {
    const next = ownerScope();
    if (owner === next) return;
    owner = next; generation++; data = null; loading = false; clearTimeout(timer);
    Object.keys(agentJobs).forEach(key => delete agentJobs[key]);
    global.CloudEnvironmentSetup?.invalidate();
    if (panel?.classList.contains('show')) open();
  }
  function status(row) { return row.statusText || (row.online ? '已连接' : '等待连接'); }
  function harnessView(row, a, readOnly = false) {
    const job = agentJobs[row.id + ':' + a.id];
    const installing = job?.state === 'running' || job?.state === 'starting';
    const failed = job?.state === 'done' && job.ok === false;
    const installed = Boolean(readOnly || a.installed || (job?.state === 'done' && job.ok && ['install', 'update'].includes(job.action)));
    const available = row.online && row.eligible !== false && !row.deploymentRestricted;
    const ready = available && a.ready === true;
    const busyLabel = job?.action === 'check' ? '检查中…' : '安装中…';
    const state = installing ? busyLabel : failed ? '安装失败，请重试' : ready ? '已就绪' : !available ? '等待连接' : installed ? (a.reason ? '需要配置' : '已安装，等待云端确认') : '未安装';
    const action = installed ? (failed ? 'update' : 'check') : 'install';
    const detail = failed ? job.detail : a.reason || '';
    return '<div class="ce-harness" data-ce-harness="' + esc(a.id) + '" data-state="' + (failed ? 'error' : ready ? 'ready' : installing ? 'working' : 'pending') + '">' +
      '<div class="ce-harness-identity">' + (global.AgentBrand?.html(a.id || a.name, { className: 'ce-agent-brand' }) || '<span class="ce-agent-fallback" aria-hidden="true">' + icon + '</span>') + '<div class="ce-harness-name"><strong translate="no">' + esc(a.name || a.id) + '</strong><span translate="no">' + esc(a.version || '') + '</span></div></div>' +
      '<span class="ce-harness-status' + (ready ? ' is-ready' : '') + '">' + esc(state) + '</span>' +
      (ready || readOnly ? '<span class="ce-ready-action" aria-hidden="true"></span>' : '<button type="button" data-ce-install-agent="' + esc(row.id) + '" data-ce-agent-key="' + esc(a.id) + '" data-ce-agent-action="' + action + '"' + (installing || !available ? ' disabled' : '') + '>' + (installing ? busyLabel : failed ? '重试' : installed ? '检查' : '安装') + '</button>') +
      (detail ? '<details class="ce-harness-error" data-ce-disclosure="agent-' + esc(a.id) + '"><summary>' + esc(failed ? '查看安装记录' : '查看原因') + '</summary><pre>' + esc(tr(detail)) + '</pre></details>' : '') + '</div>';
  }
  function systemLabel(row) {
    const os = String(row.os || '').trim();
    const family = /^(linux|windows|darwin|macos)/i.exec(os)?.[1].toLowerCase();
    const names = { linux: 'Linux', windows: 'Windows', darwin: 'macOS', macos: 'macOS' };
    const arch = /(?:^|[^a-z0-9])(x86_64|aarch64|arm64|amd64|x64|i[3-6]86)(?:$|[^a-z0-9])/i.exec(String(row.arch || row.architecture || os))?.[1];
    return [family ? names[family] : os.split(/[\s-]/)[0], arch].filter(Boolean).join(' · ') || '—';
  }
  function rowView(row) {
    const agents = (row.agents || []).map(a => typeof a === 'string' ? { id: a, name: a, ready: row.online } : a);
    const availableAgents = (row.availableAgents || []).filter(a => a && a.installable !== false);
    const busy = Math.max(0, Number(row.busy) || 0), capacity = Math.max(1, Number(row.maxConcurrent) || 1);
    const localCredential = row.localCredential || {};
    const restricted = row.eligible === false || row.deploymentRestricted;
    const shownAgents = availableAgents.length ? availableAgents : agents;
    const readyCount = row.online && !restricted ? shownAgents.filter(a => a.ready === true).length : 0;
    return '<article class="ce-server' + (restricted ? ' is-restricted' : '') + '" data-ce-server="' + esc(row.id) + '">' +
      '<div class="ce-server-overview"><div class="ce-server-top"><div class="ce-server-icon" aria-hidden="true">' + icon + '</div><div class="ce-server-identity"><div class="ce-server-heading">' +
      '<h3 translate="no">' + esc(row.name || row.host || row.id) + '</h3></div>' +
      '<div class="ce-server-facts"><span translate="no">' + esc(systemLabel(row)) + '</span></div></div></div>' +
      '<div class="ce-server-status"><span class="ce-state" data-state="' + esc(row.online ? row.status || 'ready' : 'offline') + '">' + esc(status(row)) + '</span>' +
      (restricted || (row.statusReason && row.status !== 'ready') ? '<p class="ce-server-description">' + esc(row.statusReason || '此执行机尚未加入当前环境的可用执行名单，请联系管理员。') + '</p>' : '') + '</div>' +
      '<dl class="ce-server-summary"><div><dt>执行容量</dt><dd>' + (row.online ? busy + ' / ' + capacity : '—') + '</dd></div><div><dt>可用 Agent</dt><dd>' + readyCount + '</dd></div><div><dt>连接信息</dt><dd>' + (localCredential.configured ? '已保存' : '未保存') + '</dd></div></dl>' +
      '<div class="ce-server-actions">' + (row.action === 'install_agent' ? '<button type="button" data-ce-agent="' + esc(row.id) + '">准备 Agent</button>' : '') +
      (row.canManage ? '<button type="button" data-ce-connection="' + esc(row.id) + '">连接设置</button><button type="button" data-ce-edit="' + esc(row.id) + '">设置</button><details class="ce-more" data-ce-disclosure="more"><summary aria-label="更多操作"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary><div>' + (row.credential?.canRotate !== false ? '<button type="button" data-ce-credential="' + esc(row.id) + '">更新 Runner 密钥</button>' : '') + '<button type="button" class="ce-remove" data-ce-remove="' + esc(row.id) + '">移除</button></div></details>' : '') + '</div>' +
      '<details class="ce-server-details" data-ce-disclosure="connection"><summary>查看连接详情</summary><dl>' + (row.os ? '<div><dt>系统</dt><dd translate="no">' + esc(row.os) + '</dd></div>' : '') + (row.host && row.host !== row.name ? '<div><dt>主机</dt><dd translate="no">' + esc(row.host) + '</dd></div>' : '') + '<div><dt>工作目录</dt><dd translate="no">' + esc(row.workRoot || tr('使用执行机默认目录')) + '</dd></div>' + (row.version ? '<div><dt>Runner</dt><dd translate="no">' + esc(row.version) + '</dd></div>' : '') + '</dl></details></div>' +
      '<div class="ce-server-content"><section class="ce-harnesses"><div class="ce-harnesses-head"><h3>云端底座</h3><span>在这台云电脑上一键准备</span></div>' +
      (shownAgents.length ? '<div class="ce-harness-grid">' + shownAgents.map(a => harnessView(row, a, !availableAgents.length)).join('') + '</div>' : '<p class="ce-agent-empty">尚未上报服务器信息</p>') +
      '</section></div></article>';
  }
  function forceRender() {
    const body = panel?.querySelector('[data-ce-body]');
    if (body) delete body.dataset.signature;
    render();
  }
  function updateHarness(environmentId, key) {
    const row = data?.environments?.find(item => item.id === environmentId);
    const agent = row?.availableAgents?.find(item => item.id === key);
    const server = Array.from(panel?.querySelectorAll('[data-ce-server]') || []).find(item => item.dataset.ceServer === environmentId);
    const item = Array.from(server?.querySelectorAll('[data-ce-harness]') || []).find(item => item.dataset.ceHarness === key);
    if (!item || !agent) return;
    const opened = Boolean(item.querySelector('details[open]'));
    item.outerHTML = harnessView(row, agent);
    if (opened) Array.from(server.querySelectorAll('[data-ce-harness]')).find(item => item.dataset.ceHarness === key)?.querySelector('details')?.setAttribute('open', '');
  }
  function environmentRemoved(id) {
    if (data && Array.isArray(data.environments)) {
      data = { ...data, environments: data.environments.filter(row => row.id !== id) };
      forceRender();
    }
    void load();
  }
  async function installAgent(environmentId, key, action = 'install') {
    const jobKey = environmentId + ':' + key;
    const scope = ownerScope();
    const current = () => ownerScope() === scope;
    if (agentJobs[jobKey]?.state === 'running' || agentJobs[jobKey]?.state === 'starting') return;
    agentJobs[jobKey] = { state: 'starting', action, ok: false, detail: '' }; updateHarness(environmentId, key);
    try {
      const started = await global.SoduWorkAPI.agentInstall(key, action, environmentId);
      if (!current()) return;
      if (!started?.jobId) throw new Error('服务没有返回安装任务');
      agentJobs[jobKey] = { state: 'running', action, jobId: started.jobId, ok: false, detail: '' }; updateHarness(environmentId, key);
      // npm and an optional platform binary each have a 15-minute server
      // timeout. Do not call a slow but live install failed after 162 seconds.
      const deadline = Date.now() + 45 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 900));
        if (!current()) return;
        const job = await global.SoduWorkAPI.agentJob(started.jobId);
        if (!current()) return;
        if (!job || job.state !== 'done') continue;
        agentJobs[jobKey] = { state: 'done', action, ok: job.ok === true, detail: job.detail || (job.ok ? '' : '安装没有完成，请重试') };
        updateHarness(environmentId, key);
        if (job.ok) { await load(); };
        return;
      }
      throw new Error('安装时间较长，请稍后刷新查看结果');
    } catch (error) {
      if (!current()) return;
      agentJobs[jobKey] = { state: 'done', ok: false, detail: error?.message || '安装失败，请重试' };
      updateHarness(environmentId, key);
    }
  }
  function render() {
    if (!panel || !data) return;
    const rows = Array.isArray(data.environments) ? data.environments : [];
    const canCreate = Boolean(data.permissions?.canCreate) && !rows.length;
    const add = panel.querySelector('[data-ce-add]');
    add.hidden = !canCreate; add.disabled = !canCreate;
    add.title = canCreate ? '配置你的专属云端执行机' : (rows.length ? '每个账号只能配置一台专属云端执行机' : '当前账号暂时不能配置云端执行机');
    const body = panel.querySelector('[data-ce-body]');
    const signature = JSON.stringify(data, (key, value) => key === 'lastSeen' ? undefined : value);
    if (body.dataset.signature === signature) return;
    body.dataset.signature = signature;
    const opened = Array.from(body.querySelectorAll('details[open][data-ce-disclosure]')).map(item => [item.closest('[data-ce-server]')?.dataset.ceServer, item.dataset.ceDisclosure]);
    body.innerHTML = '<div class="ce-content">' +
      (rows.length ? '<div class="ce-servers">' + rows.map(rowView).join('') + '</div>' : '<div class="ce-empty">' + icon + '<h3>还没有专属云端执行机</h3><p>' + (data.permissions?.canCreate ? '添加一台你自己的远程电脑。连接完成后，云端会话会自动使用它。' : '当前账号暂时没有配置权限，请联系管理员开通。') + '</p>' + (data.permissions?.canCreate ? '<button type="button" class="ce-primary" data-ce-add>配置专属执行机</button>' : '') + '</div>') +
      (rows.length ? '<p class="ce-footer-note">在新会话中选择云端执行，即可使用这台电脑。</p>' : '') + '</div>';
    for (const item of body.querySelectorAll('details[data-ce-disclosure]')) {
      if (opened.some(([id, key]) => id === item.closest('[data-ce-server]')?.dataset.ceServer && key === item.dataset.ceDisclosure)) item.open = true;
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (panel?.classList.contains('show')) timer = setTimeout(() => document.hidden ? schedule() : void load(), 15000);
  }
  async function load() {
    scopeChanged();
    if (loading || !panel?.classList.contains('show')) return;
    const ticket = generation; loading = true;
    const refresh = panel.querySelector('[data-ce-refresh]'); refresh.disabled = true; refresh.setAttribute('aria-busy', 'true');
    try {
      const next = await global.SoduWorkAPI.cloudEnvironments();
      scopeChanged();
      if (ticket !== generation || !panel.classList.contains('show')) return;
      if (next?.ok === false) throw Error(next.reason || '无法读取云端环境');
      const local = global.soduWorkAPI?.cloudComputer?.status ? await global.soduWorkAPI.cloudComputer.status() : null;
      scopeChanged();
      if (ticket !== generation || !panel.classList.contains('show')) return;
      if (local?.ok !== false && Array.isArray(next.environments) && local?.configured) {
        const profile = { ...(local.profile || local), configured: true };
        next.environments = next.environments.map(row => ({ ...row, localCredential: profile }));
      }
      data = next; render(); panel.querySelector('[data-ce-error]').hidden = true;
    } catch (error) {
      scopeChanged();
      if (ticket !== generation) return;
      const box = panel.querySelector('[data-ce-error]'); box.textContent = tr(error.message || '无法读取云端环境，请检查服务连接后重试'); box.hidden = false;
      if (!data) panel.querySelector('[data-ce-body]').textContent = '';
    } finally {
      if (ticket === generation) { loading = false; refresh.disabled = false; refresh.removeAttribute('aria-busy'); schedule(); }
    }
  }
  function open() {
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'cloudEnvironmentPanel'; panel.className = 'sch-panel cfg-panel ce-panel';
      panel.innerHTML = '<header class="sch-head ws-page-head"><div class="sch-h-txt"><b class="sch-h-title">云端电脑</b><i class="sch-h-sub">管理远程连接与执行底座</i></div><div class="sch-h-acts"><button type="button" class="btn-mini" data-ce-refresh>' + refreshIcon + '<span>刷新</span></button><button type="button" class="btn-mini primary" data-ce-add hidden><span aria-hidden="true">＋</span>配置执行机</button><button type="button" class="np-close" data-ce-close aria-label="关闭">×</button></div></header><p class="ce-load-error" data-ce-error role="alert" hidden></p><div class="sch-body" data-ce-body></div>';
      document.body.append(panel);
      panel.addEventListener('click', event => {
        scopeChanged();
        const button = event.target.closest('button'); if (!button) return;
        if (button.hasAttribute('data-ce-refresh')) void load();
        else if (button.hasAttribute('data-ce-close')) close();
        else if (button.hasAttribute('data-ce-add')) global.CloudEnvironmentSetup?.open(data, () => load());
        else if (button.hasAttribute('data-ce-connection')) global.CloudEnvironmentSetup?.credentials(data?.environments?.find(row => row.id === button.dataset.ceConnection), () => load());
        else if (button.hasAttribute('data-ce-edit')) global.CloudEnvironmentSetup?.edit(data?.environments?.find(row => row.id === button.dataset.ceEdit), () => load());
        else if (button.hasAttribute('data-ce-credential')) global.CloudEnvironmentSetup?.rotate(data?.environments?.find(row => row.id === button.dataset.ceCredential), () => load(), data?.service);
        else if (button.hasAttribute('data-ce-remove')) global.CloudEnvironmentSetup?.remove(data?.environments?.find(row => row.id === button.dataset.ceRemove), () => environmentRemoved(button.dataset.ceRemove));
        else if (button.hasAttribute('data-ce-install-agent')) void installAgent(button.dataset.ceInstallAgent, button.dataset.ceAgentKey, button.dataset.ceAgentAction || 'install');
        else if (button.hasAttribute('data-ce-agent') && data) global.CloudEnvironmentSetup?.agent(data.agentSetup);
      });
      if (typeof global.makeDraggable === 'function') global.makeDraggable(panel, panel.querySelector('header'));
    }
    owner = ownerScope(); generation++; data = null; loading = false; panel.classList.add('show'); panel.querySelector('[data-ce-error]').hidden = true; panel.querySelector('[data-ce-add]').hidden = true;
    const body = panel.querySelector('[data-ce-body]'); delete body.dataset.signature; body.innerHTML = '<p class="ce-loading" role="status">正在检查你的云端环境…</p>';
    global.expandForOverlay?.(); void load();
  }
  function close() { generation++; loading = false; clearTimeout(timer); timer = null; panel?.classList.remove('show'); global.CloudEnvironmentSetup?.close(); global.shrinkFromOverlay?.(); }
  global.CloudEnvironments = { open, close, refresh: load, esc, icon };
  global.addEventListener?.('soduwork-data-scope-changed', scopeChanged);
  global.addEventListener?.('soduwork-device-auth', scopeChanged);
  global.openCloudEnvironmentsPanel = open;
  global.closeCloudEnvironmentsPanel = close;
})(window);

