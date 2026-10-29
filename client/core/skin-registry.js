/*
 * Unified built-in and remote skin registry with manifest loading, custom SVG characters,
 * CSS variables, and in-memory caching. Fall back to built-ins when remote loading fails.
 */

const SkinRegistry = (function () {
  /* Built-in skin definitions. */
  const BUILTIN_TUBE_STYLES = {
    glass:   { name: '玻璃',   color: 'rgba(180,220,255,.55)', glow: 'rgba(180,220,255,.3)' },
    crystal: { name: '水晶',   color: 'rgba(200,230,255,.7)',  glow: 'rgba(220,240,255,.5)' },
    bamboo:  { name: '竹节',   color: '#c8b78a',               glow: 'rgba(200,183,138,.4)' },
    neon:    { name: '霓虹',   color: '#3a3a4a',               glow: 'rgba(255,90,180,.6)' },
    ink:     { name: '水墨',   color: '#2a2a35',               glow: 'rgba(80,80,100,.3)' }
  };

  /*
   * Skins combine shared layout with a material. Add registry metadata, material CSS tokens,
   * and a matching character renderer when introducing a skin.
   */
  const BUILTIN_SKINS = [
    { id:'soduwork-logo', character:'soduwork', material:'box', palette:'vivid', tube:'glass', name:'SoduWork',
      desc:'默认', shot:false, previewType:'logo',
      bearColor:'#4f8ff5', tubeColor:'rgba(180,220,255,.5)' },
    { id:'bear-vivid', character:'bear', material:'glass', palette:'vivid',  tube:'glass', name:'玻璃球', desc:'晶莹玻璃盒 · 水晶浮珠', shot:true,
      bearColor:'#8fbdf0', tubeColor:'rgba(180,220,255,.55)', bg:'linear-gradient(135deg,#eaf2fc,#dbe9fb)' },
    { id:'box-biz',    character:'box',  material:'box',   palette:'vivid',  tube:'glass', name:'彩色盒子', desc:'彩色礼盒 · 四色盒盖', shot:true,
      bearColor:'#f5a524', tubeColor:'rgba(180,220,255,.5)',  bg:'linear-gradient(135deg,#fff6ea,#ffeede)' },
    { id:'diamond-ice',character:'diamond', material:'diamond', palette:'vivid', tube:'glass', name:'钻石盒子', desc:'冰晶切面 · 棱彩折光', shot:true,
      bearColor:'#bfe3ff', tubeColor:'rgba(210,235,255,.6)',  bg:'linear-gradient(135deg,#eef7ff,#e2f0ff)' },
    /* Two Ruby variants reuse the glass-orb and box shapes, with colors from variables.css
       [data-skin="ruby"] / [data-skin="ruby-box"] and [data-theme="ruby"].
       shotFile decouples previews from characters so multiple palettes cannot overwrite previews/<character>.png. */
    { id:'bear-ruby',  character:'bear', material:'ruby',     palette:'ruby', tube:'glass', name:'红玻璃球', desc:'红宝石质感玻璃球', shot:true, shotFile:'ruby-ball',
      bearColor:'#e8323c', tubeColor:'rgba(255,190,190,.55)', bg:'linear-gradient(135deg,#fff4f4,#ffe6e6)' },
    { id:'box-ruby',   character:'box',  material:'ruby-box', palette:'ruby', tube:'glass', name:'红盒子',   desc:'正红盒盖 · 纯白盒身',   shot:true, shotFile:'ruby-box',
      bearColor:'#e60012', tubeColor:'rgba(255,190,190,.5)',  bg:'linear-gradient(135deg,#fff6f6,#ffeaea)' },
    /*
     * Azure flat skin uses solid-shaded flatball geometry and flat material. A distinct azure
     * palette preserves the character, palette, and tube identity tuple.
     */
    { id:'flat-azure', character:'flatball', material:'flat', palette:'azure', tube:'glass', name:'晴空蓝', desc:'扁平蓝调 · 纯色圆球', shot:true, shotFile:'flat-azure',
      bearColor:'#3b86f0', tubeColor:'rgba(140,185,250,.55)', bg:'linear-gradient(135deg,#eef4ff,#dfeaff)' },
    /* The flat skin changes interface surfaces while retaining the glass pet's character palette.
   Palette distinguishes the azure glass variant from the vivid glass variant. */
    { id:'flat-azure-glass', character:'bear', material:'flat', palette:'azure', tube:'glass', name:'晴空·玻璃球', desc:'界面扁平 · 玻璃球不变', shot:true, shotFile:'flat-azure-glass', shotPosition:'center center',
      bearColor:'#4f9be0', tubeColor:'rgba(140,185,250,.55)', bg:'linear-gradient(135deg,#eef4ff,#dfeaff)' },
    /* Local branded pet assets use the four-color mark and respond to task state. */
    { id:'soduwork-signature', character:'soduwork', material:'glass', palette:'signature', tube:'glass', name:'SoduWork·品牌伙伴',
      desc:'SoduWork 原生桌宠 · 随工作状态回应', shot:false, previewType:'soduwork',
      bearColor:'#4f8ff5', tubeColor:'rgba(140,185,250,.55)', bg:'linear-gradient(135deg,#f4f8ff,#e9f1ff)',
      cssVars:{'--soduwork-pet-blue':'#4f8ff5','--soduwork-pet-orange':'#ffac2f','--soduwork-pet-mint':'#20c79a','--soduwork-pet-pink':'#ef5f92'} },
  ];

  /* Runtime state. */
  const _remoteSkins = [];          /* Merged remote skin definitions. */
  const _customChars = {};           /* Custom character definitions keyed by ID. */
  const _svgCache = {};              /* Remote SVG content cached by skin ID. */
  let _remoteEndpoint = null;        /* Currently loaded remote endpoint. */
  let _lastLoadAt = 0;
  let _loadPromise = null;

  /* Merge built-ins with remote skins; remote entries override matching IDs. */
  function getSkins() {
    const map = new Map();
    BUILTIN_SKINS.forEach(s => map.set(s.id, s));
    _remoteSkins.forEach(s => map.set(s.id, s));
    return Array.from(map.values());
  }

  function getSkin(id) {
    return getSkins().find(s => s.id === id) || null;
  }

  /* Upgrade the former defaults once; explicit skin selections opt out even
     when the user switches back to an old default. A fresh default needs no
     save: delayed Hub settings must still be able to restore a custom skin. */
  function migrateDefaultLogo(cfg) {
    if (!cfg || cfg._defaultLogoVersion >= 1 || (cfg.tube && cfg.tube !== 'glass')) return false;
    const id = cfg._lastSkinId;
    // Store merges defaults before saved settings, so older partial settings
    // can inherit the new id while retaining their original character.
    const inheritedId = !id || id === 'soduwork-logo';
    const oldBox = cfg.character === 'box' && (!cfg.theme || cfg.theme === 'vivid') && (inheritedId || id === 'box-biz');
    const oldBrand = cfg.character === 'soduwork' && (!cfg.theme || cfg.theme === 'signature') && (inheritedId || id === 'soduwork-signature');
    if (!oldBox && !oldBrand) return false;
    clearSkinCSSVars(getSkin(id));
    Object.assign(cfg, { character:'soduwork', theme:'vivid', tube:'glass', _lastSkinId:'soduwork-logo', _defaultLogoVersion:1 });
    return true;
  }

  function getTubeStyles() {
    /* Allow remote skins to extend tube styles. */
    const merged = Object.assign({}, BUILTIN_TUBE_STYLES);
    _remoteSkins.forEach(s => {
      if (s.tubeStyles) Object.assign(merged, s.tubeStyles);
    });
    return merged;
  }

  function isRemote(skinId) {
    return _remoteSkins.some(s => s.id === skinId);
  }

  /*
   * Register built-in characters from characters.js and remote custom characters through the
   * same interface.
   */
  function registerCharacter(id, def) {
    if (!id || !def) return;
    _customChars[id] = def;
  }

  function getCharacter(id) {
    return _customChars[id] || null;
  }

  function hasCharacter(id) {
    return !!_customChars[id];
  }

  /*
   * Load a versioned manifest containing skins with id, character, name, description,
   * palette, tube, colors, background, optional cssVars, and optional petSVG URL.
   */
  async function loadRemote(endpoint) {
    if (_loadPromise && _remoteEndpoint === endpoint) return _loadPromise;
    _remoteEndpoint = endpoint;
    _loadPromise = (async () => {
      try {
        /* Append the current device identity when the endpoint lacks a user parameter to select its private skin scope. */
        let url = endpoint;
        if (typeof User !== 'undefined' && User.id) {
          url += (endpoint.includes('?') ? '&' : '?') + 'user=' + encodeURIComponent(User.id);
        }
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !Array.isArray(data.skins)) throw new Error('manifest invalid');
        /* Replace the previous remote skin list. */
        _remoteSkins.length = 0;
        for (const s of data.skins) {
          if (!s.id || !s.name || !s.character) continue;
          /* Mark remote origin and shared or private ownership. */
          s._remote = true;
          if (!s._owner) s._owner = 'shared';
          _remoteSkins.push(s);
        }
        _lastLoadAt = Date.now();
        /* Preload custom SVGs once per character. */
        await _preloadCustomSVGs();
        return { ok: true, count: _remoteSkins.length };
      } catch (e) {
        console.warn('[SkinRegistry] loadRemote failed:', e);
        return { ok: false, error: String(e.message || e) };
      } finally {
        _loadPromise = null;
      }
    })();
    return _loadPromise;
  }

  /* Preload remote SVGs and register their characters. */
  async function _preloadCustomSVGs() {
    /* Collect unique characters requiring SVG loading. */
    const charSvgMap = {}; /* character -> {url, dsKey?} */
    _remoteSkins.forEach(s => {
      if (s.petSVG && !charSvgMap[s.character]) {
        charSvgMap[s.character] = { url: s.petSVG, dsKey: s.dsKey, name: s.charName || s.character };
      }
    });
    for (const charId of Object.keys(charSvgMap)) {
      const info = charSvgMap[charId];
      if (_svgCache[charId]) {
        /* Ensure cached SVGs are registered. */
        _registerSVGCharacter(charId, info);
        continue;
      }
      try {
        const res = await fetch(info.url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const svg = await res.text();
        _svgCache[charId] = svg;
        _registerSVGCharacter(charId, info);
      } catch (e) {
        console.warn('[SkinRegistry] preload SVG failed for', charId, e);
      }
    }
  }

  /*
   * Remote characters preserve pupL, pupR, lidL, lidR, and petMouth IDs so existing blink
   * and expression logic can address them.
   */
  function _registerSVGCharacter(charId, info) {
    const svg = _svgCache[charId];
    if (!svg) return;
    registerCharacter(charId, {
      name: info.name || charId,
      dsKey(gender) { return info.dsKey || '--c-ds'; },
      render(gender, cv) {
        /* Return the cached SVG content. */
        /* Remote renderers return inner SVG fragments without an outer svg element, matching built-in renderers. */
        return svg;
      }
    });
  }

  function getRemoteInfo() {
    return {
      endpoint: _remoteEndpoint,
      lastLoadAt: _lastLoadAt,
      count: _remoteSkins.length
    };
  }

  /* Apply skin CSS variables at runtime. */
  function applySkinCSSVars(skin) {
    if (!skin || !skin.cssVars) return;
    const root = document.documentElement;
    Object.keys(skin.cssVars).forEach(k => {
      root.style.setProperty(k, skin.cssVars[k]);
    });
  }

  function clearSkinCSSVars(skin) {
    if (!skin || !skin.cssVars) return;
    const root = document.documentElement;
    Object.keys(skin.cssVars).forEach(k => {
      root.style.removeProperty(k);
    });
  }

  return {
    BUILTIN_SKINS,
    BUILTIN_TUBE_STYLES,
    getSkins,
    getSkin,
    migrateDefaultLogo,
    getTubeStyles,
    isRemote,
    isMine(skinId) {
      const s = _remoteSkins.find(x => x.id === skinId);
      return !!s && s._owner === 'mine';
    },
    isShared(skinId) {
      const s = _remoteSkins.find(x => x.id === skinId);
      return !!s && s._owner === 'shared';
    },
    registerCharacter,
    getCharacter,
    hasCharacter,
    loadRemote,
    getRemoteInfo,
    applySkinCSSVars,
    clearSkinCSSVars
  };
})();

/* Expose globals for legacy consumers. */
const SKINS_REF = SkinRegistry; /* Compatibility alias for skin-manager.js. */
