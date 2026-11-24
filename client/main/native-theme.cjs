'use strict';
// A per-window presentation mirror, not a second settings store. Only the
// packaged application may report its resolved theme; previews cannot do so.
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const COLOR_KEYS = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--ink', '--ink-2', '--ink-3',
  '--ink-4', '--line', '--line-2', '--line-3', '--accent', '--accent-hover', '--accent-soft', '--accent-soft-2'];
const FONT_KEYS = ['--font-ui', '--font-display'];
const DEFAULT_FILES = ['index.html', 'desk.html'].map(file => path.resolve(__dirname, '..', file));
const canonical = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
function color(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const s = value.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    const h = hex[1].length < 5 ? [...hex[1]].map(c => c + c).join('') : hex[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1);
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (!rgb) return null;
  const rgba = rgb.slice(1, 4).map(v => Number.parseFloat(v) * (v.endsWith('%') ? 2.55 : 1));
  rgba.push(rgb[4] ? Number.parseFloat(rgb[4]) / (rgb[4].endsWith('%') ? 100 : 1) : 1);
  return rgba.every(Number.isFinite) && rgba.slice(0, 3).every(v => v >= 0 && v <= 255.0001) && rgba[3] >= 0 && rgba[3] <= 1 ? rgba : null;
}
function luminance(rgb) {
  const c = rgb.slice(0, 3).map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
function normalize(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const tokens = {}, supplied = input.tokens && typeof input.tokens === 'object' ? input.tokens : {};
  for (const key of COLOR_KEYS) {
    const parsed = color(supplied[key]);
    if (!parsed || (/^--(?:bg-|ink|accent$|accent-hover$)/.test(key) && parsed[3] !== 1)) continue;
    tokens[key] = supplied[key].trim();
  }
  for (const key of FONT_KEYS) {
    const v = supplied[key];
    if (typeof v === 'string' && v.length <= 220 && /^[\p{L}\p{N}\s_'",.-]+$/u.test(v)) tokens[key] = v.trim();
  }
  // A malformed skin must not make trusted authorization text disappear.
  const bg = color(tokens['--bg-0']) || [255, 255, 255, 1], light = luminance(bg), dark = light < .18;
  for (const key of ['--ink', '--ink-2', '--ink-3', '--ink-4']) {
    const ink = color(tokens[key]);
    if (!ink && !tokens['--bg-0']) continue;
    const contrast = ink ? (Math.max(light, luminance(ink)) + .05) / (Math.min(light, luminance(ink)) + .05) : 0;
    if (contrast < 4.5) tokens[key] = dark ? '#f0f1f3' : '#242427';
  }
  const id = key => typeof input[key] === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(input[key]) ? input[key] : '';
  return { theme: id('theme') || 'vivid', skin: id('skin'), character: id('character'), colorScheme: dark ? 'dark' : 'light', tokens };
}
function create({ BrowserWindow, ipcMain, allowedFiles = DEFAULT_FILES }) {
  const sources = new Set(allowedFiles.map(canonical)), records = new Map(), subscribers = new Map(), observed = new WeakSet();
  function trusted(event) {
    try {
      const wc = event.sender, window = BrowserWindow.fromWebContents(wc);
      if (!window || window.isDestroyed() || wc.isDestroyed() || window.webContents !== wc || event.senderFrame !== wc.mainFrame) return false;
      const url = new URL(wc.getURL());
      return event.senderFrame.url === wc.getURL() && url.protocol === 'file:' && sources.has(canonical(fileURLToPath(url)));
    } catch (_) { return false; }
  }
  function update(event, raw) {
    if (!trusted(event)) return false;
    const wc = event.sender, snapshot = normalize(raw), prior = records.get(wc.id);
    if (prior && prior.wc === wc && JSON.stringify(prior.theme) === JSON.stringify(snapshot)) return true;
    if (!observed.has(wc)) {
      observed.add(wc);
      const clear = () => { records.delete(wc.id); subscribers.delete(wc.id); };
      wc.once('destroyed', clear);
      wc.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) records.delete(wc.id); });
    }
    records.set(wc.id, { wc, theme: snapshot });
    for (const callback of subscribers.get(wc.id) || []) { try { callback(snapshot); } catch (_) {} }
    return true;
  }
  ipcMain.on('client-theme', update);
  return {
    snapshot(parent) {
      const wc = parent?.webContents, row = wc && records.get(wc.id);
      return row?.wc === wc ? row.theme : normalize(null);
    },
    subscribe(parent, callback) {
      const id = parent?.webContents?.id;
      if (id == null) return () => {};
      const set = subscribers.get(id) || new Set(); set.add(callback); subscribers.set(id, set);
      return () => { set.delete(callback); if (!set.size) subscribers.delete(id); };
    },
  };
}
let installed;
function install(deps) { if (!installed) installed = create(deps); return installed; }
function snapshot(parent) { return installed ? installed.snapshot(parent) : normalize(null); }
function subscribe(parent, callback) { return installed ? installed.subscribe(parent, callback) : () => {}; }
module.exports = { create, install, snapshot, subscribe, normalize, COLOR_KEYS, FONT_KEYS };
