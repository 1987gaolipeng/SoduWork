'use strict';

function union(rects) {
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x,
    height: Math.max(...rects.map(r => r.y + r.height)) - y };
}

// A spanning HWND has one scale. Combining per-monitor DIP rectangles first
// leaves gaps or overshoots on Windows when the monitors have different scales.
function desktop(screen, platform = process.platform) {
  const all = screen.getAllDisplays?.();
  const displays = all?.length ? all : [screen.getPrimaryDisplay()];
  if (platform !== 'win32' || !screen.dipToScreenRect) return { bounds: union(displays.map(d => d.bounds)) };
  const monitors = displays.map(d => ({ display: d, pixels: screen.dipToScreenRect(null, d.bounds) }));
  const pixels = union(monitors.map(m => m.pixels));
  const anchor = monitors.reduce((a, b) => a.pixels.width * a.pixels.height >= b.pixels.width * b.pixels.height ? a : b);
  const scale = anchor.display.scaleFactor || 1;
  return { pixels, bounds: {
    x: Math.round(anchor.display.bounds.x + (pixels.x - anchor.pixels.x) / scale),
    y: Math.round(anchor.display.bounds.y + (pixels.y - anchor.pixels.y) / scale),
    width: Math.ceil(pixels.width / scale), height: Math.ceil(pixels.height / scale),
  } };
}

function localPoint(screen, win, point, platform = process.platform) {
  const bounds = win.getContentBounds();
  if (platform !== 'win32' || !screen.dipToScreenPoint || !screen.dipToScreenRect) {
    return { x: point.x - bounds.x, y: point.y - bounds.y };
  }
  const pixels = screen.dipToScreenRect(win, bounds), cursor = screen.dipToScreenPoint(point);
  return { x: (cursor.x - pixels.x) * bounds.width / pixels.width,
    y: (cursor.y - pixels.y) * bounds.height / pixels.height };
}

function localDisplays(screen, win, platform = process.platform) {
  const all = screen.getAllDisplays?.();
  const displays = all?.length ? all : [screen.getPrimaryDisplay()];
  const bounds = win.getContentBounds();
  if (platform !== 'win32' || !screen.dipToScreenRect) {
    return displays.map(d => ({ ...d.bounds, x: d.bounds.x - bounds.x, y: d.bounds.y - bounds.y }));
  }
  const windowPixels = screen.dipToScreenRect(win, bounds);
  const sx = bounds.width / windowPixels.width, sy = bounds.height / windowPixels.height;
  return displays.map(d => {
    const pixels = screen.dipToScreenRect(null, d.bounds);
    return { x: (pixels.x - windowPixels.x) * sx, y: (pixels.y - windowPixels.y) * sy,
      width: pixels.width * sx, height: pixels.height * sy };
  });
}

module.exports = { desktop, localPoint, localDisplays };
