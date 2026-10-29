/* Team overview presentation. The team panel owns data, navigation and request lifetimes. */
(function (global) {
  'use strict';

  function render({ members: TEAM, week: WEEK, tasks: TEAMTASKS, live: _live }, _esc) {
    const load = (m) => Math.max(0, Math.min(100, Math.round((m.doing + m.todo) / (m.cap || 1) * 100)));
    const sum = (f) => TEAM.reduce((a, m) => a + f(m), 0);
    if (!TEAM.length) {
      const title = _live ? '这里还没有团队成员' : '暂时没有拿到团队数据';
      const hint = _live
        ? '请让管理员在管理端完成组织与成员分配，配置完成后这里会显示真实负载和协作需求。'
        : '检查服务地址和登录状态后重试。SoduWork 不会用示例员工代替真实数据。';
      return '<div class="tp-truth-empty"><span aria-hidden="true">' + (_live ? '＋' : '!') + '</span>' +
        '<div><b>' + title + '</b><p>' + hint + '</p></div>' +
        '<button type="button" data-team-retry="1">重新加载</button></div>';
    }
    const doing = sum((m) => m.doing), todo = sum((m) => m.todo), done = sum((m) => m.done),
      stuck = sum((m) => m.stuck), cancel = sum((m) => m.cancel);
    const allT = doing + todo + done + cancel;
    const rate = allT ? Math.round(done / allT * 100) : 0;
    const avgLoad = TEAM.length ? Math.round(TEAM.reduce((a, m) => a + (m.doing + m.todo) / (m.cap || 1), 0) / TEAM.length * 100) : 0;
    let h = '';

    /* Risk banner. */
    const hot = TEAM.filter((m) => load(m) > 90);
    if (stuck > 0 || hot.length) {
      const bits = [];
      if (stuck > 0) bits.push(`<b>${stuck}</b> 个需求卡住`);
      if (hot.length) bits.push(`<b>${hot.length}</b> 人负载过高`);
      h += `<div class="tp-risk" data-jump="todo"><span class="tp-risk-ico">!</span><div>需要关注：${bits.join(' · ')}` +
        (hot.length ? `<div class="tp-risk-sub">${hot.map((m) => _esc(m.name)).join('、')} 快忙不过来了</div>` : '') + '</div></div>';
    }

    /* KPI cards for active, pending, completed, and completion-rate metrics. */
    h += `<div class="ov-kpis">`;
    h += `<div class="ov-kpi ov-kpi-doing" data-jump="doing">
      <div class="ov-kpi-icon" style="background:color-mix(in srgb,var(--s-doing) 14%,transparent);color:var(--s-doing)">◐</div>
      <div class="ov-kpi-body"><div class="ov-kpi-n" style="color:var(--s-doing)">${doing}</div><div class="ov-kpi-l">进行中</div>
      <div class="ov-kpi-sub">${stuck ? `<em>${stuck} 个卡住</em>` : '推进正常'}</div></div></div>`;
    h += `<div class="ov-kpi ov-kpi-todo" data-jump="todo">
      <div class="ov-kpi-icon" style="background:color-mix(in srgb,var(--s-todo) 14%,transparent);color:var(--s-todo)">○</div>
      <div class="ov-kpi-body"><div class="ov-kpi-n" style="color:var(--s-todo)">${todo}</div><div class="ov-kpi-l">待办</div>
      <div class="ov-kpi-sub">等待启动</div></div></div>`;
    h += `<div class="ov-kpi ov-kpi-done" data-jump="done">
      <div class="ov-kpi-icon" style="background:color-mix(in srgb,var(--s-done) 14%,transparent);color:var(--s-done)">✓</div>
      <div class="ov-kpi-body"><div class="ov-kpi-n" style="color:var(--s-done)">${done}</div><div class="ov-kpi-l">已完成</div>
      <div class="ov-kpi-sub">累计交付</div></div></div>`;
    // Completion-rate ring.
    const ringR = 18, ringC = 2 * Math.PI * ringR, ringOff = ringC * (1 - rate / 100);
    h += `<div class="ov-kpi ov-kpi-rate">
      <svg class="ov-ring" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="${ringR}" fill="none" stroke="var(--bg-3)" stroke-width="4"/>
        <circle cx="22" cy="22" r="${ringR}" fill="none" stroke="var(--s-done)" stroke-width="4"
          stroke-dasharray="${ringC}" stroke-dashoffset="${ringOff}" stroke-linecap="round"
          transform="rotate(-90 22 22)" style="transition:stroke-dashoffset .6s var(--ease-out)"/>
      </svg>
      <div class="ov-kpi-body"><div class="ov-kpi-n" style="color:var(--s-done)">${rate}<span>%</span></div><div class="ov-kpi-l">完成率</div>
      <div class="ov-kpi-sub">${done}/${allT} 个需求</div></div></div>`;
    h += `</div>`;

    /* Member workload cards. */
    h += `<div class="tp-sec">成员负载 <span>${TEAM.length} 人 · 均值 ${avgLoad}% · 点击查看需求</span></div>`;
    const sorted = TEAM.slice().sort((a, b) => load(b) - load(a));
    h += '<div class="ov-members">' + sorted.map((m) => {
      const ld = load(m), lc = ld > 90 ? 'var(--s-cancel)' : ld > 70 ? 'var(--s-doing)' : 'var(--s-done)';
      const nm = _esc(m.name), rl = _esc(m.role);
      const busy = ld > 90 ? '偏高' : ld > 70 ? '较忙' : ld > 0 ? '正常' : '空闲';
      const busyCls = ld > 90 ? 'hi' : ld > 70 ? 'mid' : 'lo';
      return `<div class="ov-member" data-jump-member="${_esc(m.userId || '')}" data-jump-name="${nm}">
        <div class="ov-mtop"><span class="ov-mava" style="background:${m.color}">${nm[0] || '?'}</span>
          <div class="ov-mname"><b>${nm}</b><span class="ov-mrole">${rl}</span></div>
          <span class="ov-mbusy ov-mbusy-${busyCls}">${busy}</span></div>
        <div class="ov-mbar"><i style="width:${Math.max(ld, 3)}%;background:${lc}"></i></div>
        <div class="ov-mfoot">
          <span class="ov-mnum"><b style="color:var(--s-doing)">${m.doing}</b> 进行</span>
          <span class="ov-mnum"><b style="color:var(--s-todo)">${m.todo}</b> 待办</span>
          <span class="ov-mnum"><b style="color:var(--s-done)">${m.done}</b> 完成</span>
          ${m.stuck ? `<span class="ov-mnum"><b style="color:var(--s-cancel)">${m.stuck}</b> 卡住</span>` : ''}
          <span class="ov-mload">${ld}%</span>
        </div></div>`;
    }).join('') + '</div>';

    /* Seven-day completion trend and status distribution. */
    const wd = WEEK.done || [], wl = WEEK.labels || [];
    h += '<div class="ov-charts">';
    // Seven-day trend area chart.
    if (wd.length) {
      const mx = Math.max.apply(null, wd.concat([1]));
      const total7 = wd.reduce((a, b) => a + b, 0);
      h += `<div class="ov-card ov-chart-trend">
        <div class="ov-card-head"><span class="ov-card-title">近 7 天完成</span><span class="ov-card-sub">${total7} 个</span></div>
        <div class="ov-trend">` +
        wd.map((v, i) => {
          const pct = v ? Math.max(8, Math.round(v / mx * 100)) : 0;
          return `<div class="ov-trend-col" style="--h:${pct}%"><div class="ov-trend-bar${v ? '' : ' zero'}"${v ? ' style="background:linear-gradient(var(--s-done),color-mix(in srgb,var(--s-done) 50%,transparent))"' : ''}></div><span class="ov-trend-val">${v || ''}</span><span class="ov-trend-lbl">${_esc(wl[i] || '')}</span></div>`;
        }).join('') + `</div></div>`;
    }
    // Status distribution bars with percentages.
    h += `<div class="ov-card ov-chart-dist">
      <div class="ov-card-head"><span class="ov-card-title">状态分布</span><span class="ov-card-sub">${allT} 个</span></div>
      <div class="ov-dist-list">` +
      [['进行中', doing, 'var(--s-doing)'], ['待办', todo, 'var(--s-todo)'],
        ['已完成', done, 'var(--s-done)'], ['搁置', cancel, 'var(--s-cancel)']].map(([l, v, c]) => {
        const pct = allT ? Math.round(v / allT * 100) : 0;
        return `<div class="ov-dist-row">
          <span class="ov-dist-label">${l}</span>
          <div class="ov-dist-bar"><i style="width:${pct}%;background:${c}"></i></div>
          <span class="ov-dist-val">${v}</span>
          <span class="ov-dist-pct">${pct}%</span></div>`;
      }).join('') + `</div></div>`;
    h += '</div>';

    /* Priority distribution when data is available. */
    const prioCnt = { critical: 0, high: 0, normal: 0, low: 0 };
    TEAMTASKS.forEach((t) => { if (prioCnt[t.priority] !== undefined) prioCnt[t.priority]++; });
    const prioTotal = prioCnt.critical + prioCnt.high + prioCnt.normal + prioCnt.low;
    if (prioTotal > 0) {
      const prioData = [['紧急', prioCnt.critical, '#e0475e'], ['高', prioCnt.high, '#e07d0a'],
        ['普通', prioCnt.normal, 'var(--accent)'], ['低', prioCnt.low, 'var(--ink-4)']];
      h += `<div class="ov-card ov-chart-prio">
        <div class="ov-card-head"><span class="ov-card-title">优先级分布</span><span class="ov-card-sub">${prioTotal} 个需求</span></div>
        <div class="ov-stack">` +
        prioData.filter(([, v]) => v > 0).map(([l, v, c]) =>
          `<i style="width:${v / prioTotal * 100}%;background:${c}" title="${l} ${v}"></i>`).join('') +
        `</div><div class="ov-stack-legend">` +
        prioData.map(([l, v, c]) => {
          const pct = prioTotal ? Math.round(v / prioTotal * 100) : 0;
          return `<span class="ov-lg-item"><i style="background:${c}"></i>${l}<b>${v}</b><em>${pct}%</em></span>`;
        }).join('') + `</div></div>`;
    }
    return h;
  }

  function bind(root, { reload: _fetchData, navigate: _jumpToTasks }) {
    root.querySelectorAll('[data-team-retry]').forEach((el) => el.addEventListener('click', async () => {
      if (el.disabled) return;
      el.disabled = true; el.textContent = '正在加载…';
      await _fetchData();
    }));
    // Navigate from summary and risk indicators using data-jump status values.
    root.querySelectorAll('[data-jump]').forEach((el) => {
      /* Keep the default cursor for click actions; reserve drag cursors for draggable controls. */
      el.addEventListener('click', () => {
        const j = el.getAttribute('data-jump');
        // Map canceled tasks to all and active or pending tasks to open.
        const fmap = { doing: 'open', todo: 'open', done: 'done', cancel: 'all' };
        _jumpToTasks(fmap[j] || 'open');
      });
    });
    // Filter team requirements by owner when a member card is selected.
    root.querySelectorAll('[data-jump-member]').forEach((el) => {
      el.addEventListener('click', () => {
        _jumpToTasks('all', { uid: el.getAttribute('data-jump-member') || '', name: el.getAttribute('data-jump-name') || '' });
      });
    });
  }

  global.SoduWorkTeamOverview = { render, bind };
})(window);
