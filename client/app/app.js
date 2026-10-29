/*
 * Desktop-pet entry point: initialization, global errors, and team capability checks. Load
 * only in index.html; recurring-task inspection, update checks, notifyReady, and greetings
 * must run once. desk.html loads shared components/settings/settings.js instead. Uses the
 * existing shared task, configuration, theme, rendering, and pet globals. Avoid
 * transition:all and throttle frequent events with requestAnimationFrame.
 */

/* Global error handling. */
window.__errLog = [];
window.addEventListener('error', e => {
  window.__errLog.push((e.message || 'Error') + ' @ ' + (e.filename || '').split('/').pop() + ':' + (e.lineno || '?'));
});
window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  window.__errLog.push('Promise: ' + (r && (r.message || r) || 'unknown'));
});

/*
 * Shared settings bindings and scale/workspace configuration live in
 * components/settings/settings.js, loaded by both windows. desk.html must not load this
 * file's once-only initialization.
 */

/*
 * Merge late Hub data immediately, but defer rendering until input ends to preserve focus
 * and drafts.
 */
let _initialPaintDone = false;
let _hydrationPaintPending = false;
function _isEditingNow() {
  const el = document.activeElement;
  return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}
function _paintHydratedStore() {
  if (!_initialPaintDone) return;               // Initial rendering reads the latest data directly.
  if (_isEditingNow()) { _hydrationPaintPending = true; return; }
  _hydrationPaintPending = false;
  if (typeof applyTheme === 'function') applyTheme();
  if (typeof applyRemind === 'function') applyRemind();
  if (typeof applyShape === 'function') applyShape();
  if (typeof renderSoon === 'function') renderSoon();
  else if (typeof render === 'function') render();
  if (typeof updatePet === 'function') updatePet();
  if (typeof _syncSidebar === 'function') _syncSidebar();
}
window.addEventListener('soduwork-store-hydrated', _paintHydratedStore);
window.addEventListener('soduwork-config-hydrated', _paintHydratedStore);
document.addEventListener('focusout', () => {
  if (_hydrationPaintPending) setTimeout(_paintHydratedStore, 0);
});

/* Initialize the desktop-pet window. */
(async function init() {
  try {
    await initData();
  } catch (e) {
    window.__errLog.push('initData: ' + (e && e.message || e));
  }
  /* Load actual tasks for the current identity; keep demo data in isolated test fixtures. */
  let taskMigrated = false, cfgMigrated = false;
  /* Migrate legacy task fields. */
  tasks.forEach(t => {
    if (t.handler === undefined) { t.handler = 'me'; taskMigrated = true; }
  });
  /* Populate the legacy tube configuration from the matching skin. */
  if (!cfg.tube && typeof SKINS !== 'undefined' && typeof currentSkinId === 'function') {
    const sk = SKINS.find(s => s.id === currentSkinId());
    if (sk) { cfg.tube = sk.tube; cfgMigrated = true; }
  }
  /*
   * Fall back to the built-in bear when the configured remote character is unavailable.
   */
  if (cfg.character) {
    const builtinChars = ['bear', 'box', 'cat', 'robot', 'drop', 'orb'];
    if (!builtinChars.includes(cfg.character)) {
      const hasChar = (typeof SkinRegistry !== 'undefined') ? SkinRegistry.hasCharacter(cfg.character) : false;
      if (!hasChar) {
        cfg.character = 'bear';
        cfg._lastSkinId = 'bear-vivid';
        cfgMigrated = true;
      }
    }
  }
  /*
   * Persist only actual migrations. Routine startup must not overwrite newer server
   * configuration with stale local data.
   */
  if (taskMigrated) save();
  if (cfgMigrated) saveCfg();
  if (typeof applyTheme === 'function') applyTheme();
  /* Synchronize active states on settings segment buttons. */
  if (typeof _syncSeg === 'function') {
    _syncSeg('remindSeg', 'remind', cfg.remind);
    _syncSeg('scaleSeg', 'scale', cfg.uiScale);
    _syncSeg('fontSeg', 'font', cfg.fontScale || 'medium');
  }
  /* Restore the pet position. */
  if (cfg.hubX != null && typeof setPetPos === 'function') setPetPos(cfg.hubX, cfg.hubY);
  /* Render the initial view. */
  if (typeof render === 'function') render();
  _initialPaintDone = true;
  /* Show the greeting. */
  setTimeout(() => { if (typeof petSay === 'function') petSay('我是 SoduWork～\n点右侧竖条打开需求池', 3500); }, 900);

  /* Notify the main process that rendering is ready and cancel the fifteen-second startup timeout. */
  if (window.soduWorkAPI && window.soduWorkAPI.notifyReady) {
    try { window.soduWorkAPI.notifyReady(); } catch (e) {}
  }

  /*
   * Probe team-management capability to control navigation. Retry if Hub starts later; null
   * means unknown and keeps the entry hidden.
   */
  _probeTeamCap(0);
  /* Refresh inbox badges with one lightweight capability probe every two minutes. */
  setInterval(() => _probeTeamCap(3), 120000);

  /* Check recurring tasks at startup and every minute; due completed tasks return to pending. */
  if (typeof _tickRecur === 'function') { _tickRecur(); setInterval(_tickRecur, 60000); }

  /*
   * Check client updates at startup, every six hours, and after reconnection. Show native
   * confirmation only after validating a new installer.
   */
  const checkClientUpdate = () => {
    if (typeof _otaUpdate === 'function') void _otaUpdate(true);
  };
  setTimeout(checkClientUpdate, 8000);
  setInterval(checkClientUpdate, 6 * 60 * 60 * 1000);
})();

async function _probeTeamCap(attempt) {
  if (!(window.SoduWorkAPI && SoduWorkAPI.getTeamCapability)) return;
  let cap = null;
  try { cap = await SoduWorkAPI.getTeamCapability(); } catch (e) { cap = null; }
  if (cap) { if (typeof setTeamCap === 'function') setTeamCap(cap); return; }
  if (attempt < 3) setTimeout(() => _probeTeamCap(attempt + 1), 4000);   /* Retry while the backend is unavailable. */
}
