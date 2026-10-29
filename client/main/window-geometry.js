












const path = require('path');
const fs = require('fs');
const { app, screen } = require('electron');
const layout = require('./window-layout');

const _file = () => path.join(app.getPath('userData'), 'window-geometry.json');

let _cache = null;
function _all() {
  if (!_cache) {
    try { _cache = JSON.parse(fs.readFileSync(_file(), 'utf8')) || {}; } catch (e) { _cache = {}; }
  }
  return _cache;
}

let _timer = null;
function _flush() {
  /* Throttle repeated move and resize writes. */
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    try { fs.writeFileSync(_file(), JSON.stringify(_all())); } catch (e) {}
  }, 500);
}

/*
 * Require sufficient intersection with a current display work area so restored windows
 * retain a reachable title bar.
 */
function usable(b) {
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return false;
  if (!(b.width > 0 && b.height > 0)) return false;
  for (const d of screen.getAllDisplays()) {
    const w = d.workArea;
    const ix = Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x);
    const iy = Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y);
    if (ix > 120 && iy > 60) return true;
  }
  return false;
}

function _displayFor(bounds) {
  try {
    if (bounds) return screen.getDisplayMatching(bounds);
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch (e) {
    return screen.getPrimaryDisplay();
  }
}

/*
 * Clamp saved windows fully into the current work area after display, taskbar, or DPI
 * changes.
 */
function restore(saved, spec) {
  if (!usable(saved)) return null;
  return layout.restored(spec, _displayFor(saved).workArea, saved);
}

/*
 * Place new windows on the initiating window's display, falling back to the pointer
 * display, with small offsets for reachable title bars.
 */
function initial(spec, sourceWin, openWindows) {
  let anchor = null;
  try { if (sourceWin && !sourceWin.isDestroyed()) anchor = sourceWin.getBounds(); } catch (e) {}
  const display = _displayFor(anchor);
  const count = (openWindows || []).filter((win) => {
    try { return !win.isDestroyed() && _displayFor(win.getBounds()).id === display.id; } catch (e) { return false; }
  }).length;
  return layout.initial(spec, display.workArea, anchor, count);
}

function limits(spec, bounds) {
  const area = _displayFor(bounds).workArea;
  return {
    minWidth: Math.min(spec.minW, area.width, bounds && bounds.width || area.width),
    minHeight: Math.min(spec.minH, area.height, bounds && bounds.height || area.height),
  };
}

function remember(panel, win) {
  const rec = () => {
    /* Do not save minimized or maximized bounds as normal geometry. */
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    const b = win.getBounds();
    _all()[panel] = { x: b.x, y: b.y, width: b.width, height: b.height, max: false };
    _flush();
  };
  /*
   * Listen to continuous move and resize events to include programmatic changes, throttle
   * persistence, and save again on close.
   */
  win.on('move', rec);
  win.on('resize', rec);
  win.on('close', rec);
  /*
   * Persist maximization as a flag without replacing normal restore bounds.
   */
  win.on('maximize', () => { const g = _all()[panel] || {}; g.max = true; _all()[panel] = g; _flush(); });
  win.on('unmaximize', () => { const g = _all()[panel] || {}; g.max = false; _all()[panel] = g; _flush(); rec(); });
}

module.exports = { get: (panel) => _all()[panel], usable, restore, initial, limits, remember };
