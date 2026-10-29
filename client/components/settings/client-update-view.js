(function (global) {
  'use strict';
  const phases = {
    checking: '正在检查更新', downloading: '正在下载新版本', verifying: '正在校验安装包',
    ready: '新版本已准备好', waiting: '等待当前工作结束', preparing: '正在准备更新',
    installing: '正在安装新版本', restarting: '正在重启 SoduWork', installed: 'SoduWork 已更新',
    failed: '更新没有完成', manual: '需要手动更新', deferred: '更新已延后',
  };
  const esc = value => String(value || '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const translate = value => global.SoduWorkI18n?.translateText?.(value) || value;
  function bytes(value) {
    const n = Math.max(0, Number(value) || 0);
    return n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB'
      : (n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0) + ' MB';
  }
  function describe(status = {}) {
    const state = String(status.state || 'idle');
    const terminal = ['failed', 'manual', 'deferred', 'installed', 'current', 'development', 'idle'];
    const phase = terminal.includes(state) ? state : String(status.phase ||
      ({ available: 'downloading', downloaded: 'ready' }[state] || state));
    const active = ['checking', 'downloading', 'verifying', 'preparing', 'installing', 'restarting'].includes(phase);
    const rawProgress = Object.hasOwn(status, 'phaseProgress') ? status.phaseProgress
      : phase === 'downloading' ? status.progress : null;
    const percent = ['downloading', 'verifying'].includes(phase) && rawProgress != null && Number.isFinite(Number(rawProgress))
      ? Math.round(Math.max(0, Math.min(100, Number(rawProgress)))) : null;
    const target = String(status.targetVersion || status.availableVersion || '').trim();
    const count = Array.isArray(status.blockers) ? status.blockers.filter(item => item?.kind !== 'drain-barrier').length : 0;
    const metrics = percent != null ? percent + '%' : '';
    const amount = Number(status.totalBytes) > 0 && phase === 'downloading'
      ? bytes(Math.min(Number(status.receivedBytes) || 0, status.totalBytes)) + ' / ' + bytes(status.totalBytes) : '';
    let detail = phase === 'downloading' ? '正在后台下载，你可以继续工作。'
      : phase === 'verifying' ? '正在确认安装包完整，校验后才会安装。'
      : phase === 'ready' ? '重启后即可使用新版本。'
      : phase === 'waiting' ? (count ? count + ' 项工作尚未结束。' : '正在确认当前工作已结束。') + '结束后自动继续，不会中断任务。'
      : phase === 'preparing' ? '正在准备安全安装，请稍候。'
      : phase === 'installing' || phase === 'restarting' ? '即将短暂关闭，安装进度会继续显示；完成后自动打开。'
      : phase === 'installed' ? '新版本已启动，可以继续工作。'
      : phase === 'checking' ? '正在检查当前后台提供的新版本。'
      : phase === 'current' ? '当前已是最新版本。'
      : phase === 'development' ? '开发运行不执行客户端在线安装。'
      : phase === 'failed' || phase === 'manual' ? String(status.error || '请检查网络后重试。')
      : phase === 'deferred' ? String(status.error || '继续当前工作，方便时再安装。')
      : '后台下载更新，安装前会保护当前工作。';
    if (status.actionMessage) detail += ' ' + status.actionMessage;
    const stage = phase === 'downloading' || phase === 'checking' ? 0
      : phase === 'verifying' ? 1 : phase === 'installed' ? 3 : 2;
    const steps = ['ready', 'waiting', 'installed'].includes(phase)
      ? ['下载完成', '校验通过', phase === 'ready' ? '待重启' : phase === 'waiting' ? '安装前等待' : '安装完成']
      : ['下载', '校验', '安装'];
    return { state, phase, percent, metrics, amount, target, active, stage, steps, currentStage: active ? stage : -1, detail,
      title: phases[phase] || ({ current: '当前版本已就绪', idle: '客户端更新', development: '开发模式' }[phase] || '客户端更新'),
      visible: !['idle', 'current', 'development'].includes(phase) && (phase !== 'checking' || status.interactive === true) &&
        !(phase === 'failed' && status.interactive !== true && !target),
      installable: ['ready', 'deferred'].includes(phase) && Boolean(target),
      progressVisible: !['idle', 'current', 'development', 'manual', 'failed', 'deferred'].includes(phase),
    };
  }
  function renderProgress(host, status) {
    if (!host) return;
    const view = describe(status);
    if (!host.querySelector('[data-update-bar]')) host.innerHTML =
      '<div class="update-progress-meta"><span data-update-amount></span><b data-update-percent></b></div>' +
      '<div class="update-progress-track" data-update-bar role="progressbar"><i></i></div>' +
      '<div class="update-progress-steps">' + view.steps.map((label, index) =>
        '<span data-update-step="' + index + '"><i aria-hidden="true"></i><span data-update-step-label>' +
        esc(translate(label)) + '</span></span>').join('') + '</div>';
    host.hidden = !view.progressVisible;
    host.dataset.phase = view.phase;
    const bar = host.querySelector('[data-update-bar]');
    bar.setAttribute('aria-label', translate(view.title));
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    if (view.percent == null) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(view.percent));
    const complete = ['ready', 'waiting', 'installed'].includes(view.phase);
    bar.classList.toggle('is-indeterminate', view.active && view.percent == null);
    bar.querySelector('i').style.width = view.percent != null ? view.percent + '%' : complete ? '100%' : '0%';
    // Show the title once and hide empty progress details when no transfer data is available.
    host.querySelector('.update-progress-meta').hidden = !view.amount && !view.metrics;
    host.querySelector('[data-update-amount]').textContent = view.amount;
    host.querySelector('[data-update-percent]').textContent = view.metrics;
    host.querySelectorAll('[data-update-step]').forEach((step, index) => {
      step.querySelector('[data-update-step-label]').textContent = translate(view.steps[index]);
      step.classList.toggle('is-complete', index < view.stage);
      step.classList.toggle('is-current', index === view.currentStage);
    });
  }
  function renderReleaseNotes(host, status = {}) {
    if (!host) return;
    const notes = typeof status.releaseNotes === 'string' ? status.releaseNotes.trim() : '';
    const version = String(status.targetVersion || '');
    host.hidden = !notes || !version;
    if (host.dataset.version !== version) host.open = false;
    host.dataset.version = version;
    host.querySelector('summary').textContent = translate('更新内容') + (version ? ' · v' + version : '');
    const body = host.querySelector('[data-release-notes-body]');
    // Release notes are data, never HTML or translatable interface labels.
    if (body.textContent !== notes) body.textContent = notes;
  }
  let status = {}, notice, badge, pending = false, dismissedKey = '', currentKey = '', visiblePhase = '';
  function mount() {
    if (notice?.isConnected) return;
    notice = document.createElement('aside'); notice.className = 'update-notice'; notice.hidden = true;
    notice.setAttribute('aria-label', translate('客户端更新进度'));
    notice.innerHTML = '<div class="update-notice-head"><span>' + esc(translate('客户端更新')) +
      '</span><b data-update-version></b><button type="button" class="update-notice-close" data-update-close aria-label="' + esc(translate('收起更新进度')) +
      '"><svg viewBox="0 0 20 20"><path d="m6 6 8 8m0-8-8 8"/></svg></button></div>' +
      '<strong class="update-notice-title" data-update-title aria-live="polite"></strong>' +
      '<div class="update-progress" data-update-progress></div><p data-update-detail></p>' +
      '<details class="client-release-notes" data-update-notes hidden><summary></summary><div data-release-notes-body data-user-content></div></details>' +
      '<div class="update-notice-actions"><button type="button" data-update-details>' + esc(translate('查看详情')) +
      '</button><button type="button" class="update-notice-primary" data-update-action></button></div>';
    document.body.appendChild(notice);
    notice.querySelector('[data-update-close]').addEventListener('click', () => {
      dismissedKey = currentKey; notice.hidden = true; badge?.setAttribute('aria-expanded', 'false'); badge?.focus();
    });
    notice.querySelector('[data-update-details]').addEventListener('click', showDetails);
    notice.querySelector('[data-update-action]').addEventListener('click', performAction);
    notice.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); notice.querySelector('[data-update-close]').click(); }
    });
  }
  function showDetails() {
    // The workspace route mounts settings and updates the active page/navigation.
    if (typeof global.openSettingsEntry === 'function') global.openSettingsEntry();
    else if (typeof global.openSettings === 'function') global.openSettings();
    // Settings resets its scroll position on the next frame. Reveal the update
    // card after that reset, so the user lands on the requested details.
    global.requestAnimationFrame(() => {
      const card = document.getElementById('clientUpdateBadge')?.closest('.client-update-card');
      if (card) { card.scrollIntoView({ block: 'center', behavior: 'instant' });
        const button = document.getElementById('clientUpdateAction'); button?.focus({ preventScroll: true }); }
    });
    if (notice) { dismissedKey = currentKey; notice.hidden = true; badge?.setAttribute('aria-expanded', 'false'); }
  }
  async function performAction() {
    const view = describe(status), before = status;
    if (!view.installable && !['failed', 'manual'].includes(view.phase)) { showDetails(); return; }
    if (pending) return;
    const api = global.soduWorkAPI;
    if (!api) return;
    pending = true; paintNotice();
    try {
      const result = view.installable ? await api.installClientUpdate() : await api.checkClientUpdate({ interactive: true });
      if (status === before && result) present(result, badge);
    } catch (error) {
      /* Keep low-level errors (fetch failed / IPC prefixes) out of the UI; the raw error goes to the console. */
      console.error('[client-update]', error);
      const raw = String(error && error.message || error || '');
      const display = !raw || /invoking remote method|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|HTTP \d{3}/i.test(raw)
        ? '请检查网络后重新检查。' : raw;
      present({ ...status, state: 'failed', error: display }, badge);
    }
    finally { pending = false; paintNotice(); }
  }
  function paintNotice() {
    if (!notice) return;
    const view = describe(status);
    notice.dataset.phase = view.phase;
    notice.querySelector('[data-update-title]').textContent = translate(view.title);
    notice.querySelector('[data-update-version]').textContent = view.target ? 'v' + view.target : '';
    notice.querySelector('[data-update-detail]').textContent = translate(view.detail);
    renderProgress(notice.querySelector('[data-update-progress]'), status);
    renderReleaseNotes(notice.querySelector('[data-update-notes]'), status);
    const action = notice.querySelector('[data-update-action]');
    action.hidden = !(view.installable || ['failed', 'manual', 'waiting'].includes(view.phase));
    action.disabled = pending && view.phase !== 'waiting';
    action.textContent = translate(pending && view.phase !== 'waiting' ? '正在准备…' : view.installable ? '重启并更新'
      : view.phase === 'waiting' ? '查看等待中的工作' : '重新检查');
  }
  function paintBadge(view) {
    if (!badge) return;
    if (!badge.querySelector('.update-ring')) {
      badge.innerHTML = '<svg class="update-ring" viewBox="0 0 36 36" aria-hidden="true">' +
        '<circle class="update-ring-track" cx="18" cy="18" r="15"/>' +
        '<circle class="update-ring-value" cx="18" cy="18" r="15" pathLength="100"/>' +
        '<path class="update-ring-glyph" d="M18 11v12m-4-4 4 4 4-4"/></svg>';
      badge.addEventListener('click', () => {
        mount(); notice.hidden = !notice.hidden; dismissedKey = notice.hidden ? currentKey : '';
        badge.setAttribute('aria-expanded', String(!notice.hidden)); paintNotice();
      });
    }
    badge.hidden = !view.visible; badge.disabled = false;
    badge.dataset.updateState = view.state;
    badge.classList.remove('is-busy'); badge.classList.add('has-update-progress');
    badge.title = translate(view.title) + (view.percent != null ? ' · ' + view.percent + '%' : '') +
      (view.target ? ' · SoduWork ' + view.target : '') + ' · ' + translate('查看更新进度');
    badge.setAttribute('aria-label', badge.title); badge.setAttribute('aria-expanded', String(!notice.hidden));
    const ring = badge.querySelector('.update-ring');
    ring.classList.toggle('is-indeterminate', view.active && view.percent == null);
    ring.style.setProperty('--update-percent', view.percent == null ? '100' : String(view.percent));
  }
  function present(next, button) {
    status = next && typeof next === 'object' ? next : {};
    badge = button || badge; const view = describe(status);
    currentKey = String(view.target || status.attemptId || view.phase);
    mount();
    // A download never steals focus. After minimizing, its percentage events
    // stay quiet; a real failure or installation handoff is visible again.
    if (!view.visible) notice.hidden = true;
    else if (dismissedKey !== currentKey || view.phase !== visiblePhase && ['failed', 'restarting', 'installed'].includes(view.phase)) notice.hidden = false;
    visiblePhase = view.phase;
    paintNotice(); paintBadge(view);
  }
  global.ClientUpdateView = { describe, renderProgress, renderReleaseNotes, present, showDetails };
})(window);
