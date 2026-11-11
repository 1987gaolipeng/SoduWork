/* Skin manager UI, loaded only by the workspace in desk.html.
   Shared skin state and application helpers live in skin-model.js, which both windows load.
   Remote loading is asynchronous and falls back safely on failure; avoid transition:all. */

/* ---------- Group definitions ---------- */
function _getSections() {
  /*
   * Combine built-in skins into one grid group to avoid sparse per-character sections.
   */
  const builtin = [{ key: '__builtin__', title: '内置皮肤', hint: '点击切换', builtin: true }];
  /* Create separate groups for new remote characters. */
  if (typeof SkinRegistry !== 'undefined') {
    const remoteSkins = SkinRegistry.getSkins().filter(s => s._remote);
    const remoteChars = Array.from(new Set(remoteSkins.map(s => s.character)));
    const known = new Set(builtin.map(b => b.key));
    remoteChars.forEach(ch => {
      if (!known.has(ch)) {
        const sample = remoteSkins.find(s => s.character === ch);
        builtin.push({ key: ch, title: sample.charName || ch, hint: '云端角色', remote: true });
      }
    });
    /* Private skins with owner=mine. */
    const mineSkins = remoteSkins.filter(s => s._owner === 'mine');
    if (mineSkins.length > 0) {
      builtin.push({ key:'__mine__', title:'我的皮肤', hint:'仅我可见', mine: true, aggregate: true });
    }
    /* Public cloud skins with owner=shared. */
    const sharedRemote = remoteSkins.filter(s => s._owner === 'shared');
    if (sharedRemote.length > 0) {
      builtin.push({ key:'__shared__', title:'公共云端', hint:'所有人共享', shared: true, aggregate: true });
    }
  }
  return builtin;
}
const SKIN_SECTIONS = _getSections();

/* Render the skin grid. */
function renderSkinGrid() {
  const body = document.getElementById('skinBody');
  if (!body) return;
  const curId = currentSkinId();
  const sections = _getSections();
  let html = '';
  sections.forEach(sec => {
    let list;
    if (sec.mine) {
      list = _getSkins().filter(s => s._owner === 'mine');
    } else if (sec.shared) {
      list = _getSkins().filter(s => s._owner === 'shared');
    } else if (sec.aggregate) {
      list = _getSkins().filter(s => s._remote);
    } else if (sec.remote) {
      list = _getSkins().filter(s => s.character === sec.key && s._remote);
    } else if (sec.builtin) {
      list = _getSkins().filter(s => !s._remote);
    } else {
      list = _getSkins().filter(s => s.character === sec.key && !s._remote);
    }
    if (list.length === 0) return;
    html += '<div class="skin-section">';
    /*
     * Keep the separator and hint in separate text nodes so exact-node translation can resolve
     * the hint.
     */
    html += '<div class="skin-section-title">' + esc(sec.title) +
      '<span class="hint">· <span>' + esc(sec.hint) + '</span></span></div>';
    html += '<div class="skin-grid">';
    list.forEach(s => { html += renderSkinCard(s, curId); });
    html += '</div></div>';
  });
  body.innerHTML = html;
  /* Bind selection handlers. */
  body.querySelectorAll('.skin-card').forEach(card => {
    card.addEventListener('click', () => {
      applySkin(card.getAttribute('data-id'));
    });
  });
}

/* Map palette IDs to display labels; show unknown values unchanged. */
const _PALETTE_LABEL = { vivid: '活力', steady: '稳重', warm: '暖调', minimal: '极简', ruby: '宝石红', azure: '扁平蓝', signature: 'SoduWork', enlarged: '放大' };

/* Render one skin card. */
function renderSkinCard(s, curId) {
  const active = s.id === curId;
  const tubeStyles = (typeof SkinRegistry !== 'undefined') ? SkinRegistry.getTubeStyles() : TUBE_STYLES;
  const ts = tubeStyles[s.tube] || tubeStyles.glass;
  const dark = s.bg && (s.bg.indexOf('#1a') >= 0 || s.bg.indexOf('#2a') >= 0);
  const darkCls = dark ? ' dark-bg' : '';
  const remoteCls = s._remote ? ' remote' : '';
  const mineCls = s._owner === 'mine' ? ' mine' : '';

  /* Distinguish owned and public cloud skins. */
  const ownerBadge = s._owner === 'mine'
    ? '<span class="sp-mine-badge">我的</span>'
    : (s._remote ? '<span class="sp-cloud-badge">☁</span>' : '');

  /*
   * Use localized PNG previews for built-in skins, falling back to the Chinese image when
   * missing. Remote or unknown characters retain the abstract preview.
   */
  const hasShot = !s._remote && !!s.shot;   /* Load the character's PNG preview and fall back on image errors. */
  const shotFile = s.shotFile || s.character;
  const locale = (typeof SoduWorkI18n !== 'undefined' && typeof SoduWorkI18n.getLocale === 'function') ? SoduWorkI18n.getLocale() : 'zh-CN';
  const shotSrc = (locale !== 'zh-CN')
    ? 'components/skin-manager/previews/' + esc(locale) + '/' + esc(shotFile) + '.png'
    : 'components/skin-manager/previews/' + esc(shotFile) + '.png';
  const shotFallback = "if(this.dataset.fallback){this.src=this.dataset.fallback;this.removeAttribute('data-fallback');}" +
    "else{this.parentElement.classList.add('shot-fail')}";
  let preview;
  if (s.previewType === 'logo') {
    preview = '<div class="skin-preview soduwork-logo-preview">' +
      '<img src="icon.png" alt="" draggable="false">' + ownerBadge + '</div>';
  } else if (s.previewType === 'soduwork') {
    preview =
    '<div class="skin-preview soduwork-card-preview" aria-label="SoduWork 品牌伙伴预览">' +
      '<div class="sp-soduwork-stage"><img class="sp-soduwork-frame" src="assets/pet-skins/soduwork-actions/working/frame-01.png" alt="" onerror="this.parentElement.classList.add(\'frame-fail\')"><b class="sp-soduwork-status"></b></div>' +
      '<span class="sp-soduwork-caption">随任务状态播放动作</span>' +
      ownerBadge +
    '</div>';
  } else if (hasShot) {
    preview =
    '<div class="skin-preview shot">' +
      '<img class="sp-shot" style="object-position:' + esc(s.shotPosition || 'center top') + '" src="' + shotSrc + '"' +
      (locale !== 'zh-CN' ? ' data-fallback="components/skin-manager/previews/' + esc(shotFile) + '.png"' : '') +
      ' onerror="' + esc(shotFallback) + '" alt="' + esc(s.name) + '">' +
      ownerBadge +
    '</div>';
  } else {
    preview =
    '<div class="skin-preview' + darkCls + '" style="background:' + s.bg + '">' +
      '<div class="sp-bear" style="background:' + s.bearColor + '"></div>' +
      '<div class="sp-tube" style="background:' + s.tubeColor + ';box-shadow:0 0 12px ' + ts.glow + '"></div>' +
      '<span class="sp-char-label">' + esc(s.character) + '</span>' +
      "<span class=\"sp-tube-label\">" + esc(ts.name) + '</span>' +
      ownerBadge +
    '</div>';
  }

  /* Skin information. */
  const tags = '<div class="skin-tags">' +
    '<span class="si-tag">' + esc(_PALETTE_LABEL[s.palette] || s.palette) + '</span>' +
    (s._owner === 'mine' ? '<span class="si-tag t-mine">我的</span>' : (s._remote ? '<span class="si-tag t-cloud">公共</span>' : '')) +
    '</div>';

  const info =
  '<div class="skin-info">' +
    "<div class=\"si-name\"" + (s._remote ? ' data-user-content' : '') + '>' + esc(s.name) + '</div>' +
    '<div class="si-desc">' + esc(s.desc || '') + '</div>' +
    tags +
  '</div>';

  return '<div class="skin-card' + (active ? ' active' : '') + remoteCls + mineCls + '" data-id="' + s.id + '">' +
  preview + info + '</div>';
}

/* Position near the pet when it exists; otherwise retain CSS centering in the workspace. */
function placeNearPet(el) {
  if (!el || !pet) return;
  const pr = pet.getBoundingClientRect();
  const ew = el.offsetWidth || 580;
  const eh = el.offsetHeight || 480;
  let left = pr.left - ew - 16;
  if (left < 12) left = pr.right + 16;
  if (left + ew > window.innerWidth - 12) left = Math.max(12, (window.innerWidth - ew) / 2);
  let top = pr.top + pr.height / 2 - eh / 2;
  if (top < 12) top = 12;
  if (top + eh > window.innerHeight - 12) top = window.innerHeight - eh - 12;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.transform = 'scale(.88)';
  el.style.transformOrigin = 'left center';
  requestAnimationFrame(() => {
  el.style.transform = 'scale(1)';
  });
}

/* Open and close. */
/* Refresh open previews on locale changes because image sources are outside text-translation observation. */
window.addEventListener('soduwork-locale-change', () => {
  const sm = document.getElementById('skinManager');
  if (sm && sm.classList.contains('show')) renderSkinGrid();
});

function openSkinManager() {
  const sm = document.getElementById('skinManager');
  if (!sm) return;
  renderSkinGrid();
  sm.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  /*
   * Dock positioning applies only to the desktop overlay. Workspace windows have no pet and
   * use a no-op placement helper, retaining CSS centering.
   */
  if (typeof placeDockPopup === 'function') placeDockPopup(sm); else placeNearPet(sm);
}
function closeSkinManager() {
  const sm = document.getElementById('skinManager');
  if (!sm) return;
  sm.classList.remove('show');
  sm.style.transform = '';
  sm.style.transformOrigin = '';
  if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
}
