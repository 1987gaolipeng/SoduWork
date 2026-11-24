





















const _MC = {
  timer: null,
  onlyRunning: true,   /* Open terminals only for active runs by default; each terminal starts a real process. */
  terms: {},           /* key -> {t, ws, ro, dead}, where key = task ID | view mode */
  meta: {},            /* key -> latest run information (status indicator and context usage) */
  /* Manually opened consoles remain visible until explicitly closed, independent of the active-task filter. */
  extra: [],           /* [{tid, mode, title}] */
};

/*
 * Key tiles by task and mode so a session terminal and shell can coexist, matching backend
 * terminal identity.
 */
function _mcKey(tid, mode) { return tid + '|' + (mode || 'session'); }
function _mcParse(key) { const i = key.lastIndexOf('|'); return { tid: key.slice(0, i), mode: key.slice(i + 1) }; }

function openMultiConsole() {
  let p = document.getElementById('mcPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'mcPanel';
    p.className = 'mc-panel';
    document.body.appendChild(p);
    p.innerHTML =
      '<div class="mc-head">' +
        '<b class="mc-title">多路控制台 <span class="mc-sub" id="mcSub"></span></b>' +
        '<span class="mc-acts">' +
          '<button class="mc-btn mc-btn-new" data-mc="new" title="自己开一块：挑一条活 + 挑形态' +
            '（会话＝接着它的对话聊；命令行＝在它的工作目录里跑命令）">＋ 新建控制台</button>' +
          '<button class="mc-btn is-on" data-mc="only" title="只给还在干的活自动开终端。' +
            '每开一块就是后端一个真 PTY，别乱开（自己新建的那些不受这个开关影响）">只看在干的</button>' +
          '<button class="mc-x" data-mc="close" title="关掉（后端那些终端还留着）">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="mc-new" id="mcNew" style="display:none"></div>' +
      '<div class="mc-grid" id="mcGrid"></div>';
    _mcBind(p);
  }
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  _mcTick();
  clearInterval(_MC.timer);
  /* Poll only to discover tasks and refresh status; terminal output arrives through WebSocket. */
  _MC.timer = setInterval(_mcTick, 4000);
}

function closeMultiConsole() {
  const p = document.getElementById('mcPanel');
  if (p && p.classList.contains('show')) {
    p.classList.remove('show');
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
  clearInterval(_MC.timer);
  _MC.timer = null;
  /*
   * Disconnect the frontend without terminating backend processes; backend idle cleanup
   * reclaims unused terminals.
   */
  Object.keys(_MC.terms).forEach(_mcDropTerm);
  const grid = document.getElementById('mcGrid');
  if (grid) grid.innerHTML = '';
}

function _mcBind(p) {
  p.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mc]');
    if (b) {
      const a = b.getAttribute('data-mc');
      if (a === 'close') return closeMultiConsole();
      if (a === 'only') {
        _MC.onlyRunning = !_MC.onlyRunning;
        b.classList.toggle('is-on', _MC.onlyRunning);
        return _mcTick();
      }
      if (a === 'new') return _mcToggleNew();
      if (a === 'new-cancel') return _mcToggleNew(false);
      if (a === 'new-ok') return _mcCreate();
    }
    const tb = e.target.closest('[data-mct]');
    if (!tb) return;
    const key = tb.getAttribute('data-key');
    const { tid } = _mcParse(key);
    const act = tb.getAttribute('data-mct');
    if (act === 'open') {
      /*
       * Open individual consoles through Entry in their own native window; openConsole here
       * would cover the multi-console view.
       */
      const open = (typeof openConsoleEntry === 'function') ? openConsoleEntry : openConsole;
      if (typeof open === 'function') open(tid);
    } else if (act === 'stop') {
      _mcStop(tid, tb);
    } else if (act === 'restart') {
      _mcRestartTerm(key);
    } else if (act === 'drop') {
      /* Only manual tiles have a close action; removing one does not kill its backend terminal. */
      _MC.extra = _MC.extra.filter((x) => _mcKey(x.tid, x.mode) !== key);
      _mcDropTerm(key);
      const cell = _mcCell(key);
      if (cell) cell.remove();
      _mcTick();
    }
  });
  if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.mc-head'));
}

/* Create a console. */
function _mcToggleNew(force) {
  const box = document.getElementById('mcNew');
  if (!box) return;
  const show = force === undefined ? box.style.display === 'none' : !!force;
  if (!show) { box.style.display = 'none'; return; }
  /*
   * Combine local tasks with active session history and rank tasks with sessions first.
   */
  const seen = {};
  const opts = [];
  Object.keys(_MC.meta).forEach((k) => {
    const m = _MC.meta[k];
    if (!m || seen[m.taskId]) return;
    seen[m.taskId] = 1;
    opts.push({ id: m.taskId, title: m.title || '', hasSession: true });
  });
  (typeof tasks !== 'undefined' ? tasks : []).forEach((t) => {
    if (seen[t.id]) return;
    seen[t.id] = 1;
    opts.push({ id: t.id, title: t.title || '', hasSession: false });
  });
  box.innerHTML =
    '<span class="mc-new-l">开在哪条活上</span>' +
    '<select class="mc-new-sel" id="mcNewTask">' +
      opts.map((o) => {
        const key = 'console.' + (o.title ? 'task' : 'unnamed') + (o.hasSession ? 'WithSession' : '');
        const params = { title: o.title.slice(0, 40) };
        const fallback = (o.title || '未命名') + (o.hasSession ? '（有会话）' : '');
        return '<option value="' + esc(o.id) + '" data-task-title="' + esc(o.title) + '" data-i18n="' + key + '" data-i18n-params="' + esc(JSON.stringify(params)) + '">' +
          esc(window.SoduWorkI18n ? SoduWorkI18n.t(key, fallback, params) : fallback) + '</option>';
      }).join('') +
    '</select>' +
    '<span class="mc-new-l">形态</span>' +
    '<select class="mc-new-sel mc-new-mode" id="mcNewMode">' +
      '<option value="session">会话（接着它的对话聊）</option>' +
      '<option value="shell">命令行（在它的工作目录里跑命令）</option>' +
    '</select>' +
    '<button class="mc-btn" data-mc="new-ok">打开</button>' +
    '<button class="mc-btn" data-mc="new-cancel">取消</button>' +
    '<span class="mc-new-tip">没派过活的任务没有会话，选「会话」会自动退回命令行；' +
    '目录退回本机工作区根目录。</span>';
  box.style.display = '';
}

function _mcCreate() {
  const sel = document.getElementById('mcNewTask');
  const mode = document.getElementById('mcNewMode');
  if (!sel || !sel.value) return _mcToggleNew(false);
  const tid = sel.value;
  const m = (mode && mode.value) || 'session';
  const key = _mcKey(tid, m);
  if (_MC.extra.some((x) => _mcKey(x.tid, x.mode) === key) || _mcCell(key)) {
    if (typeof petSay === 'function') petSay('这一块已经开着了');
    return _mcToggleNew(false);
  }
  const title = sel.options[sel.selectedIndex]?.dataset.taskTitle || '';
  _MC.extra.push({ tid: tid, mode: m, title: title });
  _mcToggleNew(false);
  _mcTick();
}

async function _mcStop(tid, btn) {
  btn.disabled = true;
  btn.textContent = '停…';
  try {
    await SoduWorkAPI.aiStop(tid);
    if (typeof petSay === 'function') petSay('已经把它停下来了');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '叫停';
    if (typeof petSay === 'function') {
      petSay(typeof _humanErr === 'function' ? _humanErr(e, '没停成') : '没停成');
    }
  }
  _mcTick();
}

/* Reopening terminates the backend terminal and its processes before creating a replacement. */
async function _mcRestartTerm(key) {
  const { tid } = _mcParse(key);
  try { await SoduWorkAPI.termClose(tid); } catch (e) {}
  _mcDropTerm(key);
  setTimeout(() => {
    const cell = _mcCell(key);
    if (cell) _mcAttachTerm(key, cell.querySelector('.mc-term'));
  }, 250);
}

async function _mcTick() {
  const p = document.getElementById('mcPanel');
  if (!p || !p.classList.contains('show')) { clearInterval(_MC.timer); _MC.timer = null; return; }
  const r = await SoduWorkAPI.aiConsoles();
  /*
   * Keep the first backend-sorted run per task: active runs precede inactive ones, then
   * newer runs precede older ones.
   */
  const seen = {};
  const all = ((r && r.runs) || []).filter((x) => {
    const tid = x.taskId || x.ref;
    if (!tid || seen[tid]) return false;
    seen[tid] = 1;
    return true;
  });
  const runs = _MC.onlyRunning ? all.filter((x) => x.state === 'running') : all;
  /*
   * Combine automatic active tasks and manually opened tiles. Prefer automatic entries for
   * duplicate keys because they carry live status.
   */
  const items = runs.map((x) => ({ key: _mcKey(x.taskId || x.ref, 'session'), mode: 'session',
                                   tid: x.taskId || x.ref, run: x, manual: false }));
  const has = {};
  items.forEach((it) => { has[it.key] = 1; });
  _MC.extra.forEach((x) => {
    const key = _mcKey(x.tid, x.mode);
    if (has[key]) return;
    has[key] = 1;
    items.push({ key: key, mode: x.mode, tid: x.tid, manual: true,
                 run: _MC.meta[key] || { taskId: x.tid, title: x.title, state: '' } });
  });
  _mcRender(items, all);
}

function _mcCell(key) {
  const grid = document.getElementById('mcGrid');
  return grid ? grid.querySelector('[data-cell="' + String(key).replace(/["\\]/g, '\\$&') + '"]') : null;
}

function _mcRender(items, all) {
  const grid = document.getElementById('mcGrid');
  const sub = document.getElementById('mcSub');
  if (!grid) return;
  const total = (all || []).length;
  const live = (all || []).filter((x) => x.state === 'running').length;
  if (sub) {
    /*
     * Count visible task tiles rather than execution sessions; a task can have multiple
     * historical runs.
     */
    sub.textContent = live + ' 个在干 · 共 ' + total + ' 条活' +
      (_MC.onlyRunning && total > live ? '（干完的已收起）' : '') +
      (_MC.extra.length ? ' · 自开 ' + _MC.extra.length + ' 块' : '');
  }
  if (!items.length) {
    Object.keys(_MC.terms).forEach(_mcDropTerm);
    grid.innerHTML = '<div class="mc-blank"><b>' +
      (_MC.onlyRunning ? '现在没有活在跑' : '这台机器上还没有本机 CLI 的会话') + '</b>' +
      '<span>派一条活给本机的 AI，这里就会多出一块真终端；' +
      '也可以点右上角「＋ 新建控制台」自己开一块。</span></div>';
    _mcLayout(0);
    return;
  }
  if (grid.querySelector('.mc-blank')) grid.innerHTML = '';

  const keep = {};
  items.forEach((it) => {
    keep[it.key] = 1;
    if (!it.manual) _MC.meta[it.key] = it.run;
    let cell = _mcCell(it.key);
    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'mc-cell';
      cell.setAttribute('data-cell', it.key);
      cell.innerHTML = _mcCellHtml(it);
      grid.appendChild(cell);
      _mcAttachTerm(it.key, cell.querySelector('.mc-term'));
    }
    _mcPatchHead(cell, it.run || {}, it);
  });
  /* Disconnect and remove tiles no longer in the selected set. */
  grid.querySelectorAll('[data-cell]').forEach((c) => {
    const k = c.getAttribute('data-cell');
    if (!keep[k]) { _mcDropTerm(k); c.remove(); }
  });
  _mcLayout(items.length);
}

function _mcCellHtml(it) {
  const x = it.run || {};
  const k = esc(it.key);
  return '<div class="mc-cell-head">' +
      '<span class="mc-lamp"></span>' +
      '<b class="mc-name"' + (x.title ? ' data-user-content' : '') + ' data-user-attributes="title" title="' + esc(x.workDir || '') + '">' + esc(x.title || '未命名') + '</b>' +
      (it.mode === 'shell' ? '<span class="mc-mode">命令行</span>' : '') +
      (it.manual ? '<span class="mc-mode mc-mode-own">自开</span>' : '') +
      '<span class="mc-cli"></span>' +
      '<span class="mc-gauge"></span>' +
      '<span class="mc-cellacts">' +
        '<button class="mc-tbtn" data-mct="open" data-key="' + k + '"' +
          ' title="进单条控制台：实况 / 原始 / 跟它说话">单看</button>' +
        '<button class="mc-tbtn" data-mct="restart" data-key="' + k + '"' +
          ' title="把后端那个终端连同里面的进程收掉，重开一个">重开</button>' +
        '<button class="mc-tbtn mc-tbtn-stop" data-mct="stop" data-key="' + k + '">叫停</button>' +
        (it.manual ? '<button class="mc-tbtn" data-mct="drop" data-key="' + k + '"' +
          ' title="把这一块撤掉（后端那个终端还留着）">✕</button>' : '') +
      '</span>' +
    '</div>' +
    '<div class="mc-term"></div>';
}

/* Patch changing header text without rebuilding the mounted terminal. */
function _mcPatchHead(cell, x, it) {
  const st = (typeof _CON_ST !== 'undefined' && _CON_ST[x.state]) || ['', ''];
  const lamp = cell.querySelector('.mc-lamp');
  if (lamp) { lamp.className = 'mc-lamp con-lamp con-lamp-' + st[1]; lamp.title = st[0] || ''; }
  const cli = cell.querySelector('.mc-cli');
  if (cli) {
    /* Translate segment/queue labels separately; preserve cliName as user data. */
    const _mcT = window.SoduWorkI18n?.translateText || String;
    cli.textContent = (x.cliName || x.cli || '') +
      (x.segment > 1 ? _mcT(' · 第 ' + x.segment + ' 段') : '') +
      (x.queued ? _mcT(' · 排队 ' + x.queued) : '');
  }
  const g = cell.querySelector('.mc-gauge');
  /* Shell tiles have no AI context, so omit the context gauge. */
  if (g) {
    g.innerHTML = (it && it.mode === 'shell') ? ''
      : (typeof _conGaugeHtml === 'function' ? _conGaugeHtml(x) : '');
  }
  const stop = cell.querySelector('[data-mct="stop"]');
  if (stop) stop.style.display = x.state === 'running' ? '' : 'none';
  /* Do not dim shell tiles based on AI session state. */
  const isShell = it && it.mode === 'shell';
  cell.classList.toggle('is-idle', !isShell && x.state !== 'running');
}

/* ---------------- Each pane connects a real xterm to a backend PTY ---------------- */
/* Keep a dark ANSI-compatible terminal background with brighter foreground colors for smaller split panes. */
function _mcTermTheme() {
  return {
    background: '#1b2233', foreground: '#eaf0fb', cursor: '#7fd6ff',
    cursorAccent: '#1b2233', selectionBackground: 'rgba(127,214,255,.34)',
    black: '#3a4560', red: '#ff7b8f', green: '#8ef07a', yellow: '#ffd166',
    blue: '#7fb8ff', magenta: '#e29bff', cyan: '#66e6ff', white: '#eaf0fb',
    brightBlack: '#7d89a8', brightRed: '#ff9aa9', brightGreen: '#aef79a',
    brightYellow: '#ffe08a', brightBlue: '#a3ccff', brightMagenta: '#f0b8ff',
    brightCyan: '#8ff0ff', brightWhite: '#ffffff',
  };
}

/* Use explicit layouts for small terminal counts to avoid empty cells; fall back to rows for larger counts. */
const _MC_GRID = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2],
                   7: [4, 2], 8: [4, 2], 9: [3, 3] };
const _MC_MIN_W = 360;   /* Minimum usable terminal width. */
const _MC_MIN_H = 220;   /* Minimum usable terminal height. */

function _mcLayout(n) {
  const grid = document.getElementById('mcGrid');
  if (!grid) return;
  if (!n) { grid.style.gridTemplateColumns = ''; grid.style.gridTemplateRows = ''; return; }
  const gap = 12, pad = 24;
  let [cols, rows] = _MC_GRID[n] || [4, Math.ceil(n / 4)];
  /* Reduce columns in narrow windows instead of compressing terminals below their usable width. */
  const availW = grid.clientWidth - pad;
  while (cols > 1 && (availW - (cols - 1) * gap) / cols < _MC_MIN_W) {
    cols -= 1;
    rows = Math.ceil(n / cols);
  }
  grid.style.gridTemplateColumns = 'repeat(' + cols + ',minmax(0,1fr))';
  const availH = grid.clientHeight - pad - (rows - 1) * gap;
  if (availH / rows >= _MC_MIN_H) {
    /* When tiles fit, divide the window evenly without page scrolling. */
    grid.style.gridTemplateRows = 'repeat(' + rows + ',minmax(0,1fr))';
    grid.style.overflowY = 'hidden';
  } else {
    /* Otherwise enforce usable tile heights and allow page scrolling. */
    grid.style.gridTemplateRows = 'repeat(' + rows + ',' + _MC_MIN_H + 'px)';
    grid.style.overflowY = 'auto';
  }
  /* Recalculate terminal rows and columns after resizing tiles. */
  requestAnimationFrame(() => Object.keys(_MC.terms).forEach(_mcFit));
}

/*
 * Fit terminals from measured character dimensions and container size; use conservative
 * fallback metrics when unavailable. FitAddon is not bundled.
 */
function _mcFit(key) {
  const e = _MC.terms[key];
  const cell = _mcCell(key);
  const box = cell && cell.querySelector('.mc-term');
  if (!e || !e.t || !box || !box.clientWidth) return;
  let cw = 7, ch = 15;
  try {
    const d = e.t._core && e.t._core._renderService && e.t._core._renderService.dimensions;
    if (d && d.css && d.css.cell && d.css.cell.width > 0) {
      cw = d.css.cell.width; ch = d.css.cell.height;
    }
  } catch (err) {}
  /*
   * Subtract padding and scrollbar width to avoid extra columns and horizontal overflow.
   */
  const cols = Math.max(20, Math.floor((box.clientWidth - 12 - 14) / cw));
  const rows = Math.max(5, Math.floor((box.clientHeight - 8) / ch));
  if (cols === e.t.cols && rows === e.t.rows) return;
  try { e.t.resize(cols, rows); } catch (err) {}
  if (e.ws && e.ws.readyState === 1) {
    e.ws.send(JSON.stringify({ t: 'size', cols: cols, rows: rows }));
  }
}

function _mcAttachTerm(key, box) {
  if (!box || typeof Terminal === 'undefined') {
    if (box) box.innerHTML = '<div class="mc-empty">终端组件没加载（vendor/xterm 缺失）</div>';
    return;
  }
  _mcDropTerm(key);
  const t = new Terminal({
    fontSize: 14.5, lineHeight: 1.1, cursorBlink: false, scrollback: 4000,
    fontFamily: '"Alibaba Sans Code", "Cascadia Code", "Cascadia Mono", Consolas, monospace',
    theme: _mcTermTheme(), allowProposedApi: true,
  });
  t.open(box);
  const e = { t: t, ws: null, ro: null, dead: false };
  _MC.terms[key] = e;
  _mcFit(key);
  let ws;
  /* mode=session reconnects the task conversation; the backend falls back to a shell when no session ID is available. */
  const { tid, mode } = _mcParse(key);
  try { ws = new WebSocket(SoduWorkAPI.termWsUrl(tid, t.cols, t.rows, mode)); }
  catch (err) { t.writeln((window.SoduWorkI18n?.translateText || String)('\x1b[31m连不上终端通道\x1b[0m')); return; }
  e.ws = ws;
  /* Authenticate in the first WebSocket frame; keep credentials out of URLs. */
  ws.onopen = () => { try { ws.send(SoduWorkAPI.wsAuthFrame()); } catch (err) {} };
  /*
   * Do not write terminal text before connection; the shell's initial prompt and cursor
   * movement would overlap it.
   */
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (err) { return; }
    if (m.t === 'o') t.write(m.d);
    else if (m.t === 'ready') _mcFit(key);
    else if (m.t === 'end') {
      e.dead = true;
      t.writeln((window.SoduWorkI18n?.translateText || String)('\r\n\x1b[90m—— 这个终端结束了。按「重开」再开一个 ——\x1b[0m'));
    } else if (m.t === 'err') {
      t.writeln('\r\n\x1b[31m' + String(m.d || '') + '\x1b[0m');
    }
  };
  ws.onclose = () => {
    if (e.dead) return;
    try { t.writeln((window.SoduWorkI18n?.translateText || String)('\r\n\x1b[90m—— 连接断开（后端那个终端还在跑）——\x1b[0m')); } catch (err) {}
  };
  /*
   * During the first 1.2 seconds, suppress terminal capability/cursor replies matching
   * ESC[...c or ESC[...R so ConPTY does not treat them as typed commands. Preserve
   * subsequent real input.
   */
  const t0 = Date.now();
  const isReply = (d) => /^\x1b\[[?>]?[\d;]*[cR]$/.test(d);
  t.onData((d) => {
    if (ws.readyState !== 1) return;
    if (Date.now() - t0 < 1200 && isReply(d)) return;
    ws.send(JSON.stringify({ t: 'i', d: d }));
  });
  try {
    e.ro = new ResizeObserver(() => _mcFit(key));
    e.ro.observe(box);
  } catch (err) {}
}

function _mcDropTerm(key) {
  const e = _MC.terms[key];
  if (!e) return;
  try { if (e.ro) e.ro.disconnect(); } catch (err) {}
  try { if (e.ws) e.ws.close(); } catch (err) {}
  try { if (e.t) e.t.dispose(); } catch (err) {}
  delete _MC.terms[key];
}

window.openMultiConsole = openMultiConsole;
window.closeMultiConsole = closeMultiConsole;
