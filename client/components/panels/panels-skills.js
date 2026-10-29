








let _skRows = null;
let _skEnabled = new Set();      /* Current UI selection. */
let _skSaved = new Set();        /* Last persisted selection; enable saving only when it differs. */
let _skRevoked = [];

/* Choose semantic skill icons from name keywords. */
const _SK_ICONS = {
  browser: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>',
  office: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  computer: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
  dflt: '<svg viewBox="0 0 24 24"><path d="M14.5 4.5a3.5 3.5 0 1 0 5 5L18 11l-5-5 1.5-1.5z"/><path d="M13 6L4.5 14.5 3 21l6.5-1.5L18 11"/></svg>',
};
function _skIcon(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('browser') || n.includes('web')) return _SK_ICONS.browser;
  if (n.includes('office') || n.includes('doc') || n.includes('xlsx') || n.includes('pptx')) return _SK_ICONS.office;
  if (n.includes('computer') || n.includes('desktop') || n.includes('screen')) return _SK_ICONS.computer;
  if (n.includes('check') || n.includes('review') || n.includes('delivery')) return _SK_ICONS.check;
  return _SK_ICONS.dflt;
}
/* Identify bundled, personal, and shared-harness skill sources. */
function _skSource(path) {
  const p = String(path || '').replace(/\\/g, '/');
  if (/\/\.claude\//.test(p)) return 'Claude Code 共用';
  if (/\/\.pi\//.test(p)) return 'Pi 自带位置';
  if (/\/\.agents\//.test(p)) return '通用目录';
  if (/AppData\/Local\/soduwork/i.test(p)) return '本机技能库';
  return 'SoduWork 自带';
}

function openSkillPanel() {
  let p = document.getElementById('skPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'skPanel'; p.className = 'sch-panel';          /* Reuse the shared panel shell. */
    p.innerHTML =
      '<div class="sch-head ws-page-head">' +
      '<span class="sch-h-ico">' + _SK_ICONS.dflt + '</span>' +
      '<div class="sch-h-txt"><span class="sch-h-kicker" data-i18n="eyebrow.capabilities">CAPABILITIES</span><b class="sch-h-title">我的技能</b>' +
      '<i class="sch-h-sub">勾上的，派活时会连同它的用法一起交给 AI</i></div>' +
      '<div class="sch-h-acts"><span class="sk-count" id="skCount"></span>' +
      '<button class="btn-mini primary" id="skSave" disabled>保存</button>' +
      '<button class="np-close" id="skClose">✕</button></div></div>' +
      '<div class="sch-body" id="skBody"></div>';
    document.body.appendChild(p);
    document.getElementById('skClose').addEventListener('click', closeSkillPanel);
    document.getElementById('skSave').addEventListener('click', _saveSkills);
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.sch-head'));
  }
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  _loadSkills();
}
function closeSkillPanel() {
  const p = document.getElementById('skPanel');
  if (p && p.classList.contains('show')) {
    p.classList.remove('show');
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
}

async function _loadSkills() {
  const body = document.getElementById('skBody');
  if (body && _skRows === null) body.innerHTML = '<div class="sch-msg">正在拿可用的技能…</div>';
  try {
    const r = await SoduWorkAPI.mySkills();
    _skRows = (r && r.skills) || [];
    _skEnabled = new Set((r && r.enabled) || []);
    _skSaved = new Set((r && r.enabled) || []);
    _skRevoked = (r && r.revoked) || [];
  } catch (e) { _skRows = []; }
  _renderSkills();
}

/* Enable saving only for actual changes and show selected/available counts. */
function _skSyncHead() {
  const btn = document.getElementById('skSave');
  const cnt = document.getElementById('skCount');
  const dirty = JSON.stringify([..._skEnabled].sort()) !== JSON.stringify([..._skSaved].sort());
  if (btn) { btn.disabled = !dirty; btn.textContent = dirty ? '保存' : '已保存'; }
  if (cnt) cnt.textContent = '已选 ' + _skEnabled.size + ' / 开放 ' + (_skRows || []).length;
}

function _renderSkills() {
  const body = document.getElementById('skBody');
  if (!body) return;
  const rows = _skRows || [];
  if (!rows.length) {
    /* Show an icon, a clear explanation, and a next action in the empty state. */
    body.innerHTML =
      '<div class="sk-empty"><span class="sk-empty-ico">' + _SK_ICONS.dflt + '</span>' +
      '<b>还没有可用的技能</b>' +
      '<span>技能是 AI 的能力包——查网页、做 Office 文档、按清单自检…<br>' +
      '需要管理员先在管理端「技能库」里<b>开放</b>，你这儿才能挑。</span></div>';
    _skSyncHead();
    return;
  }
  body.innerHTML =
    (_skRevoked.length
      ? '<div class="sk-revoked"><b>有 ' + _skRevoked.length + ' 个技能被收回了</b>' +
        '<span>你以前勾过 ' + _skRevoked.map(esc).join('、') + '，但管理员现在不开放了，派活时不会再带上。</span></div>'
      : '') +
    '<div class="sk-grid">' + rows.map(s => {
      const on = _skEnabled.has(s.name);
      return '<button class="sk-card' + (on ? ' on' : '') + '" data-name="' + esc(s.name) + '" ' +
        'aria-pressed="' + on + '" title="' + esc(s.path || '') + '">' +
        '<span class="sk-c-ico">' + _skIcon(s.name) + '</span>' +
        "<span class=\"sk-c-main\"><span class=\"sk-c-top\"><b data-user-content>" + esc(s.name) + '</b>' +
        '<em class="sk-c-src">' + esc(_skSource(s.path)) + '</em></span>' +
        "<i class=\"sk-c-desc\"" + (s.description ? ' data-user-content' : '') + '>' + esc(s.description || '') + '</i></span>' +
        '<span class="sk-c-mark">' + (on ? _SK_ICONS.check : '') + '</span></button>';
    }).join('') + '</div>' +
    /* Use HTML formatting here; Markdown markers would appear literally. */
    '<div class="sk-tip">勾上的技能只把<b>一句描述</b>放进 AI 的上下文；它判断用得上，才会去读完整用法。' +
    '所以勾几个不费事，但也别一股脑全勾——描述多了模型反而挑花眼。</div>';
  /* Make the whole card selectable and highlight it with a checkmark. */
  body.querySelectorAll('.sk-card').forEach(card => {
    card.addEventListener('click', () => {
      const name = card.getAttribute('data-name');
      const on = !_skEnabled.has(name);
      if (on) _skEnabled.add(name); else _skEnabled.delete(name);
      card.classList.toggle('on', on);
      card.setAttribute('aria-pressed', String(on));
      card.querySelector('.sk-c-mark').innerHTML = on ? _SK_ICONS.check : '';
      _skSyncHead();
    });
  });
  _skSyncHead();
}

async function _saveSkills() {
  const btn = document.getElementById('skSave');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    await SoduWorkAPI.setMySkills([..._skEnabled]);
    _skSaved = new Set(_skEnabled);
    _skSyncHead();
    if (typeof petSay === 'function') {
      petSay(_skEnabled.size ? '记住了，下次派活会带上这 ' + _skEnabled.size + ' 个技能~' : '好，这台 SoduWork 暂时不带技能');
    }
  } catch (e) {
    if (typeof petSay === 'function') petSay('没保存上：' + (typeof _humanErr === 'function' ? _humanErr(e, '保存失败') : e.message));
  }
  if (btn) { btn.disabled = false; btn.textContent = '保存'; }
}

window.openSkillPanel = openSkillPanel;
window.closeSkillPanel = closeSkillPanel;
