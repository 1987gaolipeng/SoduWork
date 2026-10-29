





















let _con = {

  tid: '', ref: '', last: 0, follow: true, tab: 'term',
  timer: null, cur: null, rawLen: 0,
};
let _term = { t: null, ws: null, ro: null, tid: '', dead: false, mode: 'session' };

const _CON_ST = {
  running: ['干着', 'run'], done: ['干完了', 'ok'], failed: ['出错了', 'bad'],
  stopped: ['被叫停', 'stop'], interrupted: ['被打断', 'stop'], unknown: ['不清楚', 'stop'],
};

const _CON_KIND = {
  say: ['说', 'say'], do: ['做', 'do'], out: ['出', 'out'],
  step: ['·', 'step'], sys: ['★', 'sys'],
};

/* Context usage bar. Until the actual model context window is known, the denominator is an estimate.
   A context-limit error supplies the measured value; keep the estimate label until then. */
function _conGaugeHtml(r) {
  if (!r) return '';
  const pct = Math.max(0, Math.min(100, r.ctxPct || 0));
  const used = ((r.tokens || {}).input || 0);
  const win = r.ctxWindow || 0;
  const k = (n) => Math.max(0, Math.round(Number(n || 0))).toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'));
  const lvl = pct >= 85 ? ' is-hot' : (pct >= 60 ? ' is-warm' : '');
  return '<div class="con-gauge' + lvl + '" title="上下文水位 ' + pct.toFixed(0) +
    '%。模型上下文容量尚未确认，当前使用估值">' +
    '<div class="con-gauge-bar"><i style="width:' + Math.max(2, pct).toFixed(0) + '%"></i></div>' +
    '<span class="con-gauge-t">' + k(used) + ' / ' + k(win) +
    (r.ctxWindowKnown ? '' : '<em>估</em>') + '</span></div>' + _conCostHtml(r);
}

/*
 * Display cumulative consumption and duration separately from current context size, which
 * is overwritten each step and includes history.
 */
function _conCostHtml(r) {
  const u = (r && r.usage) || {};
  const total = (u.input || 0) + (u.output || 0);
  const from = (r && (r.firstStarted || r.started)) || 0;
  if (!total && !from) return '';
  const k = (n) => Math.max(0, Math.round(Number(n || 0))).toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'));
  const bits = [];
  if (total) bits.push('共 ' + k(total) + ' token');
  if (u.cost) bits.push('$' + Number(u.cost).toFixed(3));
  if (from) {
    const end = (r.ended && r.ended > from) ? r.ended : (Date.now() / 1000);
    const mins = Math.max(0, Math.round((end - from) / 60));
    bits.push(mins >= 60 ? (mins / 60).toFixed(1) + ' 小时' : mins + ' 分钟');
  }
  if (!bits.length) return '';
  return '<span class="con-cost" title="这条活累计消耗与用时（上面那条是当前上下文水位，两回事）">' +
    esc(bits.join(' · ')) + '</span>';
}

/* Open the console in its own native window. Render in place when already in that window or without IPC.
   Other workspace windows must not embed the console merely because __isDeskWindow is set. */
function openConsoleEntry(tid) {
  if (!tid) return;
  if (window.__deskPanel !== 'console' && window.WinSync && WinSync.routeToWorkWindow &&
      WinSync.routeToWorkWindow('console', { taskId: tid })) return;
  openConsole(tid);
}

function _conPanelNode() {
  let p = document.getElementById('aiConsolePanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'aiConsolePanel';
    p.className = 'con-panel';
    document.body.appendChild(p);
  }
  return p;
}

function openConsole(tid) {
  if (!tid) return;
  const p = _conPanelNode();
  const changed = _con.tid !== tid;
  _con.tid = tid;
  if (changed) { _con.last = 0; _con.rawLen = 0; _con.cur = null; _termStop(); }
  /*
   * Reuse the DOM for an already-open task console; rebuilding would detach xterm while
   * leaving a stale terminal reference.
   */
  if (!changed && p.classList.contains('show') && p.querySelector('.con-head')) {
    _conRefresh(false);
    if (_con.tab === 'term') setTimeout(_termFit, 0);
    return;
  }
  p.innerHTML = _conShellHtml();
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  _bindConsole();
  _conSetTab(_con.tab);
  _conRefresh(true);
  clearInterval(_con.timer);
  _con.timer = setInterval(_conTick, 1500);
}

function closeConsole() {
  const p = document.getElementById('aiConsolePanel');
  if (p && p.classList.contains('show')) {
    p.classList.remove('show');
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
  clearInterval(_con.timer);
  _con.timer = null;
  /*
   * Closing the view disconnects only the frontend; backend idle cleanup owns process
   * reclamation.
   */
  _termStop();
}

function _conTaskTitle() {
  const t = (_deskData.tasks || []).find(x => x.id === _con.tid) ||
    (typeof tasks !== 'undefined' ? tasks.find(x => x.id === _con.tid) : null);
  return (t && t.title) || (_con.cur && _con.cur.title) || '';
}

function _conShellHtml() {
  const cur = _con.cur || {};
  const st = _CON_ST[cur.state] || ['', ''];
  const tab = _con.tab;
  const btn = (k, t, tip) => '<button class="con-tab' + (tab === k ? ' is-on' : '') +
    '" data-ctab="' + k + '" title="' + tip + '">' + t + '</button>';
  return '' +
    '<div class="con-head">' +
      '<span class="con-lamp con-lamp-' + st[1] + '"></span>' +
      '<b class="con-title" title="' + esc(cur.workDir || '') + '">' + esc(_conTaskTitle()) + '</b>' +
      '<span class="con-meta" id="conMeta">' +
        esc(cur.cliName || cur.cli || '') +
        (cur.segment > 1 ? ' · 第 ' + cur.segment + ' 段会话' : '') + '</span>' +
      '<span class="con-gauge-slot" id="conGauge">' + _conGaugeHtml(_con.cur) + '</span>' +



      '<span class="con-tabs">' +
        btn('term', '终端', '真 PTY：真 ANSI、真 TUI、敲的键进得去') +
        btn('live', '实况', '结构化事件流：它说的话 / 跑的命令 / 写的文件（只读、能存档）') +
        btn('raw', '原始', '没被加工过的 stdout 原文') +
      '</span>' +
      '<span class="con-acts" id="conActs">' +
        '<button class="con-btn' + (_con.follow ? ' is-on' : '') +
          '" data-act="con-follow" title="新内容来了自动滚到底">跟随</button>' +
        (cur.state === 'running'
          ? '<button class="con-btn con-btn-stop" data-act="con-stop">叫停</button>' : '') +
        '<button class="con-x" data-act="con-close" title="关掉（终端会留在后端继续跑）">✕</button>' +
      '</span>' +
    '</div>' +
    '<div class="con-warn" id="conWarn" style="display:none"></div>' +
    '<div class="con-body" id="conBody"></div>' +
    '<div class="con-termwrap" id="conTermWrap" style="display:none">' +
      '<div class="con-term" id="conTerm"></div>' +
      '<div class="con-termbar">' +
        /*
         * Session mode resumes the current conversation; shell mode opens a normal command line in
         * the same workspace.
         */
        '<span class="con-tmode">' +
          '<button class="con-tmbtn" data-tmode="session">会话</button>' +
          '<button class="con-tmbtn" data-tmode="shell">命令行</button>' +
        '</span>' +


        '<button class="con-termdir" id="conTermDir" data-act="copy-dir" ' +
          'title="点一下复制完整路径"></button>' +
        '<button class="con-btn" data-act="term-new" title="重开一个（旧的连同里面的进程一起收掉）">重开</button>' +
      '</div>' +
    '</div>' +
    '<div class="con-say" id="conSayBox">' +
      '<input class="con-in" id="conSay" maxlength="2000" placeholder="' +
        (cur.state === 'running' ? '跟它说一句（排在这一轮后面，不打断）'
          : '再交代它一轮（接着上一次的上下文干）') + '">' +
      '<button class="con-send" data-act="con-say">发送</button>' +
    '</div>' +
    '<div class="con-foot" id="conFoot"></div>';
}

const _CON_FOOT = {
  live: '结构化事件流，不是终端——它是一次性非交互拉起来的。你说的话<b>不打断</b>当前这轮。',
  term: '真终端，敲什么执行什么。<b>关掉这扇窗它照常跑</b>（回来接着看）；' +
        '但<b>后端重启会让它连同里面的命令一起结束</b>——不怕重启的活请用「派活」。',
  raw: '没被加工过的原始输出。出鬼事的时候看这个。',
};

function _conSetTab(tab) {
  _con.tab = tab;
  const p = document.getElementById('aiConsolePanel');
  if (!p) return;
  p.querySelectorAll('[data-ctab]').forEach(b =>
    b.classList.toggle('is-on', b.getAttribute('data-ctab') === tab));
  const body = document.getElementById('conBody');
  const tw = document.getElementById('conTermWrap');
  const say = document.getElementById('conSayBox');
  const foot = document.getElementById('conFoot');
  if (body) body.style.display = tab === 'term' ? 'none' : '';
  if (tw) tw.style.display = tab === 'term' ? '' : 'none';
  if (say) say.style.display = tab === 'live' ? '' : 'none';   /* Type directly into the terminal; no separate message box is needed. */
  if (foot) foot.innerHTML = _CON_FOOT[tab] || '';
  if (tab === 'term') _termStart();
  else if (tab === 'raw') { _con.rawLen = 0; _conLoadRaw(); }
  else { _con.last = 0; _conLoad(true); }
}

/* Structured live events. */
/*
 * Copy the complete workspace path. Fall back to textarea copying when navigator.clipboard
 * fails because focus or a secure context is unavailable.
 */
async function _conCopyDir(btn) {
  const dir = (btn && btn.dataset && btn.dataset.full) || (_con.cur || {}).workDir || '';
  if (!dir) return;
  let done = false;
  try {
    await navigator.clipboard.writeText(dir);
    done = true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = dir;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      done = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e2) { done = false; }
  }
  const old = btn.textContent;
  btn.classList.add(done ? 'is-copied' : 'is-copyfail');
  btn.textContent = done ? '已复制：' + dir : '复制不了，手动选一下：' + dir;
  setTimeout(() => {
    btn.classList.remove('is-copied', 'is-copyfail');
    btn.textContent = old;
  }, 1600);
}

/*
 * Abbreviate repeated workspace prefixes in event rows; the title tooltip retains the full
 * path.
 */
function _conShort(text) {
  const wd = (_con.cur || {}).workDir || '';
  if (!wd || !text) return text || '';
  return String(text).split(wd + '\\').join('·\\').split(wd).join('·');
}

function _conRowHtml(it) {
  const k = _CON_KIND[it.kind] || ['', ''];
  const t = String(it.at || '').slice(11, 19) || '';
  /* Remove duplicate tool-name prefixes from legacy archived text. */
  let txt = String(it.text || '');
  if (it.tool && txt.indexOf(it.tool + ' ') === 0) txt = txt.slice(it.tool.length + 1);
  else if (it.tool && txt === it.tool) txt = '';
  return '<div class="con-row is-' + k[1] + '">' +
    '<span class="con-t">' + esc(t) + '</span>' +
    '<span class="con-k">' + esc(k[0]) + '</span>' +
    '<span class="con-x">' +
      (it.tool ? '<b>' + esc(it.tool) + '</b>' + (txt ? ' ' : '') : '') +
      esc(_conShort(txt)) +
    '</span></div>';
}

/* Append events without rebuilding existing rows to preserve reading position and selection. */
async function _conLoad(reset) {
  const box = document.getElementById('conBody');
  if (!box || !_con.tid || _con.tab !== 'live') return;
  if (reset) { _con.last = 0; box.innerHTML = '<div class="con-blank">正在拉…</div>'; }
  const r = await SoduWorkAPI.aiSession(_con.tid, _con.last);
  const cur = document.getElementById('conBody');
  if (cur !== box || _con.tab !== 'live') return;
  if (!r || !r.ok) {
    if (reset) {
      box.innerHTML = '<div class="con-blank">' + esc((r && r.error) || '看不到会话') +
        '<br><span class="con-blank-s">这条活没交给本机 CLI 跑过。' +
        '「终端」那一栏照样能用——它开在这条活的工作目录里。</span></div>';
    }
    return;
  }
  const rows = (r.items || []).filter(x => x.seq > _con.last);
  if (reset) box.innerHTML = rows.length ? '' : '<div class="con-blank">它还没开口，稍等…</div>';
  if (rows.length) {
    if (box.querySelector('.con-blank')) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', rows.map(_conRowHtml).join(''));
    _con.last = Math.max(_con.last, r.last || 0);
    if (_con.follow) setTimeout(() => { box.scrollTop = box.scrollHeight; }, 0);
  }
  _conMerge(r);
}

async function _conLoadRaw() {
  const box = document.getElementById('conBody');
  if (!box || !_con.tid || _con.tab !== 'raw') return;
  const r = await SoduWorkAPI.aiRaw(_con.tid);
  const cur = document.getElementById('conBody');
  if (cur !== box || _con.tab !== 'raw') return;
  const txt = (r && r.text) || '';
  if (txt.length === _con.rawLen && txt) return;      /* Skip rendering when output has not grown. */
  _con.rawLen = txt.length;
  box.innerHTML = txt
    ? '<pre class="con-pre">' + esc(txt) + '</pre>'
    : '<div class="con-blank">' + esc((r && r.error) || '还没有原始输出') + '</div>';
  if (_con.follow) box.scrollTop = box.scrollHeight;
}

/* Update header status and context usage from the event response without another request. */
function _conMerge(r) {
  if (typeof r.ctxPct !== 'number') return;
  _con.cur = Object.assign(_con.cur || {}, {
    ctxPct: r.ctxPct, tokens: r.tokens || (_con.cur || {}).tokens, ctxWindow: r.ctxWindow,
    ctxWindowKnown: r.ctxWindowKnown, state: r.status || (_con.cur || {}).state,
    segment: r.segment || (_con.cur || {}).segment, detached: !!r.detached,
    workDir: r.workDir || (_con.cur || {}).workDir, error: r.error || '',
  });
  _conPatchHead();
}

async function _conRefresh(first) {
  const r = await SoduWorkAPI.aiConsoles();
  const me = ((r && r.runs) || []).find(x => x.taskId === _con.tid);
  if (me) { _con.cur = Object.assign(_con.cur || {}, me); _con.ref = me.ref; }
  _conPatchHead();
  if (first) {
    const p = document.getElementById('aiConsolePanel');
    if (p) {
      const t = p.querySelector('.con-title');
      if (t) t.textContent = _conTaskTitle();
    }
  }
}

/* Patch changing header text without touching the body. */
function _conPatchHead() {
  const p = document.getElementById('aiConsolePanel');
  if (!p || !_con.cur) return;
  const g = p.querySelector('#conGauge');
  if (g) g.innerHTML = _conGaugeHtml(_con.cur);
  const st = _CON_ST[_con.cur.state] || ['', ''];
  const lamp = p.querySelector('.con-head .con-lamp');
  if (lamp) lamp.className = 'con-lamp con-lamp-' + st[1];
  const meta = p.querySelector('#conMeta');
  if (meta) {
    meta.textContent = (_con.cur.cliName || _con.cur.cli || '') +
      (_con.cur.segment > 1 ? ' · 第 ' + _con.cur.segment + ' 段会话' : '');
  }
  /* Update stop-button availability in both directions; a follow-up can restart a completed session. */
  const acts = p.querySelector('#conActs');
  const stopBtn = p.querySelector('[data-act="con-stop"]');
  const running = _con.cur.state === 'running';
  if (stopBtn && !running) stopBtn.remove();
  if (!stopBtn && running && acts) {
    const b = document.createElement('button');
    b.className = 'con-btn con-btn-stop';
    b.setAttribute('data-act', 'con-stop');
    b.textContent = '叫停';
    b.addEventListener('click', () => _conStopClick(b));
    acts.insertBefore(b, acts.querySelector('.con-x'));
  }
  const warn = document.getElementById('conWarn');
  if (warn) {
    const msgs = [];
    if (_con.cur.detached) {
      msgs.push('后端重启过，这一轮的<b>实时</b>输出接不回来了；重启前的记录都在，' +
        '进程还活着——能叫停，跑完照样收产出。');
    }
    if (_con.cur.error) msgs.push(esc(_con.cur.error));
    warn.innerHTML = msgs.join('<br>');
    warn.style.display = msgs.length ? '' : 'none';
  }
}

async function _conTick() {
  const p = document.getElementById('aiConsolePanel');
  if (!p || !p.classList.contains('show')) { clearInterval(_con.timer); _con.timer = null; return; }
  if (_con.tab === 'term') { _conRefresh(false); return; }   /* Terminal output uses WebSocket rather than polling. */
  if ((_con.cur || {}).state === 'running') {
    if (_con.tab === 'raw') await _conLoadRaw(); else await _conLoad(false);
  } else {
    await _conRefresh(false);
  }
}

async function _conStopClick(b) {
  b.disabled = true; b.textContent = '正在停…';
  try {
    await SoduWorkAPI.aiStop(_con.tid);
    if (typeof petSay === 'function') petSay('已经把它停下来了');
    await _conRefresh(false);
  } catch (e) {
    b.disabled = false; b.textContent = '叫停';
    if (typeof petSay === 'function') {
      petSay(typeof _humanErr === 'function' ? _humanErr(e, '没停成') : '没停成');
    }
  }
}

/*
 * Real xterm-to-PTY terminal; retain a dark background for ANSI color contrast.
 */
function _termTheme() {
  return {
    background: '#12161d', foreground: '#d5dae3', cursor: '#7aa2f7',
    selectionBackground: 'rgba(122,162,247,.32)',
    black: '#2a3040', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
    brightBlack: '#5a6484', brightRed: '#ff8fa3', brightGreen: '#b6e37f',
    brightYellow: '#f0c479', brightBlue: '#96b8ff', brightMagenta: '#d0b4ff',
    brightCyan: '#9ae0ff', brightWhite: '#e6ecff',
  };
}

/*
 * Compute rows and columns from measured character size, with conservative fallback
 * metrics; FitAddon is not bundled.
 */
function _termFit() {
  const box = document.getElementById('conTerm');
  const t = _term.t;
  if (!box || !t || !box.clientWidth) return;
  let cw = 8, ch = 17;
  try {
    const d = t._core && t._core._renderService && t._core._renderService.dimensions;
    if (d && d.css && d.css.cell && d.css.cell.width > 0) {
      cw = d.css.cell.width; ch = d.css.cell.height;
    }
  } catch (e) {}
  /*
   * Subtract horizontal padding and scrollbar width to prevent extra columns and horizontal
   * overflow.
   */
  const cols = Math.max(20, Math.floor((box.clientWidth - 16 - 16) / cw));
  const rows = Math.max(5, Math.floor((box.clientHeight - 10) / ch));
  if (cols === t.cols && rows === t.rows) return;
  try { t.resize(cols, rows); } catch (e) {}
  if (_term.ws && _term.ws.readyState === 1) {
    _term.ws.send(JSON.stringify({ t: 'size', cols: cols, rows: rows }));
  }
}

function _termStart() {
  const box = document.getElementById('conTerm');
  if (!box) return;
  /*
   * Reuse a terminal only while its DOM remains attached; a valid object and socket alone
   * can still leave a blank view after rendering.
   */
  const mounted = box.querySelector('.xterm');
  if (_term.t && _term.tid === _con.tid && _term.wantMode === _term.mode && mounted && _term.ws &&
      (_term.ws.readyState === 0 || _term.ws.readyState === 1)) {
    setTimeout(_termFit, 0);           /* A connected terminal needs only a resize when revisited. */
    return;
  }
  _termStop();
  if (typeof Terminal === 'undefined') {
    box.innerHTML = '<div class="con-blank">终端组件没加载（vendor/xterm 缺失）</div>';
    return;
  }
  const t = new Terminal({
    fontSize: 14.5, lineHeight: 1.15, cursorBlink: true, scrollback: 8000,
    fontFamily: '"Alibaba Sans Code", "Cascadia Code", "Cascadia Mono", Consolas, monospace',
    theme: _termTheme(), allowProposedApi: true,
  });
  t.open(box);
  _term.t = t; _term.tid = _con.tid; _term.dead = false; _term.wantMode = _term.mode;
  _termFit();
  const url = SoduWorkAPI.termWsUrl(_con.tid, t.cols, t.rows, _term.mode);
  let ws;
  try { ws = new WebSocket(url); } catch (e) {
    t.writeln((window.SoduWorkI18n?.translateText || String)('\x1b[31m连不上终端通道\x1b[0m'));
    return;
  }
  _term.ws = ws;
  /* Authenticate in the first WebSocket frame, keeping credentials out of URLs. */
  ws.onopen = () => { try { ws.send(SoduWorkAPI.wsAuthFrame()); } catch (e) {} };
  /*
   * Show connection progress in the header. Writing before the shell initializes can overlap
   * its prompt and cursor movement.
   */
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'o') t.write(m.d);
    else if (m.t === 'ready') {
      const dir = document.getElementById('conTermDir');
      if (dir) {
        const wd = (m.d && m.d.workDir) || '';
        dir.textContent = wd;
        /* Retain the complete path separately from truncated display text for copying. */
        dir.dataset.full = wd;
        dir.title = wd ? '点一下复制完整路径\n' + wd : '';
      }
      _termFit();
    } else if (m.t === 'end') {
      _term.dead = true;
      t.writeln((window.SoduWorkI18n?.translateText || String)('\r\n\x1b[90m—— 这个终端结束了。按「重开」再开一个 ——\x1b[0m'));
    } else if (m.t === 'err') {
      t.writeln('\r\n\x1b[31m' + String(m.d || '') + '\x1b[0m');
    }
  };
  ws.onclose = (e) => {
    if (_term.dead) return;
    /*
     * Do not promise reconnection after authorization rejection: no terminal was opened and
     * this path does not retry. Preserve the backend reason and report the failed connection.
     */
    const denied = e && (e.code === 4401 || e.code === 4403);
    try {
      t.writeln((window.SoduWorkI18n?.translateText || String)(denied
        ? '\r\n\x1b[31m—— 这次没连上（原因见上一行）。处理完再点「重开」 ——\x1b[0m'
        : '\r\n\x1b[90m—— 连接断开（后端那个终端还在跑）。切回这一栏会自动接回去 ——\x1b[0m'));
    } catch (err) {}
  };
  /*
   * During the initial 1.2 seconds, suppress only ESC[...c and ESC[...R capability/cursor
   * replies so ConPTY does not interpret them as shell input. Preserve later keystrokes.
   */
  const t0 = Date.now();
  const isReply = (d) => /^\x1b\[[?>]?[\d;]*[cR]$/.test(d);
  t.onData(d => {
    if (ws.readyState !== 1) return;
    if (Date.now() - t0 < 1200 && isReply(d)) return;
    ws.send(JSON.stringify({ t: 'i', d: d }));
  });
  /* Refit the terminal when panel size changes, including window and monitor changes. */
  try {
    _term.ro = new ResizeObserver(() => _termFit());
    _term.ro.observe(box);
  } catch (e) {}
  setTimeout(() => { try { t.focus(); } catch (e) {} }, 60);
}

function _termMarkMode() {
  document.querySelectorAll('[data-tmode]').forEach(b =>
    b.classList.toggle('is-on', b.getAttribute('data-tmode') === _term.mode));
}

function _termStop() {
  try { if (_term.ro) _term.ro.disconnect(); } catch (e) {}
  try { if (_term.ws) _term.ws.close(); } catch (e) {}
  try { if (_term.t) _term.t.dispose(); } catch (e) {}
  const m = _term.mode;
  _term = { t: null, ws: null, ro: null, tid: '', dead: false, mode: m };
}

/* Reopening terminates the backend terminal and child processes before creating a replacement. */
async function _termRestart() {
  try { await SoduWorkAPI.termClose(_con.tid); } catch (e) {}
  _termStop();
  setTimeout(_termStart, 250);
}

function _bindConsole() {
  const p = document.getElementById('aiConsolePanel');
  if (!p) return;
  p.querySelectorAll('[data-ctab]').forEach(b =>
    b.addEventListener('click', () => _conSetTab(b.getAttribute('data-ctab'))));
  const on = (sel, fn) => {
    const b = p.querySelector(sel);
    if (b) b.addEventListener('click', () => fn(b));
  };
  on('[data-act="con-close"]', closeConsole);
  on('[data-act="con-stop"]', (b) => _conStopClick(b));
  on('[data-act="term-new"]', _termRestart);
  on('[data-act="copy-dir"]', _conCopyDir);
  p.querySelectorAll('[data-tmode]').forEach(b => b.addEventListener('click', () => {
    const m = b.getAttribute('data-tmode');
    if (m === _term.mode) return;
    _term.mode = m;
    _termMarkMode();
    _termStop();          /* Terminal modes have separate backend instances and do not replace each other. */
    _term.mode = m;
    _termStart();
  }));
  _termMarkMode();
  on('[data-act="con-follow"]', (b) => {
    _con.follow = !_con.follow;
    b.classList.toggle('is-on', _con.follow);
    if (_con.follow) {
      const box = document.getElementById('conBody');
      if (box) box.scrollTop = box.scrollHeight;
    }
  });
  const send = async () => {
    const inp = document.getElementById('conSay');
    const txt = ((inp || {}).value || '').trim();
    if (!txt) return;
    inp.value = '';
    const box = document.getElementById('conBody');
    if (box && _con.tab === 'live') {
      /* Keep at in ISO timestamp format; _conRowHtml extracts time with slice(11,19). */
      box.insertAdjacentHTML('beforeend', _conRowHtml({
        kind: 'sys', tool: '你说', text: txt,
        at: '0000-00-00T' + new Date().toTimeString().slice(0, 8),
      }));
      box.scrollTop = box.scrollHeight;
    }
    try {
      const r = await SoduWorkAPI.aiSay(_con.tid, txt);
      if (r && r.queued && typeof petSay === 'function') {
        petSay('它这轮还在跑，你这句排在后面，跑完立刻接上~');
      }
    } catch (e) {
      if (typeof petSay === 'function') {
        petSay(typeof _humanErr === 'function' ? _humanErr(e, '没发出去') : '没发出去');
      }
    }
  };
  on('[data-act="con-say"]', send);
  const inp = document.getElementById('conSay');
  if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  /*
   * Disable following when the user scrolls upward and restore it at the bottom; polling
   * must not interrupt history reading.
   */
  const box = document.getElementById('conBody');
  if (box) {
    box.addEventListener('scroll', () => {
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      if (_con.follow !== atBottom) {
        _con.follow = atBottom;
        const b = p.querySelector('[data-act="con-follow"]');
        if (b) b.classList.toggle('is-on', atBottom);
      }
    });
  }
  if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.con-head'));
}
