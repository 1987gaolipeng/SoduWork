/*
 * Shared monthly Gantt renderer: team rows group by owner with separate overlap lanes;
 * personal rows represent tasks. Clip intervals to the month. Blue marks pending/active
 * work, green completed work, and red overdue work. Highlight weekends and today using
 * native HTML/CSS.
 */
(function (global) {
  'use strict';

  const DAY = 86400000;
  const _pad = n => (n < 10 ? '0' : '') + n;
  const _dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

  /*
   * Map a task to monthly planned and actual intervals; return null outside the month.
   * Planned start is required by the data layer. Actual duration ends at completion or today
   * and appears beneath the plan.
   */
  function _span(s0, e0, m0, m1, days) {
    if (s0 == null) return null;
    let e = e0 == null || e0 < s0 ? s0 : e0;
    if (e < m0 || s0 > m1) return null;
    const s = Math.max(s0, m0), ee = Math.min(e, m1);
    return { sd: Math.round((s - m0) / DAY), ed: Math.round((ee - m0) / DAY) };
  }
  function _bar(t, m0, m1, days) {
    /*
     * Recurring work has a cadence rather than a fixed duration; display a dashed bar across
     * the month.
     */
    if (t.recur) {
      return { id: t.id, title: t.title || '未命名', st: t.status === 'done' ? 'done' : 'run',
        routine: t.recur, plan: { sd: 0, ed: days - 1 }, act: null, days };
    }
    const start = t.start ? _dayStart(t.start) : (t.createdAt ? _dayStart(t.createdAt) : null);
    const due = t.due ? _dayStart(t.due) : null;
    const plan = _span(start, due, m0, m1, days);
    const aS = t.actualStart ? _dayStart(t.actualStart) : null;
    const aE = t.actualEnd ? _dayStart(t.actualEnd) : (aS != null && t.status !== 'done' ? _dayStart(Date.now()) : null);
    const act = _span(aS, aE, m0, m1, days);
    if (!plan && !act) return null;
    const overdue = t.due && t.due < Date.now() && t.status !== 'done';
    const st = t.status === 'done' ? 'done' : overdue ? 'over' : 'run';
    return { id: t.id, title: t.title || '未命名', st, plan, act, days };
  }

  /* Greedily assign overlapping bars to lanes using the union of planned and actual intervals. */
  function _packLanes(bars) {
    const lanes = [];
    const S = b => Math.min(b.plan ? b.plan.sd : 1e9, b.act ? b.act.sd : 1e9);
    const E = b => Math.max(b.plan ? b.plan.ed : -1, b.act ? b.act.ed : -1);
    bars.sort((a, b) => S(a) - S(b) || E(a) - E(b));
    bars.forEach(b => {
      let ln = lanes.findIndex(endAt => endAt < S(b));
      if (ln < 0) { ln = lanes.length; lanes.push(-1); }
      lanes[ln] = E(b); b.lane = ln;
    });
    return Math.max(1, lanes.length);
  }

  function _cells(days, todayIdx, y, m) {
    let h = '';
    for (let i = 0; i < days; i++) {
      const dow = new Date(y, m, i + 1).getDay();
      h += '<div class="gv-cell' + (dow === 0 || dow === 6 ? ' we' : '') + (i === todayIdx ? ' today' : '') + '"></div>';
    }
    return h;
  }

  /* rows: [{label, sub, tasks:[...]}]；opts: {year, month(0-based), query, onlyOverdue, clickAttr} */
  function html(rows, opts) {
    const y = opts.year, m = opts.month;
    const days = new Date(y, m + 1, 0).getDate();
    const m0 = new Date(y, m, 1).getTime(), m1 = new Date(y, m, days).getTime();
    const now = new Date(); const todayIdx = (now.getFullYear() === y && now.getMonth() === m) ? now.getDate() - 1 : -1;
    const q = (opts.query || '').trim().toLowerCase();
    const clickAttr = opts.clickAttr || 'data-gvtid';

    let total = 0;
    const rowsH = rows.map(r => {
      const bars = [];
      (r.tasks || []).forEach(t => {
        if (q && !(t.title || '').toLowerCase().includes(q)) return;
        const b = _bar(t, m0, m1, days);
        if (!b) return;
        if (opts.onlyOverdue && b.st !== 'over') return;
        bars.push(b);
      });
      if (!bars.length) return '';
      total += bars.length;
      const laneN = _packLanes(bars);
      const pct = (n) => (n / days * 100).toFixed(3) + '%';
      const barsH = bars.map(b => {
        const top = b.lane * 30 + 4;
        let s = '';
        if (b.plan) {
          const RC = { daily: '每天', weekly: '每周', monthly: '每月' };
          const label = b.routine ? ('↻ ' + b.title + ' · ' + (RC[b.routine] || b.routine))
            : ((b.st === 'done' ? '✓ ' : '') + b.title);
          s += '<div class="gv-bar ' + (b.routine ? 'gv-routine' : 'gv-' + b.st) + '" ' + clickAttr + '="' + esc(b.id) + '"' +
            ' style="left:' + pct(b.plan.sd) + ';width:' + pct(b.plan.ed - b.plan.sd + 1) + ';top:' + top + 'px"' +
            ' title="' + esc(b.title) + (b.routine ? ' · 例行' : ' · 计划') + '">' + esc(label) + '</div>';
        }
        if (b.act) {
          /* Place actual duration beneath the plan, or use it as the titled primary bar when no plan exists. */
          const solo = !b.plan;
          s += '<div class="gv-act gv-act-' + b.st + (solo ? ' gv-act-solo' : '') + '" ' + clickAttr + '="' + esc(b.id) + '"' +
            ' style="left:' + pct(b.act.sd) + ';width:' + pct(b.act.ed - b.act.sd + 1) + ';top:' + (top + (solo ? 0 : 19)) + 'px"' +
            ' title="' + esc(b.title) + ' · 实际">' + (solo ? esc(b.title) : '') + '</div>';
        }
        return s;
      }).join('');
      return '<div class="gv-row">' +
        "<div class=\"gv-rowlabel\"><b data-user-content>" + esc(r.label) + '</b>' + (r.sub ? '<span>' + esc(r.sub) + '</span>' : '') + '</div>' +
        '<div class="gv-lane" style="height:' + (laneN * 30 + 8) + 'px">' +
        '<div class="gv-cells">' + _cells(days, todayIdx, y, m) + '</div>' + barsH + '</div></div>';
    }).join('');

    let head = '<div class="gv-row gv-headrow"><div class="gv-rowlabel gv-headlabel">' + esc(opts.labelHead || '负责人') + '</div><div class="gv-lane gv-headlane"><div class="gv-cells">';
    for (let i = 0; i < days; i++) {
      const dow = new Date(y, m, i + 1).getDay();
      head += '<div class="gv-cell gv-daynum' + (dow === 0 || dow === 6 ? ' we' : '') + (i === todayIdx ? ' today' : '') + '">' + (i === 0 ? (m + 1) + '/1' : (i + 1)) + '</div>';
    }
    head += '</div></div></div>';

    return '<div class="gv">' +
      '<div class="gv-tools">' +
      '<span class="gv-lg"><i class="gv-dot gv-run"></i>进行中</span>' +
      '<span class="gv-lg"><i class="gv-dot gv-done"></i>已完成</span>' +
      '<span class="gv-lg"><i class="gv-dot gv-over"></i>已逾期</span>' +
      '<span class="gv-lg"><i class="gv-dot gv-actual"></i>实际</span>' +
      '<span class="gv-lg"><i class="gv-dot gv-td"></i>今日</span>' +
      '<span class="gv-lg"><i class="gv-dot gv-we"></i>周末</span>' +
      '<span class="gv-nav"><button class="gv-nbtn" data-gvnav="-1">‹</button><b>' + y + '年' + (m + 1) + '月</b><button class="gv-nbtn" data-gvnav="1">›</button></span>' +
      '<input class="gv-q" data-gvq placeholder="搜索任务名称…" value="' + esc(opts.query || '') + '">' +
      '<label class="gv-od"><input type="checkbox" data-gvod' + (opts.onlyOverdue ? ' checked' : '') + '>只看逾期</label>' +
      '<span class="gv-count">任务 ' + total + ' 项</span>' +
      '</div>' +
      '<div class="gv-body">' + head + (rowsH || '<div class="gv-empty">本月没有符合条件的任务</div>') + '</div></div>';
  }

  global.GanttView = { html };
})(typeof window !== 'undefined' ? window : this);
