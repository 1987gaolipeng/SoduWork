/*
 * Team members, requirement collaboration, and personal inboxes use GET /api/v1/team for
 * the bound user's department subtree. Administrative configuration stays in the
 * management app. Show genuine empty or unavailable states when data cannot be loaded.
 */
(function () {
  'use strict';

  /* Initialize empty state and display only facts returned after opening the panel. */
  let TEAM = [];
  let WEEK = { labels: [], done: [] };
  let _live = false;   // Whether the state contains backend data.
  let _fetchedOnce = false;   // Whether a fetch has completed, distinguishing initial loading from failure.
  let _sub = '团队';  // Keep the subtitle neutral until role and department data are available.
  let _tab = 0, _reqSeq = 0;
  /* Team requirement-board state. */
  let TEAMTASKS = [], TEAMMEMBERS = [], _ttFormOpen = false, _ttActive = null;
  let _ttFilter = 'open', _ttSearch = '', _ttMember = '';   // Requirement status, search, and member filters.
  let _ttFilterOpen = false;                                 // Start with filter and search controls collapsed.
  let _ttGroupBy = 'member';                                 // Group by member or status.
  let _gvY = null, _gvM = null, _gvOd = false;              // Gantt year, zero-based month, and overdue-only filter.
  let INBOX = [], _canManage = false, _ttToInbox = false;   // Unclaimed inbox items, leadership status, and inbox-assignment mode.
  let _tabManual = false;   // Preserve a manually selected tab instead of correcting the default later.
  /* Team and inbox entries use this panel; daily reports open work briefs. */
  let _entry = 'team';      // 'inbox' | 'team'
  /*
   * Entry metadata defines title, subtitle, icon, default tab, and single-page navigation.
   * Match icons to their dock entry points.
   */
  const _ENTRY_META = {
    inbox: {
      title: '收件箱', sub: '待认领需求 · 认领到自己的 SoduWork', tab: 4, solo: true,
      ico: '<svg viewBox="0 0 24 24"><path d="M4 13h4l1.4 2.6h5.2L16 13h4"/><path d="M6.2 5h11.6l2.2 8v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4z"/></svg>',
    },
    team: {
      title: '团队', sub: '成员与协作', tab: 1, solo: false,
      ico: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M15 11a3 3 0 1 0-2.6-4.5"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M14.5 14.5a5.5 5.5 0 0 1 6 5.5"/></svg>',
    },
  };
  const _meta = () => _ENTRY_META[_entry] || _ENTRY_META.team;
  const _KCOLS = [['todo', '待办', '--s-todo'], ['doing', '进行中', '--s-doing'], ['done', '已完成', '--s-done'], ['cancel', '搁置', '--s-cancel']];
  const _PRIO = { low: '低', high: '高', critical: '紧急' };
  const _fmtD = (ms) => { if (!ms) return ''; const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); };

  /* Map backend responses into view state. */
  function applyData(d) {
    if (!d) { useUnavailable('团队数据暂时不可用'); return; }
    TEAM = (Array.isArray(d.members) ? d.members : []).map((m) => ({
      name: m.name, role: m.role || '', color: m.color || '#7c6cf0',
      userId: m.userId || '',   // Retain owner identity for navigation from overview member cards.
      doing: m.doing | 0, todo: m.todo | 0, done: m.done | 0, cancel: m.cancel | 0,
      stuck: m.stuck | 0, cap: m.cap || 1,
    }));
    WEEK = (d.week && Array.isArray(d.week.done)) ? d.week : { labels: [], done: [] };
    _live = true;
    _canManage = !!d.canManage;
    _sub = d.assigned
      ? (d.orgName || '本部门') + ' · ' + TEAM.length + ' 人'
      : '未归属组织 · 仅本机（请管理员在 SoduWork 管理端分配）';
  }
  function useUnavailable(sub) {
    TEAM = [];
    WEEK = { labels: [], done: [] }; _live = false;
    _sub = sub || '团队数据暂时不可用';
  }
  /*
   * Team subtitles show department context; personal pages show their own descriptions. Both
   * report unavailable data when appropriate.
   */
  function _applySub() {
    const el = document.querySelector('#teamPanel .tp-sub');
    if (!el) return;
    const m = _meta();
    // Show the page description before the first fetch completes.
    // Report offline state only after a failed fetch, avoiding a misleading startup flash.
    const offline = _fetchedOnce && !_live;
    el.textContent = m.solo ? (offline ? '离线 · 后端未连接' : m.sub) : _sub;
    el.classList.toggle('is-unavailable', !_live && _fetchedOnce);
  }

  /* Overview of progress, workload, completion, trends, and distribution. */
  function _board() {
    return window.SoduWorkTeamOverview.render({ members: TEAM, week: WEEK, tasks: TEAMTASKS, live: _live }, _esc);
  }

  /* Team requirement board and assignment. */
  const _STMAP = { todo: '待办', doing: '进行中', done: '已完成', cancel: '搁置' };
  /* Compact title-and-metadata cards open task action dialogs. */
  /*
   * Hide repeated assignee labels in member groups; retain them in status groups where cards
   * provide the owner identity.
   */
  function _ttCard(t, hideAssignee) {
    const prio = (t.priority && t.priority !== 'normal')
      ? `<span class="tt-prio tt-prio-${t.priority}">${_PRIO[t.priority] || ''}</span>` : '';
    const due = t.due ? `<span class="tt-due">截 ${_fmtD(t.due)}</span>` : '';
    const nm = _esc(t.assigneeName || '');
    const st = `<span class="tt-cst st-${t.status}">${_STMAP[t.status] || t.status || ''}</span>`;
    const who = hideAssignee ? '' :
      `<span class="tt-ava" style="background:${t.assigneeColor || '#7c6cf0'}">${nm[0] || '?'}</span>` +
      `<span class="tt-aname">${nm}</span>`;
    return `<div class="tt-card st-${t.status}" data-tid="${_esc(t.id)}">
      <div class="tt-ctitle">${_esc(t.title)}</div>
      <div class="tt-crow">${prio}${due}${who}${st}</div></div>`;
  }
  function _ttActions(t) {
    const btns = _KCOLS.map(([s, l]) =>
      `<button class="tt-sbtn${t.status === s ? ' on' : ''}" data-status="${s}" data-tid="${_esc(t.id)}">${l}</button>`).join('');
    const opts = (TEAMMEMBERS || []).filter((m) => m.hasBox).map((m) =>
      `<option value="${_esc(m.userId)}"${m.userId === t.assigneeUserId ? ' selected' : ''}>${_esc(m.name)}</option>`).join('');
    const reassign = opts
      ? `<div class="tt-reassign"><span>改派给</span><select class="tt-rsel" data-tid="${_esc(t.id)}">${opts}</select></div>` : '';
    return `<div class="tt-actions"><div class="tt-alabel">改状态（含代验收）</div><div class="tt-sbtns">${btns}</div>${reassign}</div>`;
  }
  function _ttForm() {
    const withBox = TEAMMEMBERS.filter((m) => m.hasBox);
    const chips = withBox.length
      ? withBox.map((m) => `<span class="tt-mchip" data-uid="${_esc(m.userId)}"><span class="tt-mava" style="background:${m.color || '#7c6cf0'}">${_esc((m.name || '?')[0])}</span>${_esc(m.name)}</span>`).join('')
      : '<span class="tt-mempty">无可派成员（成员需先绑定 SoduWork）</span>';
    /* Compact assignment form: description, recipients, task details, and actions. */
    return `<div class="tt-form">
      <input id="ttTitle" placeholder="需求标题" maxlength="40">
      <textarea id="ttNote" placeholder="备注 / 描述（可选）" rows="2" maxlength="500"></textarea>
      <div class="tt-mlabel">指派给（可多选）${withBox.length > 1 ? '<a class="tt-mall" id="ttSelAll">全选</a>' : ''}</div>
      <div class="tt-mlist" id="ttAssignees">${chips}</div>
      <label class="tt-toinbox"><input type="checkbox" id="ttToInbox"${_ttToInbox ? ' checked' : ''}>或放进团队收件箱（不指定人，谁有空谁认领）</label>
      <div class="tt-frow tt-frow3">
        <select id="ttPrio" title="优先级"><option value="normal">普通</option><option value="low">低</option><option value="high">高</option><option value="critical">紧急</option></select>
        <input type="date" id="ttStart" title="开始时间（排期起点）">
        <input type="date" id="ttDue" title="截止时间"></div>
      <input id="ttTags" placeholder="标签,逗号分隔" maxlength="40">
      <select id="ttProject" title="归属项目">${_projectOptions('')}</select>
      <div class="tt-foot">
        <span class="tt-err" id="ttErr"></span>
        <button class="tt-cancel" id="ttCancel">取消</button><button class="tt-send" id="ttSend">派发</button>
      </div>
    </div>`;
  }
  /* Plugin workflows own multistep execution through requirement details and human review; the legacy transit section is retired. */
  function _taskKanban() {
    const normal = TEAMTASKS;
    const cnt = { todo: 0, doing: 0, done: 0, cancel: 0 };
    normal.forEach((t) => { cnt[t.status] = (cnt[t.status] || 0) + 1; });
    const openN = cnt.todo + cnt.doing;
    /*
     * Render toolbar controls above the filtered and grouped requirement content.
     */
    const FILTERS = [['open', '未完成', openN], ['all', '全部', normal.length], ['done', '已完成', cnt.done]];
    let h = '<div class="tt-toolbar">' +
      '<div class="tt-topbar"><div class="tt-filters">' +
      FILTERS.map(([k, l, n]) => `<span class="tt-fpill${_ttFilter === k ? ' on' : ''}" data-tf="${k}">${l} <b>${n}</b></span>`).join('') +
      '</div><div class="tt-topright">' +
      `<div class="tt-group-toggle" id="ttGroupToggle"><button class="tt-gt-btn${_ttGroupBy === 'member' ? ' on' : ''}" data-gb="member">按人员</button><button class="tt-gt-btn${_ttGroupBy === 'status' ? ' on' : ''}" data-gb="status">按状态</button><button class="tt-gt-btn${_ttGroupBy === 'gantt' ? ' on' : ''}" data-gb="gantt">甘特</button></div>` +
      `<button class="tt-icon-btn" id="ttFilterBtn" title="筛选搜索">\u2313</button>` +
      '<button class="tt-add-btn" id="ttAddBtn">' + (_ttFormOpen ? '收起' : '+ 派需求') + '</button></div></div>';
    // Collapsed filter row toggled by the search action.
    if (_ttFilterOpen) {
      h += '<div class="tt-filter-row"><input class="tt-search" id="ttSearch" placeholder="搜需求标题…" value="' + _esc(_ttSearch) + '">';
      const membersWithBox = TEAMMEMBERS.filter((m) => m.hasBox);
      if (membersWithBox.length > 1) {
        h += '<select class="tt-msel" id="ttMemberSel"><option value="">全部成员</option>' +
          membersWithBox.map((m) => `<option value="${_esc(m.userId)}"${_ttMember === m.userId ? ' selected' : ''}>${_esc(m.name)}</option>`).join('') + '</select>';
      }
      h += '</div>';
    }
    h += '</div>';
    if (_ttFormOpen) {} // Open assignment in a dialog rather than expanding the list.
    /*
     * Gantt rows represent owners and include workflow tasks. Use the chart's search input
     * with shared member and status filters.
     */
    if (_ttGroupBy === 'gantt' && typeof GanttView !== 'undefined') {
      if (_gvY == null) { const d = new Date(); _gvY = d.getFullYear(); _gvM = d.getMonth(); }
      const passSt = (t) => _ttFilter === 'done' ? t.status === 'done'
        : _ttFilter === 'open' ? (t.status === 'todo' || t.status === 'doing') : true;
      const gl = normal.filter((t) => passSt(t) && (!_ttMember || t.assigneeUserId === _ttMember));
      const byA = new Map();
      gl.forEach((t) => {
        const k = t.assigneeUserId || '_';
        if (!byA.has(k)) byA.set(k, { label: t.assigneeName || '未分配', sub: '', tasks: [] });
        byA.get(k).tasks.push(t);
      });
      h += GanttView.html([...byA.values()], {
        year: _gvY, month: _gvM, query: _ttSearch, onlyOverdue: _gvOd,
        labelHead: '负责人', clickAttr: 'data-gvtid',
      });
      return h;
    }
    // Apply filters.
    const q = _ttSearch.trim().toLowerCase();
    let list = normal.filter((t) => {
      if (_ttFilter === 'open') { if (t.status !== 'todo' && t.status !== 'doing') return false; }
      else if (_ttFilter === 'done') { if (t.status !== 'done') return false; }
      if (_ttMember && t.assigneeUserId !== _ttMember) return false;
      if (q && !(t.title || '').toLowerCase().includes(q)) return false;
      return true;
    });
    /*
     * Limit rendered completed history to the latest 30 entries while retaining the full count
     * in filter badges.
     */
    const DONE_CAP = 30;
    let doneDropped = 0;
    const doneList = list.filter((t) => t.status === 'done');
    if (doneList.length > DONE_CAP) {
      const keep = new Set(doneList.slice().sort((a, b) => (b.createdAt || b.due || 0) - (a.createdAt || a.due || 0)).slice(0, DONE_CAP).map((t) => t.id));
      doneDropped = doneList.length - DONE_CAP;
      list = list.filter((t) => t.status !== 'done' || keep.has(t.id));
    }
    h += '<div class="tt-groups">';
    if (_ttGroupBy === 'member') {
      // Group by member, ordering tasks as doing, todo, done, then cancel.
      const memberMap = {};   // assigneeUserId → {name, color, tasks}
      list.forEach((t) => {
        const uid = t.assigneeUserId || '_unassigned';
        const nm = t.assigneeName || '未分配';
        if (!memberMap[uid]) memberMap[uid] = { name: nm, color: t.assigneeColor || '#7c6cf0', tasks: [] };
        memberMap[uid].tasks.push(t);
      });
      const ord = { doing: 0, todo: 1, done: 2, cancel: 3 };
      const members = Object.entries(memberMap).sort((a, b) => {
        // Sort by descending unfinished-task count.
        const aOpen = a[1].tasks.filter(t => t.status === 'doing' || t.status === 'todo').length;
        const bOpen = b[1].tasks.filter(t => t.status === 'doing' || t.status === 'todo').length;
        return bOpen - aOpen;
      });
      let groupRendered = 0;
      members.forEach(([uid, info]) => {
        const items = info.tasks.sort((a, b) => (ord[a.status] - ord[b.status]) || ((b.due || 0) - (a.due || 0)));
        if (!items.length) return;
        groupRendered++;
        const openN = items.filter(t => t.status === 'doing' || t.status === 'todo').length;
        h += `<div class="tt-group tt-group-member">` +
          `<div class="tt-group-head">` +
          `<span class="tt-group-ava" style="background:${info.color}">${_esc(info.name[0] || '?')}</span>` +
          `<span class="tt-group-name">${_esc(info.name)}</span>` +
          `<b>${items.length} 个需求${openN ? ' · ' + openN + ' 未完成' : ''}</b>` +
          `</div>` +
          /*
           * Wrap _ttCard calls so Array.map's index is not mistaken for hideAssignee.
           */
          `<div class="tt-list">${items.map((t) => _ttCard(t, true)).join('')}</div></div>`;
      });
      if (!groupRendered) h += '<div class="tt-empty">没有符合条件的需求</div>';
    } else {
      // Group by status.
      const groups = [
        ['doing', '进行中', cnt.doing, '--s-doing'],
        ['todo', '待办', cnt.todo, '--s-todo'],
        ['done', '已完成', cnt.done, '--s-done'],
        ['cancel', '搁置', cnt.cancel, '--s-cancel'],
      ].filter(([s]) => _ttFilter === 'all' || (_ttFilter === 'open' ? (s === 'doing' || s === 'todo') : s === _ttFilter));
      let groupRendered = 0;
      groups.forEach(([status, label, count, color]) => {
        const items = list.filter((t) => t.status === status)
          .sort((a, b) => (b.due || 0) - (a.due || 0));
        if (!items.length) return;
        groupRendered++;
        h += `<div class="tt-group">` +
          `<div class="tt-group-head"><span class="tt-group-dot" style="background:var(${color})"></span>${label}<b>${items.length}</b></div>` +
          /* Retain assignees in status groups and avoid passing map's index as hideAssignee. */
          `<div class="tt-list">${items.map((t) => _ttCard(t)).join('')}</div></div>`;
      });
      if (!groupRendered) h += '<div class="tt-empty">没有符合条件的需求</div>';
    }
    if (doneDropped > 0) h += `<div class="tt-donecap">已完成需求只显示最近 ${DONE_CAP} 条 · 更早的 ${doneDropped} 条可在管理端「需求中枢」查全量</div>`;
    h += '</div>';
    return h;
  }
  /*
   * Navigate from overview indicators with status and owner filters. Prefer member uid; use
   * title search only for legacy records without an ID.
   */
  function _jumpToTasks(filter, member) {
    _tab = 0; _tabManual = true;
    _ttFilter = filter || 'open';
    if (member && member.uid) { _ttMember = member.uid; _ttSearch = ''; _ttFilterOpen = true; }
    else if (member && member.name) { _ttMember = ''; _ttSearch = member.name; _ttFilterOpen = true; }
    else { _ttMember = ''; _ttSearch = ''; }
    _ttActive = null;
    _syncTabs(); renderTeamBody();
  }
  function _bindBoard() {
    window.SoduWorkTeamOverview.bind(document.getElementById('teamBody'), {
      reload: _fetchData, navigate: _jumpToTasks,
    });
  }
  /* Open task assignment in a dialog without expanding the list. */
  function _openDispatchModal() {
    const old = document.getElementById('ttModalMask'); if (old) old.remove();
    const panel = document.getElementById('teamPanel'); if (!panel) return;
    panel.insertAdjacentHTML('beforeend',
      `<div class="tt-modal-mask" id="ttModalMask"><div class="tt-modal tt-modal-dispatch" onclick="event.stopPropagation()">
        <div class="tt-modal-head"><span class="tt-modal-stripe" style="background:var(--accent)"></span>
        <div class="tt-modal-title">派需求</div>
        <button class="tt-modal-close" id="ttModalClose">\u2715</button></div>
        <div class="tt-modal-body">${_ttForm()}</div>
      </div></div>`);
    const mask = document.getElementById('ttModalMask');
    const close = document.getElementById('ttModalClose');
    if (mask) mask.addEventListener('click', () => { _ttFormOpen = false; mask.remove(); });
    if (close) close.addEventListener('click', () => { _ttFormOpen = false; mask.remove(); });
    _bindDispatchForm();
  }
  function _bindDispatchForm() {
    const cancel = document.getElementById('ttCancel');
    if (cancel) cancel.addEventListener('click', () => {
      _ttFormOpen = false;
      const mask = document.getElementById('ttModalMask'); if (mask) mask.remove();
      renderTeamBody();
    });
    const send = document.getElementById('ttSend');
    if (send) send.addEventListener('click', _ttSubmit);
    const inboxCk = document.getElementById('ttToInbox');
    const _applyInboxMode = () => {
      const form = inboxCk && inboxCk.closest('.tt-form');
      if (!form) return;
      form.classList.toggle('tt-inbox-mode', inboxCk.checked);
      if (inboxCk.checked) {
        form.querySelectorAll('#ttAssignees .tt-mchip.on').forEach((c) => c.classList.remove('on'));
      }
    };
    if (inboxCk) { inboxCk.addEventListener('change', () => { _ttToInbox = inboxCk.checked; _applyInboxMode(); }); _applyInboxMode(); }
    document.querySelectorAll('#ttModalMask .tt-mchip').forEach((c) =>
      c.addEventListener('click', () => c.classList.toggle('on')));
    const selAll = document.getElementById('ttSelAll');
    if (selAll) selAll.addEventListener('click', () => {
      const chips = [...document.querySelectorAll('#ttModalMask .tt-mchip')];
      const allOn = chips.every((c) => c.classList.contains('on'));
      chips.forEach((c) => c.classList.toggle('on', !allOn));
      selAll.textContent = allOn ? '全选' : '清空';
    });
  }
  /* Open task actions in a dialog to keep list layout stable. */
  function _taskModal(t) {
    if (!t) return '';
    const stMap = { todo: '待办', doing: '进行中', done: '已完成', cancel: '搁置' };
    const prioTxt = _PRIO[t.priority] || '普通';
    const dueTxt = (t.start && t.due) ? (_fmtD(t.start) + ' → ' + _fmtD(t.due))
      : t.due ? _fmtD(t.due) : t.start ? (_fmtD(t.start) + ' 起') : '无';
    const tagsTxt = (t.tags && t.tags.length) ? t.tags.join(', ') : '无';
    const headColor = t.status === 'doing' ? 'var(--s-doing)' : t.status === 'todo' ? 'var(--s-todo)' : t.status === 'done' ? 'var(--s-done)' : 'var(--s-cancel)';
    const body = _ttActions(t) || '';
    return `<div class="tt-modal-mask" id="ttModalMask">
      <div class="tt-modal" onclick="event.stopPropagation()">
        <div class="tt-modal-head">
          <span class="tt-modal-stripe" style="background:${headColor}"></span>
          <div class="tt-modal-title">${_esc(t.title)}</div>
          <button class="tt-modal-close" id="ttModalClose">\u2715</button>
        </div>
        <div class="tt-modal-meta">
          <span>状态 <b style="color:${headColor}">${_esc(stMap[t.status] || t.status)}</b></span>
          <span>负责人 <b>${_esc(t.assigneeName || '未分配')}</b></span>
          <span>优先级 <b>${_esc(prioTxt)}</b></span>
          <span>${t.start ? '排期' : '截止'} <b>${_esc(dueTxt)}</b></span>
          <span>标签 <b>${_esc(tagsTxt)}</b></span>
        </div>
        ${t.note ? `<div class="tt-modal-note">${_esc(t.note)}</div>` : ''}
        ${_ttModalInfo(t)}
        <div class="tt-modal-body">${body}</div>
        ${t.status !== 'done' ? `<div class="tt-modal-nudge">
          <input id="ttNudgeNote" maxlength="120" placeholder="捎句话（可选），如：今天下班前要">
          <button id="ttNudgeBtn" data-tid="${_esc(t.id)}">⏰ 催办</button>
        </div>` : ''}
      </div>
    </div>`;
  }
  /* Show source and creation metadata followed by up to five recent progress entries, newest first. */
  function _ttModalInfo(t) {
    const bits = [];
    // Identify member-created requirements explicitly rather than using an ambiguous self label.
    if (t.source) bits.push(t.source === '自己' ? '成员自建' : '来自 ' + _esc(t.source));
    if (t.createdByName) bits.push('创建 · ' + _esc(t.createdByName));
    if (t.createdAt) bits.push(_fmtD(t.createdAt));
    let h = bits.length ? `<div class="tt-modal-src">${bits.join('　·　')}</div>` : '';
    const prog = Array.isArray(t.progress) ? t.progress.filter((p) => p && (p.text || typeof p === 'string')) : [];
    if (prog.length) {
      h += '<div class="tt-modal-prog"><div class="tt-mp-label">最近进展</div>' + prog.map((p) => {
        const txt = typeof p === 'string' ? p : (p.text || '');
        const at = (p && p.at) ? _fmtD(p.at) : '';
        const by = (p && (p.byName || p.by)) ? _esc(p.byName || p.by) : '';
        return `<div class="tt-mp-row"><span class="tt-mp-at">${at}</span><span class="tt-mp-txt">${_esc(txt)}</span>${by ? `<span class="tt-mp-by">${by}</span>` : ''}</div>`;
      }).join('') + '</div>';
    }
    return h;
  }
  function _openTaskModal(tid) {
    const t = TEAMTASKS.find((x) => x.id === tid);
    if (!t) return;
    _ttActive = tid;
    // Remove the previous dialog.
    const old = document.getElementById('ttModalMask');
    if (old) old.remove();
    // Mount the dialog inside teamPanel.
    const panel = document.getElementById('teamPanel');
    if (!panel) return;
    panel.insertAdjacentHTML('beforeend', _taskModal(t));
    // Bind dismissal.
    const mask = document.getElementById('ttModalMask');
    const close = document.getElementById('ttModalClose');
    if (mask) mask.addEventListener('click', () => { _ttActive = null; mask.remove(); });
    if (close) close.addEventListener('click', () => { _ttActive = null; mask.remove(); });
    // Reuse board action bindings inside the dialog.
    _bindModalActions();
    // Send a reminder with optional feedback; the recipient receives pet notification feedback.
    const nb = document.getElementById('ttNudgeBtn');
    if (nb) nb.addEventListener('click', async () => {
      const note = (document.getElementById('ttNudgeNote') || {}).value || '';
      nb.disabled = true; nb.textContent = '催办中…';
      try {
        const r = await SoduWorkAPI.nudgeTeamTask(nb.getAttribute('data-tid'), note.trim());
        if (typeof petSay === 'function') petSay(r && r.delivered ? '已催办，对方的 SoduWork 收到提醒了~' : '已催办（对方离线，暂收不到）');
        const m = document.getElementById('ttModalMask'); if (m) { _ttActive = null; m.remove(); }
      } catch (e) {
        if (typeof petSay === 'function') petSay('催办没成：' + (e.message || e));
        nb.disabled = false; nb.textContent = '⏰ 催办';
      }
    });
  }
  function _bindModalActions() {
    // Status actions.
    document.querySelectorAll('#ttModalMask [data-status]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tid = b.getAttribute('data-tid'), st = b.getAttribute('data-status');
      try {
        await SoduWorkAPI.setTeamTaskStatus(tid, st);
        const tt = await SoduWorkAPI.getTeamTasks();
        if (tt) { TEAMTASKS = tt.tasks || []; TEAMMEMBERS = tt.members || []; }
        _ttActive = null;
        const mask = document.getElementById('ttModalMask'); if (mask) mask.remove();
        renderTeamBody();
        if (typeof petSay === 'function') petSay('已更新状态~');
      } catch (err) { if (typeof petSay === 'function') petSay(_humanErr(err)); }
    }));
    // Reassignment selector.
    document.querySelectorAll('#ttModalMask .tt-rsel').forEach((sel) => sel.addEventListener('change', async (e) => {
      e.stopPropagation();
      const tid = sel.getAttribute('data-tid'), uid = sel.value;
      if (!uid) return;
      try {
        await SoduWorkAPI.reassignTeamTask(tid, uid);
        const tt = await SoduWorkAPI.getTeamTasks();
        if (tt) { TEAMTASKS = tt.tasks || []; TEAMMEMBERS = tt.members || []; }
        _ttActive = null;
        const mask = document.getElementById('ttModalMask'); if (mask) mask.remove();
        renderTeamBody();
        if (typeof petSay === 'function') petSay('已改派~');
      } catch (err) { if (typeof petSay === 'function') petSay(_humanErr(err, '改派没成功')); }
    }));
  }
  function _bindKanban() {
    const add = document.getElementById('ttAddBtn');
    if (add) add.addEventListener('click', () => { _ttFormOpen = true; _openDispatchModal(); });
    // Toggle filter and search controls.
    const fbtn = document.getElementById('ttFilterBtn');
    if (fbtn) fbtn.addEventListener('click', () => { _ttFilterOpen = !_ttFilterOpen; renderTeamBody(); });
    // Switch grouping mode.
    document.querySelectorAll('#teamBody [data-gb]').forEach((b) => b.addEventListener('click', () => {
      _ttGroupBy = b.getAttribute('data-gb'); _ttActive = null; renderTeamBody();
    }));
    // Rerender for status and member filters; hide nonmatching cards in place during search to preserve focus.
    document.querySelectorAll('#teamBody [data-tf]').forEach((p) => p.addEventListener('click', () => {
      _ttFilter = p.getAttribute('data-tf'); _ttActive = null; renderTeamBody();
    }));
    const msel = document.getElementById('ttMemberSel');
    if (msel) msel.addEventListener('change', () => { _ttMember = msel.value; _ttActive = null; renderTeamBody(); });
    const search = document.getElementById('ttSearch');
    if (search) search.addEventListener('input', () => {
      _ttSearch = search.value;
      const qq = _ttSearch.trim().toLowerCase();
      document.querySelectorAll('#teamBody .tt-list .tt-card').forEach((c) => {
        const title = (c.querySelector('.tt-ctitle') || {}).textContent || '';
        c.style.display = (!qq || title.toLowerCase().includes(qq)) ? '' : 'none';
      });
    });
    // Gantt controls handle month navigation, overdue filtering, search on change, and task opening without per-keystroke rerenders.
    document.querySelectorAll('#teamBody [data-gvnav]').forEach((b) => b.addEventListener('click', () => {
      _gvM += parseInt(b.getAttribute('data-gvnav'), 10);
      if (_gvM < 0) { _gvM = 11; _gvY--; } if (_gvM > 11) { _gvM = 0; _gvY++; }
      renderTeamBody();
    }));
    const gvod = document.querySelector('#teamBody [data-gvod]');
    if (gvod) gvod.addEventListener('change', () => { _gvOd = gvod.checked; renderTeamBody(); });
    const gvq = document.querySelector('#teamBody [data-gvq]');
    if (gvq) gvq.addEventListener('change', () => { _ttSearch = gvq.value; renderTeamBody(); });
    document.querySelectorAll('#teamBody [data-gvtid]').forEach((el) => el.addEventListener('click', () => {
      _openTaskModal(el.getAttribute('data-gvtid'));
    }));
    const cancel = document.getElementById('ttCancel');
    if (cancel) cancel.addEventListener('click', () => { _ttFormOpen = false; renderTeamBody(); });
    const send = document.getElementById('ttSend');
    if (send) send.addEventListener('click', _ttSubmit);
    // Disable member selection in inbox mode so selected recipients cannot be silently discarded.
    const inboxCk = document.getElementById('ttToInbox');
    const _applyInboxMode = () => {
      const form = inboxCk && inboxCk.closest('.tt-form');
      if (!form) return;
      form.classList.toggle('tt-inbox-mode', inboxCk.checked);
      if (inboxCk.checked) {
        form.querySelectorAll('#ttAssignees .tt-mchip.on').forEach((c) => c.classList.remove('on'));
      }
    };
    if (inboxCk) { inboxCk.addEventListener('change', () => { _ttToInbox = inboxCk.checked; _applyInboxMode(); }); _applyInboxMode(); }
    // Toggle individual recipient chips or all recipients.
    document.querySelectorAll('#ttAssignees .tt-mchip').forEach((c) =>
      c.addEventListener('click', () => c.classList.toggle('on')));
    const selAll = document.getElementById('ttSelAll');
    if (selAll) selAll.addEventListener('click', () => {
      const chips = [...document.querySelectorAll('#ttAssignees .tt-mchip')];
      const allOn = chips.every((c) => c.classList.contains('on'));
      chips.forEach((c) => c.classList.toggle('on', !allOn));
      selAll.textContent = allOn ? '全选' : '清空';
    });
    /* Open card actions in a dialog rather than inline. */
    document.querySelectorAll('#teamBody .tt-card').forEach((c) => c.addEventListener('click', () => {
      _openTaskModal(c.getAttribute('data-tid'));
    }));
    /* Status actions are hosted in the dialog rather than the list. */
  }
  function _ttErr(msg) { const e = document.getElementById('ttErr'); if (e) e.textContent = msg || ''; }
  async function _ttSubmit() {
    const title = (document.getElementById('ttTitle').value || '').trim();
    const toInbox = !!(document.getElementById('ttToInbox') || {}).checked;
    const assigneeUserIds = [...document.querySelectorAll('#ttAssignees .tt-mchip.on')].map((c) => c.getAttribute('data-uid'));
    if (!title) { _ttErr('请填需求标题'); return; }
    if (!toInbox && !assigneeUserIds.length) { _ttErr('请选择指派成员，或勾选「放进团队收件箱」'); return; }
    const priority = (document.getElementById('ttPrio') || {}).value || 'normal';
    const projectId = (document.getElementById('ttProject') || {}).value || '';
    const startV = (document.getElementById('ttStart') || {}).value || '';
    let start = startV ? new Date(startV + 'T00:00:00').getTime() : null;
    const dueV = (document.getElementById('ttDue') || {}).value || '';
    const due = dueV ? new Date(dueV + 'T00:00:00').getTime() : null;
    if (start && due && start > due) { _ttErr('开始时间不能晚于截止时间'); return; }
    const tagsRaw = (document.getElementById('ttTags').value || '').trim();
    const tags = tagsRaw ? tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
    const note = (document.getElementById('ttNote') || {}).value || '';
    _ttErr('派发中…');
    try {
      if (toInbox) {
        await SoduWorkAPI.createTeamTask({ toInbox: true, title, note, priority, start, due, tags, projectId });
        _ttFormOpen = false; _ttToInbox = false;
        const mask = document.getElementById('ttModalMask'); if (mask) mask.remove();
        await _fetchInbox();
        renderTeamBody();
        if (typeof petSay === 'function') petSay('已放进团队收件箱「' + title + '」，等成员认领~');
        return;
      }
      const r = await SoduWorkAPI.createTeamTask({ title, note, assigneeUserIds, priority, start, due, tags, projectId });
      _ttFormOpen = false;
      const mask2 = document.getElementById('ttModalMask'); if (mask2) mask2.remove();
      const tt = await SoduWorkAPI.getTeamTasks();
      if (tt) { TEAMTASKS = tt.tasks || []; TEAMMEMBERS = tt.members || []; }
      renderTeamBody();
      const n = (r && r.assignees) || assigneeUserIds.length;
      if (typeof petSay === 'function') petSay('已派发「' + title + '」给 ' + n + ' 人，办结会自动回执给你~');
    } catch (e) { _ttErr(_humanErr(e)); }
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* Rendering and visibility. */
  /* Team inbox for unclaimed requirements. */
  function _ibCard(t) {
    const prio = (t.priority && t.priority !== 'normal')
      ? `<span class="tt-prio tt-prio-${t.priority}">${_PRIO[t.priority] || ''}</span>` : '';
    const dom = t.domainName ? `<span class="ib-dom">${_esc(t.domainName)}</span>` : '';
    const flags = (t.urgent ? '<span class="ib-flag urg">紧急</span>' : '') + (t.important ? '<span class="ib-flag imp">重要</span>' : '');
    const due = t.due ? `<span class="tt-due">截 ${_fmtD(t.due)}</span>` : '';
    const from = (t.createdByName || t.teamName)
      ? `<div class="ib-from">来自 ${_esc(t.createdByName || '')}${t.teamName ? ' · ' + _esc(t.teamName) : ''}</div>` : '';
    /* Leaders can assign directly to eligible client users from the team directory. */
    const assignables = _canManage ? TEAMMEMBERS.filter((m) => m.hasBox !== false) : [];
    const assign = (_canManage && assignables.length && !t.repositoryIssue)
      ? `<select class="ib-assign-sel" data-assign="${_esc(t.id)}"><option value="">分配给…</option>` +
        assignables.map((m) => `<option value="${_esc(m.userId || m.id)}">${_esc(m.name)}</option>`).join('') + '</select>'
      : '';
    return `<div class="ib-card" data-tid="${_esc(t.id)}">
      <div class="ib-top"><div class="ib-title">${_esc(t.title)}</div>${prio}</div>
      <div class="ib-meta">${dom}${flags}${due}<span class="ib-wait">已等 ${_esc(t.waiting || '')}</span></div>
      ${from}
      <div class="ib-act">${assign}<button class="ib-claim" data-claim="${_esc(t.id)}">认领</button></div>
    </div>`;
  }
  function _inbox() {
    let h = '<div class="tp-inbox-hint">待认领的需求，谁有空谁「认领」→ 落到你桌宠。拿错了在需求详情可「退回收件箱」。</div>';
    h += '<div class="tp-inbox-err" id="ibErr"></div>';
    if (!INBOX.length) {
      /* Use a centered illustrated empty state. */
      return h + '<div class="ib-empty">' +
        '<svg viewBox="0 0 24 24"><path d="M4 13h4l1.4 2.6h5.2L16 13h4"/><path d="M6.2 5h11.6l2.2 8v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4z"/></svg>' +
        '<b>收件箱空空的</b><span>派给团队（不指定人）的需求会出现在这里，谁有空谁认领</span></div>';
    }
    if (INBOX.length > 6) h += '<div class="tt-toolrow"><input class="tt-search" id="ibSearch" placeholder="搜待认领需求…"></div>';
    // Group inbox requirements into separate department pools.
    const groups = {}, order = [];
    INBOX.forEach((t) => { const k = t.teamId || '_'; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(t); });
    h += order.map((k) => {
      const items = groups[k];
      const name = _esc(items[0].teamName || '本团队');
      return `<div class="ib-pool"><div class="ib-pool-head"><span class="ib-pool-name">${name}</span><span class="ib-pool-n">${items.length}</span></div>
        <div class="ib-list">${items.map(_ibCard).join('')}</div></div>`;
    }).join('');
    return h;
  }
  function _bindInbox() {
    const ibs = document.getElementById('ibSearch');
    if (ibs) ibs.addEventListener('input', () => {
      const q = ibs.value.trim().toLowerCase();
      document.querySelectorAll('#teamBody .ib-pool').forEach((pool) => {
        let vis = 0;
        pool.querySelectorAll('.ib-card').forEach((c) => {
          const t = (c.querySelector('.ib-title') || {}).textContent || '';
          const ok = !q || t.toLowerCase().includes(q);
          c.style.display = ok ? '' : 'none'; if (ok) vis++;
        });
        pool.style.display = vis ? '' : 'none';   // Hide pools with no matching items.
      });
    });
    /* Assign immediately when a leader selects a recipient; successful items leave the pool and reach the recipient's client. */
    document.querySelectorAll('#teamBody [data-assign]').forEach((sel) => sel.addEventListener('change', async (e) => {
      e.stopPropagation();
      const tid = sel.getAttribute('data-assign');
      const uid = sel.value;
      if (!uid) return;
      const who = (sel.options[sel.selectedIndex] || {}).textContent || '成员';
      sel.disabled = true;
      try {
        await SoduWorkAPI.assignInboxTask(tid, uid);
        INBOX = INBOX.filter((x) => x.id !== tid);
        _updateInboxBadges();
        renderTeamBody();
        if (typeof petSay === 'function') petSay('已把这条需求分给 ' + who + ' ~');
      } catch (err) {
        const e2 = document.getElementById('ibErr');
        if (e2) e2.textContent = (err && err.message) || '分配失败';
        sel.disabled = false; sel.value = '';
        await _fetchInbox(); renderTeamBody();
      }
    }));
    document.querySelectorAll('#teamBody [data-claim]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tid = b.getAttribute('data-claim');
      b.disabled = true; b.textContent = '认领中…';
      try {
        await SoduWorkAPI.claimInboxTask(tid);       // The backend sends task.created over WebSocket after success.
        INBOX = INBOX.filter((x) => x.id !== tid);
        _updateInboxBadges();
        renderTeamBody();
      } catch (err) {
        const e2 = document.getElementById('ibErr');
        if (e2) e2.textContent = (err && err.message) || '认领失败';
        await _fetchInbox();                        // Refresh to remove items already claimed by someone else.
        renderTeamBody();
      }
    }));
  }
  function _updateInboxBadges() {
    const n = INBOX.length;
    const tb = document.getElementById('inboxTabBadge');
    if (tb) tb.textContent = n > 0 ? (n > 99 ? '99+' : n) : '';
    // Refresh the dock's team badge.
    try {
      if (window.setTeamCap && window.__teamCap) { window.__teamCap.inboxCount = n; window.setTeamCap(window.__teamCap); }
      /*
       * Request a capability and badge refresh in the desktop window, which owns the dock; the
       * workspace does not expose setTeamCap.
       */
      if (window.WinSync) WinSync.pushTeamCap();
    } catch (e) {}
  }
  async function _fetchInbox() {
    let r = null;
    try { if (window.SoduWorkAPI && SoduWorkAPI.getTeamInbox) r = await SoduWorkAPI.getTeamInbox(); } catch (e) {}
    if (r && Array.isArray(r.items)) { INBOX = r.items; _updateInboxBadges(); }
  }

  /* Projects available during requirement assignment. */
  let PROJECTS = [];
  function _projectOptions(sel) {
    if (!PROJECTS.length) return '<option value="">（暂无项目，可先在管理端创建）</option>';
    return '<option value="">不归属项目</option>' + PROJECTS.map((p) =>
      `<option value="${_esc(p.id)}"${p.id === sel ? ' selected' : ''}>${_esc(p.name)}</option>`).join('');
  }
  async function _fetchProjects() {
    try {
      if (window.SoduWorkAPI && SoduWorkAPI.getProjects) PROJECTS = (await SoduWorkAPI.getProjects()) || [];
    } catch (e) { PROJECTS = []; }
  }

  function _syncTabs() {
    document.querySelectorAll('#teamTabs button').forEach((b) => b.classList.toggle('active', +b.getAttribute('data-tab') === _tab));
    // Inbox is a single-tab page; tp-solo hides its tab bar.
    // Team entry exposes management tabs only when canManage permits them.
    const m = _meta();
    document.querySelectorAll('#teamTabs [data-tab]').forEach((b) => {
      const tb = +b.getAttribute('data-tab');
      const mine = m.solo ? (tb === m.tab) : ([0, 1].includes(tb) && _canManage);
      b.style.display = mine ? '' : 'none';
    });
  }
  function renderTeamBody() {
    const body = document.getElementById('teamBody');
    if (!body) return;
    body.innerHTML = _tab === 4 ? _inbox() : _tab === 0 ? _taskKanban() : _board();
    body.scrollTop = 0;
    if (_tab === 0) _bindKanban();
    else if (_tab === 4) _bindInbox();
    else if (_tab === 1) _bindBoard();
  }
  async function _fetchData() {
    const seq = ++_reqSeq;
    let d = null, tt = null, ib = null;
    try {
      if (window.SoduWorkAPI) {
        [d, tt, ib] = await Promise.all([
          SoduWorkAPI.getTeam ? SoduWorkAPI.getTeam() : null,
          SoduWorkAPI.getTeamTasks ? SoduWorkAPI.getTeamTasks() : null,
          SoduWorkAPI.getTeamInbox ? SoduWorkAPI.getTeamInbox() : null,
        ]);
      }
    } catch (e) { /* Offline state. */ }
    if (seq !== _reqSeq) return;                 // Discard results superseded by a later open request.
    if (d) applyData(d); else useUnavailable('团队数据暂时不可用 · 请检查连接');
    _fetchedOnce = true;
    if (tt) { TEAMTASKS = tt.tasks || []; TEAMMEMBERS = tt.members || []; }
    if (ib && Array.isArray(ib.items)) INBOX = ib.items;
    // Choose the default tab from authoritative canManage; keep inbox as a single-page entry.
    if (!_tabManual) _tab = _meta().tab;
    _applySub(); _syncTabs(); _updateInboxBadges();
    const p = document.getElementById('teamPanel');
    if (p && p.classList.contains('show')) renderTeamBody();
  }
  function openTeamPanel(opts) {
    if (opts && (opts.entry === 'daily' || opts.tab === 5)) {
      closeTeamPanel();
      return window.openDailyPanel();
    }
    const p = document.getElementById('teamPanel');
    if (!p) return;
    /*
     * Switch content without expanding an already-open overlay. An extra overlayDepth
     * increment would leave mouse passthrough disabled after closing.
     */
    const wasOpen = p.classList.contains('show');
    // Inbox entry selects the standalone inbox identity.
    // Team entry selects the management overview and requirement tabs.
    _entry = (opts && opts.entry) || 'team';
    if (_entry === 'personal') _entry = 'inbox';   // Support legacy combined-entry callers.
    const m = _meta();
    const fixed = opts && typeof opts.tab === 'number';
    _tabManual = !!fixed || !!m.solo;              // Pin the single-page tab against asynchronous fetch updates.
    _tab = fixed ? opts.tab : m.tab;
    // Update the title and icon to match the selected entry.
    const tt = document.getElementById('tpTitleText');
    if (tt) tt.textContent = m.title;
    const ti = document.querySelector('#teamPanel .tp-title .ico');
    if (ti) ti.innerHTML = m.ico;
    // Hide the tab bar for single-page entries.
    p.classList.toggle('tp-solo', !!m.solo);
    _ttFormOpen = false; _ttActive = null; _ttToInbox = false;
    _fetchProjects();                       // Load projects for the assignment form.
    const oldMask = document.getElementById('ttModalMask'); if (oldMask) oldMask.remove();  // Remove stale dialogs.
    _syncTabs(); _applySub(); _updateInboxBadges(); renderTeamBody();

    // Dock the panel to the left of its parent; the user may explicitly expand it.
    p.classList.toggle('tp-entry-team', _entry === 'team');
    _setMax(false);
    p.classList.add('show');
    if (typeof placeDockPopup === 'function') placeDockPopup(p);
    if (!wasOpen && typeof expandForOverlay === 'function') expandForOverlay();
    _fetchData();                                          // Refresh from backend data.
  }
  function closeTeamPanel() {
    const p = document.getElementById('teamPanel');
    if (!p) return;
    const wasOpen = p.classList.contains('show');
    _reqSeq++;                                             // Invalidate in-flight requests.
    const mask = document.getElementById('ttModalMask'); if (mask) mask.remove();  // Remove dialogs.
    p.classList.remove('show');
    document.body.classList.remove('tp-max-open');   // Restore the dock when the panel closes.
    // Decrement overlay depth only when transitioning from open to closed.
    // Closing an already-closed panel must not consume another panel's overlay count.
    if (wasOpen && typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }

  /* Toggle maximized and normal panel sizes. */
  function _setMax(on) {
    const p = document.getElementById('teamPanel'); const b = document.getElementById('teamMax');
    if (!p) return;
    if (on) {
      // Clear dock positioning before maximizing to avoid conflicting inline offsets and transforms.
      p.classList.remove('pop-left');
      ['left', 'top', 'right', 'bottom'].forEach((k) => { p.style[k] = ''; });
    }
    p.classList.toggle('maximized', !!on);
    // Restore dock placement after leaving maximized mode.
    if (!on && p.classList.contains('show') && typeof placeDockPopup === 'function') placeDockPopup(p);
    // Move the dock aside while maximized and restore it on close.
    document.body.classList.toggle('tp-max-open', !!on);
    if (b) { b.textContent = on ? '⤡' : '⤢'; b.title = on ? '还原尺寸' : '最大化（开会/演示用）'; }
  }
  function _bind() {
    const c = document.getElementById('teamClose');
    if (c) c.addEventListener('click', closeTeamPanel);
    const mx = document.getElementById('teamMax');
    if (mx) mx.addEventListener('click', () => _setMax(!document.getElementById('teamPanel').classList.contains('maximized')));
    const tabs = document.getElementById('teamTabs');
    if (tabs) tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      _tabManual = true; _tab = +b.getAttribute('data-tab'); _syncTabs(); renderTeamBody();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        const p = document.getElementById('teamPanel');
        const page = document.documentElement.dataset.deskPanel;
        // Hosted pages and standalone main pages remain mounted; only desktop team overlays dismiss here.
        if (p && p.classList.contains('show') && !p.classList.contains('workspace-hosted') &&
            page !== 'team' && page !== 'inbox') closeTeamPanel();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _bind);
  else _bind();

  window.openTeamPanel = openTeamPanel;
  /* Keep inbox collaboration here and route legacy daily-report entry points to work briefs. */
  window.openInboxPanel = () => openTeamPanel({ entry: 'inbox' });
  window.openDailyPanel = () => {
    if (typeof openBriefsEntry === 'function') openBriefsEntry({ period: 'daily', scope: 'mine' });
    else if (typeof openBriefsPanel === 'function') openBriefsPanel({ period: 'daily', scope: 'mine' });
  };
  window.closeTeamPanel = closeTeamPanel;
})();
