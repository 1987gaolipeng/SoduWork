/*
 * Read personal usage from the shared ledger. Agent distributions accept any runtime
 * reporting the common usage contract.
 */
(function (global) {
  'use strict';

  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/><path d="m4 8 6-4 6 5 5-4"/></svg>';
  const AGENT_NAMES = {
    pi: 'Pi', opencode: 'OpenCode', codex: 'Codex',
    'codex-harness': 'Codex Harness', 'claude-code': 'Claude Code',
    harness2: 'Google Harness²',
  };
  // Backend labels (SOURCE_LABELS) and default task titles arrive in Chinese;
  // joined rows bypass the DOM adapter's per-node translation, so data values
  // are translated here. Unknown user-authored titles pass through untouched.
  const tr = value => {
    const text = value === undefined || value === null ? '' : String(value);
    return global.SoduWorkI18n ? global.SoduWorkI18n.translateText(text) : text;
  };
  let days = 30;
  let data = null;
  let seq = 0;
  let refreshTimer = null;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function count(value) {
    const n = Math.max(0, Number(value || 0));
    return Math.round(n).toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'));
  }

  /*
   * Use compact localized totals to fit the hero layout; retain exact numbers in tooltips
   * and exports. Chinese uses ten-thousand and hundred-million units; other locales use Intl
   * compact notation.
   */
  function compact(value) {
    const n = Math.max(0, Number(value || 0));
    const trim = (x) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''));
    if (n < 10000) return count(n);
    const locale = String(globalThis.SoduWorkI18n?.getLocale() || 'zh-CN');
    if (/^zh/i.test(locale)) {
      if (n < 1e8) return trim(n / 1e4) + ' 万';
      if (n < 1e12) return trim(n / 1e8) + ' 亿';
      return trim(n / 1e12) + ' 万亿';
    }
    try {
      return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
    } catch {
      if (n < 1e8) return trim(n / 1e4) + ' 万';
      if (n < 1e12) return trim(n / 1e8) + ' 亿';
      return trim(n / 1e12) + ' 万亿';
    }
  }

  function precise(value) {
    return Math.max(0, Number(value || 0)).toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'));
  }

  function money(micro) {
    const n = Math.max(0, Number(micro || 0)) / 1000000;
    if (!n) return '待对账';
    if (n < 0.01) return '< $0.01';
    return '$' + n.toFixed(n < 10 ? 2 : 1);
  }

  function duration(ms) {
    const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (seconds < 60) return seconds + ' 秒';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return mins + ' 分钟';
    const hours = mins / 60;
    return (hours < 10 ? hours.toFixed(1) : Math.round(hours)) + ' 小时';
  }

  function when(value) {
    if (!value) return '刚刚';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'), {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function agentName(key) {
    const raw = String(key || 'unknown');
    return AGENT_NAMES[raw.toLowerCase()] || raw;
  }

  function share(value, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100 / total)));
  }

  function openUsagePanel(options) {
    if (options && options.days) days = Math.max(1, Math.min(365, Number(options.days)));
    const p = mount();
    p.classList.add('show');
    if (typeof expandForOverlay === 'function') expandForOverlay();
    syncRange();
    loadUsage();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (p.classList.contains('show')) loadUsage(true);
    }, 60000);
  }

  function closeUsagePanel() {
    const p = document.getElementById('usagePanel');
    if (p) p.classList.remove('show');
    clearInterval(refreshTimer); refreshTimer = null;
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }

  function mount() {
    let p = document.getElementById('usagePanel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'usagePanel';
    p.className = 'sch-panel usage-panel';
    p.innerHTML =
      '<div class="sch-head usage-head ws-page-head">' +
        '<span class="sch-h-ico">' + ICON + '</span>' +
        '<div class="sch-h-txt"><span class="sch-h-kicker" data-i18n="eyebrow.personal_ai_usage">PERSONAL AI USAGE</span>' +
          '<b class="sch-h-title">我的用量</b>' +
          '<i class="sch-h-sub">看清 AI 时间花在了哪些工作、由哪些 Agent 完成</i></div>' +
        '<nav class="usage-range" aria-label="统计周期">' +
          '<button data-days="7">7 天</button><button data-days="30">30 天</button><button data-days="90">90 天</button>' +
        '</nav>' +
        '<div class="sch-h-acts">' +
          '<button class="usage-refresh" id="usageRefresh" title="刷新用量" aria-label="刷新用量">' +
            '<svg viewBox="0 0 24 24"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9M5.5 15A7 7 0 0 0 18 17.5l2-2.5"/></svg>' +
          '</button><button class="np-close" id="usageClose">✕</button></div>' +
      '</div><div class="usage-body" id="usageBody"></div>';
    document.body.appendChild(p);
    p.querySelector('#usageClose').addEventListener('click', closeUsagePanel);
    p.querySelector('#usageRefresh').addEventListener('click', () => loadUsage(true));
    p.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => {
      const next = Number(button.dataset.days || 30);
      if (next === days) return;
      days = next; syncRange(); loadUsage(true);
    }));
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.sch-head'));
    return p;
  }

  function syncRange() {
    const p = document.getElementById('usagePanel');
    if (!p) return;
    p.querySelectorAll('[data-days]').forEach((button) => {
      const on = Number(button.dataset.days) === days;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function loading() {
    return '<div class="usage-loading">' +
      '<div class="usage-sk usage-sk-hero"></div>' +
      '<div class="usage-sk-grid"><i></i><i></i></div>' +
      '<div class="usage-sk usage-sk-list"></div></div>';
  }

  async function loadUsage(force) {
    const box = document.getElementById('usageBody');
    if (!box) return;
    const current = ++seq;
    if (!data) box.innerHTML = loading();
    const refresh = document.getElementById('usageRefresh');
    if (refresh) refresh.classList.add('is-loading');
    try {
      const result = await SoduWorkAPI.myUsage(days);
      if (current !== seq || document.getElementById('usageBody') !== box) return;
      if (refresh) {
        refresh.classList.remove('has-error');
        refresh.title = '\u5237\u65b0\u7528\u91cf';
      }
      data = result || {};
      render(box, data);
    } catch (error) {
      if (current !== seq || document.getElementById('usageBody') !== box) return;
      if (data) {
        if (refresh) {
          refresh.classList.add('has-error');
          refresh.title = '\u5237\u65b0\u5931\u8d25\uff0c\u5df2\u4fdd\u7559\u4e0a\u6b21\u6570\u636e';
        }
        return;
      }
      box.innerHTML = '<div class="usage-empty">' + ICON +
        '<b>暂时拿不到用量</b><span>' + esc(
          typeof _humanErr === 'function' ? _humanErr(error, '连接服务后再试一次') : '连接服务后再试一次'
        ) + '</span><button id="usageRetry">重新加载</button></div>';
      const retry = box.querySelector('#usageRetry');
      if (retry) retry.addEventListener('click', () => loadUsage(true));
    } finally {
      if (current === seq && refresh) refresh.classList.remove('is-loading');
    }
  }

  function sourceRail(items, total) {
    if (!items.length || !total) return '<div class="usage-rail-empty">这段时间还没有可统计的 AI 工作</div>';
    return '<div class="usage-rail" aria-label="工作场景分布">' + items.map((item, index) =>
      '<i class="usage-c' + (index % 6) + '" style="width:' + Math.max(2, share(item.tokens, total)) +
      '%" title="' + esc(tr(item.label)) + ' ' + share(item.tokens, total) + '%"></i>'
    ).join('') + '</div><div class="usage-rail-legend">' + items.slice(0, 5).map((item, index) =>
      '<span><i class="usage-c' + (index % 6) + '"></i>' + esc(tr(item.label)) +
      '<em>' + share(item.tokens, total) + '%</em></span>'
    ).join('') + '</div>';
  }

  function trendChart(items) {
    const points = (items || []).slice(-14);
    const max = Math.max(1, ...points.map((item) => Number(item.tokens || 0)));
    if (!points.length) return '<div class="usage-trend-empty">产生用量后，这里会显示每天的工作节奏</div>';
    return '<div class="usage-trend" aria-label="每日用量趋势">' + points.map((item, index) => {
      const height = Math.max(5, Math.round(Number(item.tokens || 0) * 100 / max));
      const show = index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2);
      return '<span title="' + esc(item.key) + ' · ' + precise(item.tokens) + ' tokens">' +
        '<i style="height:' + height + '%"></i><em>' + (show ? esc(String(item.label || '').replace('-', '/')) : '') + '</em></span>';
    }).join('') + '</div>';
  }

  function metricRows(items, total, kind) {
    if (!items.length) return '<div class="usage-mini-empty">还没有分布数据</div>';
    return items.slice(0, 6).map((item, index) => {
      const label = kind === 'agent' ? agentName(item.agent || item.label) : tr(item.label || item.key);
      const detail = kind === 'agent'
        ? [item.model, item.provider].filter(Boolean).join(' · ')
        : count(item.sessions) + ' 次工作';
      return '<div class="usage-rank">' +
        '<span class="usage-rank-no">' + String(index + 1).padStart(2, '0') + '</span>' +
        '<div class="usage-rank-main"><b>' + esc(label) + '</b><small>' + esc(detail || '跟随默认模型') + '</small>' +
          '<i><em style="width:' + Math.max(3, share(item.tokens, total)) + '%"></em></i></div>' +
        '<strong>' + compact(item.tokens) + '</strong></div>';
    }).join('');
  }

  function recentRows(items) {
    if (!items.length) return '<div class="usage-mini-empty usage-recent-empty">最近还没有 AI 工作记录</div>';
    return items.slice(0, 12).map((item) => {
      const taskId = String(item.taskId || '');
      const clickable = taskId ? ' is-clickable' : '';
      return '<button class="usage-event' + clickable + '" type="button" data-task="' + esc(taskId) +
        '"' + (taskId ? '' : ' disabled') + '>' +
        "<span class=\"usage-event-dot\"></span><span class=\"usage-event-copy\"><b" + (item.title ? ' data-user-content' : '') + '>' + esc(tr(item.title) || tr('AI 使用')) +
          '</b><small>' + esc(tr(item.sourceLabel || item.sourceType || '工作')) + ' · ' +
          esc(agentName(item.agent)) + (item.model ? ' · ' + esc(item.model) : '') + '</small></span>' +
        '<span class="usage-event-value"><b>' + compact(item.tokens) + '</b><small>' + esc(when(item.occurredAt)) + '</small></span>' +
      '</button>';
    }).join('');
  }

  function render(box, payload) {
    const summary = payload.summary || {};
    const sources = payload.bySource || [];
    const agents = payload.byAgent || [];
    const total = Number(summary.tokens || 0);
    const quality = payload.quality || {};
    const coverage = Number(quality.coveragePct || 0);
    box.innerHTML =
      '<section class="usage-overview">' +
        '<div class="usage-total"><span>过去 ' + esc(payload.days || days) + ' 天</span>' +
          '<div><b>' + compact(total) + '</b><em>tokens</em></div>' +
          '<small>每一次对话、任务和自动化都汇入同一份账本</small></div>' +
        '<div class="usage-vitals">' +
          '<span><em>AI 工作</em><b>' + precise(summary.sessions) + ' 次</b></span>' +
          '<span><em>活跃时长</em><b>' + duration(summary.durationMs) + '</b></span>' +
          '<span><em>模型成本</em><b>' + money(summary.costMicrousd) + '</b></span>' +
        '</div>' +
        '<div class="usage-flow"><div class="usage-section-label"><span>消费轨迹</span><em>按工作场景归集</em></div>' +
          sourceRail(sources, total) + '</div>' +
        '<div class="usage-trend-wrap"><div class="usage-section-label"><span>每日节奏</span><em>最近 14 个活跃日</em></div>' +
          trendChart(payload.trend || []) + '</div>' +
      '</section>' +
      '<div class="usage-columns">' +
        '<section class="usage-surface"><div class="usage-surface-head"><div><span data-i18n="eyebrow.work_scenes">WORK SCENES</span><b>用在哪些工作</b></div>' +
          '<em>场景自动归集</em></div>' + metricRows(sources, total, 'source') + '</section>' +
        '<section class="usage-surface"><div class="usage-surface-head"><div><span data-i18n="eyebrow.agent_mix">AGENT MIX</span><b>哪些 Agent 在工作</b></div>' +
          '<em>' + agents.length + ' 个 Agent / 模型组合</em></div>' + metricRows(agents, total, 'agent') + '</section>' +
      '</div>' +
      '<section class="usage-surface usage-recent"><div class="usage-surface-head"><div><span data-i18n="eyebrow.recent_activity">RECENT ACTIVITY</span><b>最近的 AI 工作</b></div>' +
        '<em>点击任务记录查看完整链路</em></div><div class="usage-event-list">' +
        recentRows(payload.recent || []) + '</div></section>' +
      '<footer class="usage-quality"><span class="usage-quality-dot' + (coverage >= 90 ? ' is-good' : '') + '"></span>' +
        '<b>数据可信度 ' + coverage + '%</b><span>已上报 ' + precise(quality.reported) +
        ' · 已核对 ' + precise(quality.reconciled) + ' · 估算 ' + precise(quality.estimated) +
        ' · 未知 ' + precise(quality.unknown) + '</span>' +
        '<em>模型未返回价格时只统计 token，不虚构成本</em></footer>';
    box.querySelectorAll('[data-task]').forEach((button) => button.addEventListener('click', () => {
      const taskId = button.dataset.task;
      if (!taskId) return;
      if (typeof global.openDetailEntry === 'function') global.openDetailEntry(taskId);
      else if (global.WorkspaceHost) global.WorkspaceHost.open('detail', { taskId });
    }));
  }

  global.openUsagePanel = openUsagePanel;
  global.closeUsagePanel = closeUsagePanel;
})(window);
