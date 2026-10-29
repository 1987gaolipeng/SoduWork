/* Personal and team daily or weekly briefs display backend facts without fabricated examples. */
(function (global) {
  'use strict';

  let panel = null;
  let body = null;
  let data = null;
  let period = 'daily';
  let scope = 'mine';
  let anchor = '';
  let orgId = '';
  let busy = '';
  let error = '';
  let requestSeq = 0;

  const icon = (path) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>';
  const ICON = {
    brief: icon('<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h5M9 12h7M9 16h7"/>'),
    left: icon('<path d="M15 6l-6 6 6 6"/>'),
    right: icon('<path d="M9 6l6 6-6 6"/>'),
    copy: icon('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
    refresh: icon('<path d="M20 11a8 8 0 1 0 1 4M20 4v7h-7"/>'),
    check: icon('<path d="M5 12l4 4L19 6"/>'),
    chevron: icon('<path d="M9 6l6 6-6 6"/>'),
    team: icon('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M15 11a3 3 0 1 0-1.5-5.6M16 15a5 5 0 0 1 5 5"/>'),
    person: icon('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    warn: icon('<path d="M12 3L2.8 20h18.4z"/><path d="M12 9v5M12 17h.01"/>'),
    empty: icon('<path d="M5 4h14v16H5z"/><path d="M9 9h6M9 13h6M9 17h4"/>'),
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  function mount() {
    if (panel) return panel;
    panel = document.createElement('section');
    panel.id = 'briefPanel';
    panel.className = 'brief-panel';
    panel.setAttribute('aria-label', '简报');
    panel.innerHTML =
      '<header class="br-page-head ws-page-head">' +
        '<div class="br-title-mark">' + ICON.brief + '</div>' +
        '<div class="br-page-title"><span class="br-kicker" data-i18n="eyebrow.briefs">BRIEFS</span><h1>简报</h1><p>把任务事实整理成可读、可追溯的个人与团队总结</p></div>' +
        '<div class="br-head-actions"><button type="button" class="br-quiet" data-copy disabled>' +
          ICON.copy + '<span>复制全文</span></button></div>' +
      '</header>' +
      '<div class="br-toolbar">' +
        '<div class="br-switch" role="group" aria-label="简报周期">' +
          '<button type="button" data-period="daily">日报</button>' +
          '<button type="button" data-period="weekly">周报</button></div>' +
        '<div class="br-switch br-scope" role="group" aria-label="简报范围">' +
          '<button type="button" data-scope="mine">' + ICON.person + '我的</button>' +
          '<button type="button" data-scope="team">' + ICON.team + '团队概况</button></div>' +
        '<div class="br-period-nav"><button type="button" data-shift="-1" aria-label="上一周期">' + ICON.left + '</button>' +
          '<button type="button" class="br-period-label" data-current></button>' +
          '<button type="button" data-shift="1" aria-label="下一周期">' + ICON.right + '</button></div>' +
        '<button type="button" class="br-primary" data-generate>' + ICON.refresh + '<span>更新简报</span></button>' +
      '</div>' +
      '<main class="br-body" id="briefBody"></main>';
    document.body.appendChild(panel);
    body = panel.querySelector('#briefBody');
    panel.addEventListener('click', onClick);
    return panel;
  }

  function periodAt(delta) {
    const info = data && data.period;
    const raw = (info && info.start) || anchor || localToday();
    const bits = raw.split('-').map(Number);
    const date = new Date(bits[0], bits[1] - 1, bits[2]);
    date.setDate(date.getDate() + delta * (period === 'weekly' ? 7 : 1));
    return localDate(date);
  }

  function localDate(date) {
    const pad = (n) => n < 10 ? '0' + n : String(n);
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function localToday() { return localDate(new Date()); }

  async function onClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.period) {
      period = button.dataset.period; anchor = ''; orgId = ''; await load(); return;
    }
    if (button.dataset.scope) {
      scope = button.dataset.scope; orgId = ''; await load(); return;
    }
    if (button.dataset.shift) {
      anchor = periodAt(Number(button.dataset.shift)); orgId = ''; await load(); return;
    }
    if (button.hasAttribute('data-current')) { anchor = ''; orgId = ''; await load(); return; }
    if (button.hasAttribute('data-generate')) { await generate(); return; }
    if (button.hasAttribute('data-copy')) { await copyCurrent(); return; }
    if (button.dataset.org !== undefined) { orgId = button.dataset.org || ''; await load(); return; }
    if (button.hasAttribute('data-confirm')) { await confirmCurrent(); return; }
    if (button.hasAttribute('data-retry')) { await load(); }
  }

  function syncToolbar() {
    if (!panel) return;
    panel.querySelectorAll('[data-period]').forEach((button) => {
      const on = button.dataset.period === period;
      button.classList.toggle('is-active', on); button.setAttribute('aria-pressed', String(on));
    });
    panel.querySelectorAll('[data-scope]').forEach((button) => {
      const on = button.dataset.scope === scope;
      button.classList.toggle('is-active', on); button.setAttribute('aria-pressed', String(on));
    });
    const capability = data && data.capability;
    const team = panel.querySelector('[data-scope="team"]');
    if (team) team.hidden = !!capability && !capability.canManage;
    const label = panel.querySelector('[data-current]');
    if (label) label.textContent = (data && data.period && data.period.label) || (period === 'weekly' ? '本周' : '今天');
    const next = panel.querySelector('[data-shift="1"]');
    if (next) next.disabled = !!(data && data.period && data.period.isCurrent);
    const generateButton = panel.querySelector('[data-generate]');
    if (generateButton) {
      generateButton.disabled = !!busy;
      const text = generateButton.querySelector('span');
      if (text) text.textContent = busy === 'generate' ? '正在整理…' :
        (scope === 'team' ? '刷新团队概况' : ('更新' + (period === 'weekly' ? '周报' : '日报')));
    }
    const copy = panel.querySelector('[data-copy]');
    if (copy) copy.disabled = !currentContent();
  }

  function loadingHtml() {
    return '<div class="br-skeleton" aria-label="正在加载工作简报">' +
      '<i></i><i></i><i></i><i></i><i></i><i></i></div>';
  }

  function errorHtml(message) {
    return '<div class="br-state"><span class="is-warn">' + ICON.warn + '</span><div><b>简报没有加载出来</b>' +
      '<p>' + esc(message || '检查服务连接后再试一次。') + '</p></div>' +
      '<button type="button" data-retry>重新加载</button></div>';
  }

  function metric(value, label, note, tone) {
    return '<div class="br-metric ' + (tone || '') + '"><b>' + esc(value) + '</b><span>' + esc(label) +
      '</span>' + (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';
  }

  function sourceRows(items) {
    if (!items || !items.length) return '<p class="br-source-empty">这个周期还没有可回溯的任务记录。</p>';
    return items.map((item) => '<details class="br-source"><summary><span class="br-source-state ' +
      (item.closedInPeriod || item.closedToday ? 'is-done' : 'is-live') + "\"></span><b data-user-content>" + esc(item.title) +
      '</b><em>' + esc(item.closedInPeriod || item.closedToday ? '已完成' : (item.statusCn || '有进展')) +
      '</em>' + ICON.chevron + '</summary><div>' + ((item.progress || []).length
        ? item.progress.map((text) => '<p>' + esc(text) + '</p>').join('')
        : '<p>本周期办结，未单独填写进展说明。</p>') + '</div></details>').join('');
  }

  function emptyPersonal(mine) {
    const has = mine && mine.hasMaterial;
    return '<div class="br-state br-state-main"><span>' + ICON.empty + '</span><div><b>' +
      (has ? '事实已经就绪，可以生成简报' : '这个周期还没有工作事实') + '</b><p>' +
      (has ? 'SoduWork 会依据任务进展、完成记录和当前待办整理，不需要从空白文档开始写。'
           : '在任务详情里记录真实进展，完成任务后也会自动成为简报素材。') +
      '</p></div>' + (has ? '<button type="button" data-generate>生成' +
        (period === 'weekly' ? '周报' : '日报') + '</button>' : '') + '</div>';
  }

  function personalHtml(payload) {
    const mine = payload.personal || {};
    const report = mine.report;
    if (!report) return emptyPersonal(mine);
    const updated = report.updatedAt ? new Date(report.updatedAt).toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'), {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '';
    return '<div class="br-layout"><article class="br-sheet">' +
      '<div class="br-period-spine"><span>' + esc(report.periodLabel || payload.period.label) + '</span><i></i><em>' +
        (report.source === 'llm' ? 'AI 归纳 · 事实可追溯' : '规则整理 · 事实可追溯') + '</em></div>' +
      '<div class="br-metrics">' + metric(report.doneCount, '已完成', '本周期办结', 'is-ok') +
        metric(report.activeCount, '有进展', report.progressCount + ' 条记录', 'is-blue') +
        metric(mine.openCount, period === 'weekly' ? '下周关注' : '当前待办', '仍在手上的工作', '') + '</div>' +
      '<section class="br-narrative"><header><div><small data-i18n="eyebrow.personal_brief">PERSONAL BRIEF</small><h2>' +
        (period === 'weekly' ? '我的工作周报' : '我的工作日报') + '</h2></div><span>' + esc(updated ? '更新于 ' + updated : '') +
        '</span></header><pre>' + esc(report.content) + '</pre></section>' +
      '</article><aside class="br-evidence"><header><div><small data-i18n="eyebrow.evidence">EVIDENCE</small><h3>来源与记录</h3></div><em>' +
        (report.items || []).length + ' 项</em></header><div>' + sourceRows(report.items || []) + '</div></aside></div>';
  }

  function factBlock(title, rows, tone) {
    const list = rows || [];
    return '<section class="br-facts ' + (tone || '') + '"><header><b>' + esc(title) + '</b><em>' + list.length +
      '</em></header>' + (list.length ? '<ul>' + list.slice(0, 8).map((row) => '<li><span>' +
        esc(row.text || '') + '</span>' + ((row.teams || []).length ? '<small>' + esc(row.teams.join('、')) +
        '</small>' : '') + '</li>').join('') + '</ul>' : '<p>本周期没有相关事实。</p>') + '</section>';
  }

  function reportState(report) {
    if (!report) return ['尚未生成', 'is-missing'];
    if (report.needsRefresh) return ['事实已变化', 'is-stale'];
    if (report.status === 'confirmed') return ['负责人已确认', 'is-confirmed'];
    return ['待负责人确认', 'is-ready'];
  }

  function teamChildren(team) {
    const rows = team.childTeams || [];
    if (!rows.length) return '<p class="br-source-empty">当前团队没有直属下级团队。</p>';
    return rows.map((item) => {
      const state = reportState(item.report);
      return '<button type="button" class="br-team-row" data-org="' + esc(item.org.id) + '"><span>' +
        ICON.team + "</span><div><b data-user-content>" + esc(item.org.name) + '</b><small>' +
        esc(item.report ? ((item.report.metrics && item.report.metrics.reportedMembers || 0) + ' 人已形成简报') : '尚未形成团队概况') +
        '</small></div><em class="' + state[1] + '">' + state[0] + '</em>' + ICON.chevron + '</button>';
    }).join('');
  }

  function breadcrumbs(team) {
    const rows = team.breadcrumbs || [];
    if (!rows.length) return '';
    return '<nav class="br-crumbs" aria-label="团队层级">' + rows.map((row, index) =>
      '<button type="button" data-org="' + esc(row.id) + '"' + (index === rows.length - 1 ? ' disabled' : '') + '>' +
      esc(row.name) + '</button>' + (index < rows.length - 1 ? '<i>›</i>' : '')).join('') + '</nav>';
  }

  function memberSources(team) {
    const members = team.members || [];
    if (!members.length) return '<p class="br-source-empty">直属成员还没有形成这个周期的个人简报。</p>';
    return members.map((member) => '<details class="br-source br-member"><summary><span class="br-avatar">' +
      esc((member.userName || '员').slice(0, 1)) + "</span><b" + (member.userName ? ' data-user-content' : '') + '>' + esc(member.userName || '成员') + '</b><em>' +
      esc(member.doneCount + ' 完成 · ' + member.progressCount + ' 记录') + '</em>' + ICON.chevron +
      '</summary><div><pre>' + esc(member.content || '') + '</pre></div></details>').join('');
  }

  function emptyTeam(team) {
    return '<div class="br-state br-state-main"><span>' + ICON.team + '</span><div><b>团队概况尚未形成</b>' +
      '<p>点击“刷新团队概况”，SoduWork 会先整理成员事实，再从下级团队逐级向上归纳。</p></div>' +
      '<button type="button" data-generate>刷新团队概况</button></div>' +
      (team && (team.childTeams || []).length ? '<section class="br-list-card"><header><b>直属团队</b></header>' +
        teamChildren(team) + '</section>' : '');
  }

  function teamHtml(payload) {
    const team = payload.team || {};
    const report = team.teamReport;
    if (!report) return breadcrumbs(team) + emptyTeam(team);
    const metrics = report.metrics || {};
    const summary = report.summary || {};
    const state = reportState(report);
    const coverage = Math.round(Number(metrics.coverage || 0) * 100);
    return breadcrumbs(team) + (report.needsRefresh ? '<div class="br-alert">' + ICON.warn +
      '<div><b>团队事实已经变化</b><p>当前结论仍可阅读，但确认前需要重新刷新。</p></div></div>' : '') +
      '<div class="br-layout br-team-layout"><article class="br-sheet">' +
        '<div class="br-period-spine"><span>' + esc(report.periodLabel || payload.period.label) + '</span><i></i>' +
          '<em class="br-status ' + state[1] + '">' + state[0] + '</em></div>' +
        '<div class="br-metrics br-team-metrics">' + metric(coverage + '%', '简报覆盖',
          (metrics.reportedMembers || 0) + ' / ' + (metrics.memberTotal || 0) + ' 人', coverage === 100 ? 'is-ok' : 'is-blue') +
          metric(metrics.doneCount || 0, '团队成果', '本周期完成', 'is-ok') +
          metric(metrics.activeCount || 0, '持续推进', (metrics.progressCount || 0) + ' 条记录', 'is-blue') +
          metric(metrics.riskCount || 0, '风险信号', '需要负责人关注', metrics.riskCount ? 'is-risk' : '') + '</div>' +
        '<section class="br-narrative"><header><div><small data-i18n="eyebrow.team_brief">TEAM BRIEF</small><h2>' + esc(report.orgName) +
          (period === 'weekly' ? '团队周报' : '团队概况') + '</h2></div><div class="br-narrative-actions">' +
          (report.status !== 'confirmed' && !report.needsRefresh ? '<button type="button" data-confirm>' + ICON.check + '确认这版</button>' : '') +
          '</div></header><pre>' + esc(report.content) + '</pre>' + (report.leaderNote ? '<blockquote><b>负责人补充</b><span>' +
          esc(report.leaderNote) + '</span></blockquote>' : '') + '</section>' +
        '<div class="br-fact-grid">' + factBlock('关键成果', summary.outcomes, 'is-outcome') +
          factBlock('推进与关注', summary.inProgress, 'is-progress') + factBlock('风险', summary.risks, 'is-risk') +
          factBlock('需要协同', summary.coordination, 'is-coordinate') + '</div>' +
      '</article><aside class="br-evidence br-team-aside"><section><header><div><small data-i18n="eyebrow.teams">TEAMS</small><h3>直属团队</h3></div><em>' +
        (team.childTeams || []).length + ' 个</em></header><div>' + teamChildren(team) + '</div></section>' +
        '<section><header><div><small data-i18n="eyebrow.sources">SOURCES</small><h3>直属成员事实</h3></div><em>' +
        (team.members || []).length + ' 人</em></header><div>' + memberSources(team) + '</div></section></aside></div>';
  }

  function currentContent() {
    if (!data) return '';
    if (scope === 'mine') return data.personal && data.personal.report && data.personal.report.content || '';
    return data.team && data.team.teamReport && data.team.teamReport.content || '';
  }

  async function copyCurrent() {
    const text = currentContent();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch (_error) {
      const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area);
      area.select(); document.execCommand('copy'); area.remove();
    }
    if (typeof petSay === 'function') petSay('简报全文已复制');
  }

  async function confirmCurrent() {
    const report = data && data.team && data.team.teamReport;
    if (!report || !global.confirm((global.SoduWorkI18n?.translateText || String)('确认当前团队事实和这版结论？来源变化后，确认会自动失效。'))) return;
    busy = 'confirm'; syncToolbar();
    try {
      await SoduWorkAPI.confirmTeamReport(report.id, '');
      if (typeof petSay === 'function') petSay('团队简报已确认');
      await load();
    } catch (exception) {
      if (typeof petSay === 'function') petSay(_humanErr(exception, '确认没有成功'));
    } finally { busy = ''; syncToolbar(); }
  }

  async function generate() {
    busy = 'generate'; error = ''; syncToolbar();
    try {
      await SoduWorkAPI.generateWorkReports({ period, anchor, scope, orgId });
      if (typeof petSay === 'function') petSay(scope === 'team' ? '团队概况已刷新' : '工作简报已更新');
      await load();
    } catch (exception) {
      if (typeof petSay === 'function') petSay(_humanErr(exception, '简报没有生成'));
    } finally { busy = ''; syncToolbar(); }
  }

  async function load() {
    mount();
    const seq = ++requestSeq;
    error = ''; body.innerHTML = loadingHtml(); syncToolbar();
    try {
      const result = await SoduWorkAPI.getWorkReports(period, anchor, scope, orgId);
      if (seq !== requestSeq) return;
      data = result || null;
      if (scope === 'team' && data && data.capability && !data.capability.canManage) {
        scope = 'mine'; orgId = ''; return await load();
      }
      body.innerHTML = scope === 'team' ? teamHtml(data || {}) : personalHtml(data || {});
    } catch (exception) {
      if (seq !== requestSeq) return;
      data = null; error = (exception && exception.message) || String(exception || '');
      body.innerHTML = errorHtml(error);
    }
    syncToolbar();
  }

  function openBriefsPanel(options) {
    mount();
    const opts = options || {};
    if (opts.period === 'weekly' || opts.period === 'daily') period = opts.period;
    if (opts.scope === 'team' || opts.scope === 'mine') scope = opts.scope;
    if (opts.anchor !== undefined) anchor = String(opts.anchor || '');
    if (opts.orgId !== undefined) orgId = String(opts.orgId || '');
    panel.classList.add('show');
    load();
  }

  function closeBriefsPanel() {
    if (!panel) return;
    requestSeq++; panel.classList.remove('show');
  }

  global.openBriefsPanel = openBriefsPanel;
  global.closeBriefsPanel = closeBriefsPanel;
})(window);
