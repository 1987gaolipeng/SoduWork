/* Shared skin model for the overlay and workspace: catalog, current selection, and skin application.
   The workspace-only picker lives in skin-manager.js. Keep shared state available to startup migration,
   applyTheme(), and remote skin commands without loading the picker in the overlay. */

/* ---------- Compatibility aliases: retain TUBE_STYLES / SKINS for existing callers ---------- */
const TUBE_STYLES = (typeof SkinRegistry !== 'undefined')
  ? SkinRegistry.BUILTIN_TUBE_STYLES
  : {
      glass:   { name: '玻璃',   color: 'rgba(180,220,255,.55)', glow: 'rgba(180,220,255,.3)' },
      crystal: { name: '水晶',   color: 'rgba(200,230,255,.7)',  glow: 'rgba(220,240,255,.5)' },
      bamboo:  { name: '竹节',   color: '#c8b78a',               glow: 'rgba(200,183,138,.4)' },
      neon:    { name: '霓虹',   color: '#3a3a4a',               glow: 'rgba(255,90,180,.6)' },
      ink:     { name: '水墨',   color: '#2a2a35',               glow: 'rgba(80,80,100,.3)' }
    };

/* Proxy SKINS to the latest registry, including remote entries, and forward array methods. */
function _getSkins() {
  if (typeof SkinRegistry !== 'undefined') return SkinRegistry.getSkins();
  return [];
}
const SKINS = new Proxy({}, {
  get(_, prop) {
    const arr = _getSkins();
    if (prop === 'length') return arr.length;
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return arr[Number(prop)];
    /* Forward array operations such as find, filter, map, and reduce. */
    if (typeof arr[prop] === 'function') return arr[prop].bind(arr);
    return arr[prop];
  }
});

/* Current skin ID. */
function currentSkinId() {
  const ch = cfg.character || 'soduwork';
  const pal = cfg.theme || 'vivid';
  const tube = cfg.tube || 'glass';
  const skins = _getSkins();
  const exact = skins.find(s => s.character === ch && s.palette === pal && s.tube === tube);
  if (exact) return exact.id;
  const partial = skins.find(s => s.character === ch && s.palette === pal);
  if (partial) return partial.id;
  const any = skins.find(s => s.character === ch);
  return any ? any.id : 'bear-vivid';
}

/*
 * Apply the skin locally and broadcast saved configuration through WinSync so the other
 * window refreshes its own theme and pet.
 */
function applySkin(skinId) {
  const s = SkinRegistry ? SkinRegistry.getSkin(skinId) : _getSkins().find(x => x.id === skinId);
  if (!s) return;
  const previousSkinId = cfg._lastSkinId;
  cfg.character = s.character;
  cfg.theme = s.palette;
  cfg.tube = s.tube;
  cfg._lastSkinId = s.id;
  cfg._defaultLogoVersion = 1;
  saveCfg();
  refreshSkinAppearance(previousSkinId);
  /* Translate the name before inserting it into the localized bubble template. */
  const shownName = (typeof SoduWorkI18n !== 'undefined' && SoduWorkI18n.translateText) ? SoduWorkI18n.translateText(s.name) : s.name;
  if (typeof petSay === 'function') petSay('换上「' + shownName + '」~');
}

// Local choices and remote config patches share the same visual effects without saving twice.
function refreshSkinAppearance(previousSkinId) {
  const s = SkinRegistry.getSkin(cfg._lastSkinId);
  if (previousSkinId) SkinRegistry.clearSkinCSSVars(SkinRegistry.getSkin(previousSkinId));
  /* Apply the remote skin's CSS variables. */
  if (typeof SkinRegistry !== 'undefined') SkinRegistry.applySkinCSSVars(s);
  if (typeof applyTheme === 'function') applyTheme();
  if (typeof renderPetSVG === 'function') renderPetSVG(cfg.gender);
  if (typeof updatePet === 'function') updatePet();
  if (typeof render === 'function') render();
  /* Refresh the grid only when the workspace UI is present. */
  if (typeof renderSkinGrid === 'function') renderSkinGrid();
  if (typeof refreshSkinCurName === 'function') refreshSkinCurName();   /* Synchronize the active skin name in settings. */
}
