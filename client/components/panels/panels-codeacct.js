













let _caData = null;                 /* {git:{…}, repos:[…]} */
let _caEdit = {};                   /* Unsaved field edits. */
let _caKind = '';                   /* Selected credential type: token or ssh. */
let _caTest = null;                 /* {state:'ing'|'ok'|'bad', detail} */
let _caUrl = '';                    /* Repository used for credential testing. */
let _caOpen = '';                   /* Identity, credential, and test sections start collapsed. */
let _caOwner = '', _caEpoch = 0, _caLoadSeq = 0;
let _caSaving = null, _caTesting = null;
let _caEditRevision = 0;
const _caPendingOps = new Map();
function _caBeginOperation(kind, operation) {
  const pending = _caPendingOps.get(operation.owner) || {};
  pending[kind] = operation; _caPendingOps.set(operation.owner, pending);
  if (kind === 'save') _caSaving = operation; else _caTesting = operation;
}
function _caEndOperation(kind, operation) {
  const pending = _caPendingOps.get(operation.owner);
  if (pending?.[kind] === operation) delete pending[kind];
  if (pending && !pending.save && !pending.test) _caPendingOps.delete(operation.owner);
  if (_caOwner === operation.owner) {
    _caSaving = pending?.save || null; _caTesting = pending?.test || null;
  }
}
const _caOwnerKey = () => String(window.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
function _caSyncOwner() {
  const owner = _caOwnerKey();
  if (owner === _caOwner) return;
  _caOwner = owner; _caEpoch++; _caLoadSeq++;
  _caData = null; _caEdit = {}; _caTest = null; _caUrl = ''; _caOpen = ''; _caKind = '';
  const pending = _caPendingOps.get(owner);
  _caSaving = pending?.save || null; _caTesting = pending?.test || null;
  _caEditRevision++;
  const box = document.getElementById('caBody');
  if (box) box.replaceChildren();
  _caMark();
  return true;
}
const _caCurrent = (epoch, owner) => epoch === _caEpoch && owner === _caOwnerKey();
window.addEventListener('soduwork-device-auth', () => {
  if (_caSyncOwner() && document.getElementById('caPanel')?.classList.contains('show')) void _caLoad();
});

const _CA_ICON = '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>' +
  '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>';

function openCodeAcctPanel() {
  _caSyncOwner();
  let p = document.getElementById('caPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'caPanel'; p.className = 'sch-panel cfg-panel';
    p.innerHTML =
      '<div class="sch-head ws-page-head">' +
      '<span class="sch-h-ico">' + _CA_ICON + '</span>' +
      '<div class="sch-h-txt"><span class="sch-h-kicker" data-i18n="eyebrow.source_control">SOURCE CONTROL</span><b class="sch-h-title">代码账号</b>' +
      '<i class="sch-h-sub">管理提交署名与仓库推送权限</i></div>' +
      '<div class="sch-h-acts">' +
      '<button class="btn-mini primary" id="caSave" disabled>保存</button>' +
      '<button class="np-close" id="caClose">✕</button></div></div>' +
      '<div class="sch-body" id="caBody"></div>';
    document.body.appendChild(p);
    document.getElementById('caClose').addEventListener('click', closeCodeAcctPanel);
    document.getElementById('caSave').addEventListener('click', _caSave);
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.sch-head'));
  }
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  _caLoad();
}

function closeCodeAcctPanel() {
  _caEpoch++; _caLoadSeq++;
  const p = document.getElementById('caPanel');
  if (p) p.classList.remove('show');
  if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
}

async function _caLoad() {
  _caSyncOwner();
  const box = document.getElementById('caBody');
  if (!box) return;
  const seq = ++_caLoadSeq, epoch = _caEpoch, owner = _caOwner;
  if (!_caData) box.innerHTML = '<div class="ag-load"><i></i><i></i><i></i><span>正在读…</span></div>';
  let r = null;
  try { r = await SoduWorkAPI.myGit(); } catch (e) { r = null; }
  if (seq !== _caLoadSeq || !_caCurrent(epoch, owner) ||
      document.getElementById('caBody') !== box || !document.getElementById('caPanel')?.classList.contains('show')) return;
  if (!r || !r.git || typeof r.git !== 'object' || Array.isArray(r.git)) {
    box.innerHTML = '<div class="ag-blank">' + _CA_ICON +
      '<b>没连上后台</b><span>代码账号存在服务端（干活的执行器在那头），连上才能配。</span>' +
      '<button class="btn-mini" id="caRetry">重试</button></div>';
    const rb = document.getElementById('caRetry');
    if (rb) rb.addEventListener('click', _caLoad);
    return;
  }
  _caData = r;
  if (!_caTesting) _caTest = null;
  if (!['identity', 'token', 'ssh', 'test'].includes(_caOpen)) _caOpen = 'identity';
  _caKind = r.git.keySet ? 'ssh' : 'token';
  if (!_caUrl) _caUrl = ((r.repos || [])[0] || {}).url || '';
  // Refreshes may finish while the user is typing. Keep their field nodes,
  // caret and draft; a later deliberate section switch uses the fresh data.
  if (box.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) _caMark();
  else _caRender();
}

/* Prefer current edits over the last server values. */
function _caVal(f) {
  return (f in _caEdit) ? (_caEdit[f] || '') : String((_caData.git || {})[f] || '');
}

function _caRender() {
  const box = document.getElementById('caBody');
  if (!box || !_caData) return;
  const g = _caData.git || {};
  const repos = _caData.repos || [];
  const name = _caVal('name'), email = _caVal('email');
  const tokenSet = ('token' in _caEdit) ? !!_caEdit.token : !!g.tokenSet;
  const keySet = ('key' in _caEdit) ? !!_caEdit.key : !!g.keySet;
  const identityReady = !!(name && email);
  const credentialReady = tokenSet || keySet;
  const okAll = identityReady && credentialReady && !_caDirty();
  const selected = ['identity', 'token', 'ssh', 'test'].includes(_caOpen) ? _caOpen : 'identity';
  _caOpen = selected;

  box.innerHTML = '<div class="cfg-master-detail ca-master-detail">' +
    '<aside class="cfg-master ca-master" aria-label="代码账号设置">' +
      '<div class="cfg-master-head"><span data-i18n="eyebrow.source_control">SOURCE CONTROL</span>' +
        '<strong>' + esc(name || '代码提交身份') + '</strong>' +
        '<small>' + esc(email || '设置提交署名和仓库推送凭据') + '</small>' +
        '<span class="cfg-state ca-master-state ' + (okAll ? 'is-ready' : (_caDirty() ? 'is-dirty' : 'is-warn')) + '">' +
          (okAll ? '可以提交' : (_caDirty() ? '有未保存改动' : '待完善')) + '</span></div>' +
      '<nav class="cfg-master-scroll ca-nav">' +
        _caNavItem('identity', '提交身份', name && email ? name : '姓名与邮箱', identityReady ? '已填写' : '待填写', identityReady ? 'ready' : 'warn') +
        _caNavItem('token', 'HTTPS 令牌', 'GitLab、GitHub 与兼容仓库', tokenSet ? '已配置' : '未配置', tokenSet ? 'ready' : 'neutral') +
        _caNavItem('ssh', 'SSH 私钥', '仅开放 SSH 的仓库', keySet ? '已配置' : '未配置', keySet ? 'ready' : 'neutral') +
        _caNavItem('test', '连通测试', _caUrl ? _caRepoName(repos, _caUrl) : '选择仓库验证',
          _caTest && _caTest.state === 'ok' ? '已通过' : '待验证', _caTest ? _caTest.state : 'neutral') +
      '</nav>' +
      '<div class="cfg-master-foot">凭据跟随任务归属人使用，不受执行机器位置影响。</div>' +
    '</aside>' +
    '<main class="cfg-detail ca-detail" aria-live="polite">' + _caDetailHtml(selected, {
      g, repos, name, email, tokenSet, keySet, identityReady, credentialReady
    }) + '</main></div>';

  _caBind(box);
  _caMark();
}

function _caNavItem(key, title, summary, stateText, state) {
  const selected = _caOpen === key;
  const icon = { identity: 'ID', token: 'TK', ssh: 'SH', test: '✓' }[key] || '·';
  return '<button type="button" class="cfg-nav-item ca-nav-item' + (selected ? ' is-selected' : '') +
    '" data-caopen="' + key + '" aria-pressed="' + (selected ? 'true' : 'false') + '">' +
      '<span class="ca-nav-icon">' + icon + '</span><span class="cfg-nav-copy"><b>' + title + '</b><small>' +
        esc(summary) + '</small></span><span class="cfg-state is-' + state + '">' + stateText + '</span></button>';
}

function _caDetailHead(kicker, title, note, stateText, state) {
  return '<header class="cfg-detail-head"><span class="cfg-detail-icon">' + _CA_ICON + '</span>' +
    '<div class="cfg-detail-title"><span>' + kicker + '</span><h2>' + title + '</h2><p>' + note + '</p></div>' +
    '<span class="cfg-state is-' + state + '">' + stateText + '</span></header>';
}

function _caDetailHtml(selected, ctx) {
  const { g, repos, name, email, tokenSet, keySet, identityReady } = ctx;
  if (selected === 'identity') {
    return _caDetailHead('COMMIT IDENTITY', '提交身份', '每条 AI 代码提交都会使用这里的作者姓名与邮箱。',
      identityReady ? '已填写' : '待填写', identityReady ? 'ready' : 'warn') +
      '<div class="cfg-detail-scroll"><section class="cfg-detail-section"><header><b>作者信息</b><span>会写入 Git author 与 committer</span></header>' +
        '<div class="ca-grid"><label class="ca-f"><span>姓名</span><input class="sch-in" data-cf="name" value="' +
          esc(name) + '" placeholder="张三" maxlength="60"></label>' +
        '<label class="ca-f"><span>邮箱</span><input class="sch-in" data-cf="email" value="' +
          esc(email) + '" placeholder="zhangsan@公司域名" maxlength="120"></label></div>' +
        (name && email ? '<div class="ca-preview">提交记录预览 <code>' + esc(name) + ' &lt;' + esc(email) + '&gt;</code></div>' :
          '<div class="ca-preview is-empty">填写姓名和邮箱后，这里会显示代码提交中的作者信息。</div>') +
      '</section><div class="cfg-detail-callout"><b>按任务归属人署名</b><span>任务转交给谁，提交就使用谁保存的身份，而不是执行机器上的默认 Git 配置。</span></div></div>';
  }
  if (selected === 'token') {
    return _caDetailHead('HTTPS ACCESS', 'HTTPS 令牌', '适用于 GitLab、GitHub 和支持个人访问令牌的仓库。',
      tokenSet ? '已配置' : '未配置', tokenSet ? 'ready' : 'neutral') +
      '<div class="cfg-detail-scroll"><section class="cfg-detail-section"><header><b>访问凭据</b><span>保存后只显示长度，不回显明文</span></header>' +
        _caTokenHtml(g) + '</section>' + _caSecretNote() + '</div>';
  }
  if (selected === 'ssh') {
    return _caDetailHead('SSH ACCESS', 'SSH 私钥', '适用于仅开放 SSH 或使用部署密钥的仓库。',
      keySet ? '已配置' : '未配置', keySet ? 'ready' : 'neutral') +
      '<div class="cfg-detail-scroll"><section class="cfg-detail-section"><header><b>私钥内容</b><span>需要完整、无口令的 OpenSSH 私钥</span></header>' +
        _caSshHtml(g) + '</section>' + _caSecretNote() + '</div>';
  }
  const testState = _caTest ? _caTest.state : 'neutral';
  return _caDetailHead('CONNECTION CHECK', '连通测试', '对选定仓库执行只读探测，确认身份与凭据可以真实工作。',
    _caTest && _caTest.state === 'ok' ? '已通过' : '待验证', testState) +
    '<div class="cfg-detail-scroll"><section class="cfg-detail-section"><header><b>测试仓库</b><span>不会修改远端内容</span></header>' +
      '<div class="ca-testrow">' +
        (repos.length ? '<select class="sch-in ca-sel" id="caRepo">' + repos.map((r) => '<option value="' +
          esc(r.url) + '"' + (r.url === _caUrl ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') +
          '<option value="__custom__"' + (_caUrlIsCustom(repos) ? ' selected' : '') + '>其它地址…</option></select>' : '') +
        ((!repos.length || _caUrlIsCustom(repos)) ? '<input class="sch-in" id="caUrl" value="' + esc(_caUrl) +
          '" placeholder="HTTPS 或 SSH 仓库地址">' : '') +
        '<button class="btn-mini primary" id="caTest"' + (_caTesting ? ' disabled' : '') + '>测一下</button></div>' +
        (_caTest ? '<div class="ca-test-r is-' + _caTest.state + '">' +
          (_caTest.state === 'ing' ? '正在连接仓库…' : esc(_caTest.detail || '')) + '</div>' : '') +
      '</section><div class="cfg-detail-callout"><b>测试顺序</b><span>先保存本页未提交的更改，再使用最新凭据读取仓库信息。</span></div></div>';
}

function _caSecretNote() {
  return '<div class="cfg-detail-callout is-secure"><b>凭据只写不读</b><span>留空不会覆盖现有内容；只有明确填写新值或点击删除，服务端才会更新。</span></div>';
}

function _caRepoName(repos, url) {
  const repo = (repos || []).find((r) => r.url === url);
  return repo ? repo.name : '自定义仓库';
}

function _caUrlIsCustom(repos) {
  return !!_caUrl && !repos.some(r => r.url === _caUrl);
}

function _caTokenHtml(g) {
  return '<div class="ca-pane">' +
    '<div class="ca-grid">' +
      '<label class="ca-f"><span>用户名</span>' +
        '<input class="sch-in" data-cf="user" value="' + esc(_caVal('user')) + '" ' +
        'placeholder="GitLab 登录名（GitHub 可留空）" maxlength="80"></label>' +
      '<label class="ca-f"><span>令牌</span>' +
        '<span class="ca-inrow">' +
        '<input class="sch-in" type="password" data-cf="token" autocomplete="new-password" value="' + esc(_caEdit.token || '') + '" ' +
        'placeholder="' + (g.tokenSet ? '已配 ' + g.tokenLen + ' 位，填新的才会替换' : '粘贴访问令牌') + '">' +
        '<button class="btn-mini" data-ceye="token">显示</button></span></label>' +
    '</div>' +
    (g.tokenSet
      ? '<div class="ca-meta"><span>已配 ' + g.tokenLen + ' 位</span>' +
        '<button class="md-link" data-cclear="token">删掉它</button></div>'
      : '') +
  '</div>';
}

function _caSshHtml(g) {
  return '<div class="ca-pane">' +
    '<label class="ca-f"><span>私钥全文</span>' +
      '<textarea class="sch-in ca-key" data-cf="key" rows="5" spellcheck="false" ' +
      'placeholder="' + (g.keySet ? '已配（' + esc(g.keyType || '私钥') + '），贴新的才会替换'
                                  : '-----BEGIN OPENSSH PRIVATE KEY-----\n…') + '">' + esc(_caEdit.key || '') + '</textarea>' +
    '</label>' +
    '<div class="ca-meta">' +
      (g.keySet
        ? '<span>已配 · ' + esc(g.keyType || '私钥') + ' · 摘要 ' + esc(g.keyFp || '') + '</span>' +
          '<button class="md-link" data-cclear="key">删掉它</button>'
        /* This renderer constructs HTML; use elements rather than literal Markdown emphasis. */
        : '<span>要贴「私钥」全文（不是 .pub 公钥），而且必须是不带口令的那种</span>') +
    '</div>' +
    '<div class="ca-hint">摘要是 SoduWork 自己算的短哈希，只用来认"是不是我贴的那把"，' +
      '不是 ssh 显示的那个指纹。</div>' +
  '</div>';
}

function _caDirty() { return Object.keys(_caEdit).length > 0; }

function _caMark() {
  const test = document.getElementById('caTest');
  if (test) test.disabled = Boolean(_caSaving || _caTesting);
  if (!_caTest) document.querySelector('#caBody .ca-test-r')?.remove();
  const btn = document.getElementById('caSave');
  if (!btn) return;
  btn.disabled = Boolean(_caSaving || _caTesting) || !_caDirty();
  btn.textContent = _caSaving ? '保存中…' : _caDirty() ? '保存' : '已保存';
}

function _caBind(box) {
  box.querySelectorAll('[data-caopen]').forEach((el) => el.addEventListener('click', () => {
    const key = el.getAttribute('data-caopen');
    _caOpen = key;
    if (key === 'token' || key === 'ssh') _caKind = key;
    _caRender();
  }));

  box.querySelectorAll('[data-cf]').forEach(el => el.addEventListener('input', () => {
    _caEditRevision++;
    if (!_caTesting) _caTest = null;
    const f = el.getAttribute('data-cf');
    /* Blank secret fields leave stored credentials unchanged; unrelated edits must not require re-entering a token. */
    if ((f === 'token' || f === 'key') && !el.value) delete _caEdit[f];
    else _caEdit[f] = el.value;
    _caMark();
    const pv = box.querySelector('.ca-preview');
    if (pv && (f === 'name' || f === 'email')) {
      const n = _caVal('name'), m = _caVal('email');
      pv.className = 'ca-preview' + (n && m ? '' : ' is-empty');
      pv.innerHTML = n && m
        ? '提交记录里会长这样：<code>' + esc(n) + ' &lt;' + esc(m) + '&gt;</code>'
        : '填完上面两格，这里会显示提交记录里的样子';
    }
  }));
  box.querySelectorAll('[data-ck]').forEach(el => el.addEventListener('click', () => {
    _caKind = el.getAttribute('data-ck');
    _caRender();
  }));
  box.querySelectorAll('[data-ceye]').forEach(el => el.addEventListener('click', () => {
    const inp = box.querySelector('[data-cf="' + el.getAttribute('data-ceye') + '"]');
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    el.textContent = show ? '隐藏' : '显示';
  }));
  box.querySelectorAll('[data-cclear]').forEach(el => el.addEventListener('click', () => {
    _caEditRevision++; if (!_caTesting) _caTest = null;
    _caEdit[el.getAttribute('data-cclear')] = null;      /* null explicitly deletes the credential. */
    el.textContent = '（保存后删掉）';
    el.disabled = true;
    _caMark();
  }));
  const sel = document.getElementById('caRepo');
  if (sel) sel.addEventListener('change', () => {
    _caEditRevision++;
    _caUrl = sel.value === '__custom__' ? '' : sel.value;
    _caTest = null;
    _caRender();
  });
  const url = document.getElementById('caUrl');
  if (url) url.addEventListener('input', () => {
    _caUrl = url.value.trim(); _caEditRevision++;
    if (!_caTesting) _caTest = null;
    _caMark();
  });
  const tb = document.getElementById('caTest');
  if (tb) tb.addEventListener('click', _caDoTest);
}

/*
 * Save pending changes before testing so the probe uses the newly entered credential.
 */
async function _caDoTest() {
  _caSyncOwner();
  if (_caSaving || _caTesting) return;
  if (!_caUrl) {
    if (typeof petSay === 'function') petSay('先挑一个仓库，或者贴个地址');
    return;
  }
  _caTest = { state: 'ing' };
  const epoch = _caEpoch, owner = _caOwner, url = _caUrl, revision = _caEditRevision;
  const operation = { epoch, owner }; _caBeginOperation('test', operation);
  _caRender();
  try {
    if (_caDirty()) {
      const submitted = { ..._caEdit };
      await SoduWorkAPI.saveMyGit(submitted);
      if (!_caCurrent(epoch, owner)) return;
      Object.keys(submitted).forEach(key => { if (_caEdit[key] === submitted[key]) delete _caEdit[key]; });
      const fresh = await SoduWorkAPI.myGit();
      if (!_caCurrent(epoch, owner)) return;
      _caData = fresh;
    }
    const r = await SoduWorkAPI.testMyGit(url);
    if (!_caCurrent(epoch, owner)) return;
    _caTest = url === _caUrl && revision === _caEditRevision ?
      { state: r && r.ok ? 'ok' : 'bad', detail: (r && r.detail) || '没测出结果' } : null;
  } catch (e) {
    if (!_caCurrent(epoch, owner)) return;
    _caTest = url === _caUrl && revision === _caEditRevision ? { state: 'bad',
                detail: (typeof _humanErr === 'function' ? _humanErr(e, '没测成') : '没测成') } : null;
  } finally {
    if (_caTesting === operation) {
      if (!_caCurrent(epoch, owner)) _caTest = null;
    }
    _caEndOperation('test', operation);
    if (_caCurrent(epoch, owner)) _caRender();
    else if (owner === _caOwnerKey()) _caMark();
  }
}

async function _caSave() {
  _caSyncOwner();
  if (_caSaving || _caTesting || !_caDirty()) return;
  const epoch = _caEpoch, owner = _caOwner, submitted = { ..._caEdit };
  const operation = { epoch, owner }; _caBeginOperation('save', operation);
  const btn = document.getElementById('caSave');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    await SoduWorkAPI.saveMyGit(submitted);
    if (!_caCurrent(epoch, owner)) return;
    Object.keys(submitted).forEach(key => { if (_caEdit[key] === submitted[key]) delete _caEdit[key]; });
    if (typeof petSay === 'function') petSay('代码账号存好了～');
    await _caLoad();
  } catch (e) {
    if (!_caCurrent(epoch, owner)) return;
    if (typeof petSay === 'function') {
      petSay(typeof _humanErr === 'function' ? _humanErr(e, '没存上') : '没存上');
    }
  } finally {
    _caEndOperation('save', operation);
    if (owner === _caOwnerKey()) _caMark();
  }
}
