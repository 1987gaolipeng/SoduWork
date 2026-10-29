/* Pure Electron-independent window geometry using DIP coordinates. */
const EDGE = 24;
const CASCADE = 26;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function sizeFor(spec, area, saved) {
  const maxW = Math.max(320, area.width - EDGE * 2);
  const maxH = Math.max(260, area.height - EDGE * 2);
  const wantedW = saved && saved.width > 0 ? saved.width : spec.w;
  const wantedH = saved && saved.height > 0 ? saved.height : spec.h;
  return {
    width: Math.round(clamp(wantedW, Math.min(spec.minW, maxW), maxW)),
    height: Math.round(clamp(wantedH, Math.min(spec.minH, maxH), maxH)),
  };
}

function contain(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.round(clamp(bounds.x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(bounds.y, area.y, area.y + area.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function initial(spec, area, anchor, openCount) {
  const size = sizeFor(spec, area);
  let x;
  let y;
  if (spec.placement === 'side') {
    x = area.x + area.width - size.width - EDGE;
    y = area.y + EDGE;
  } else if (spec.placement === 'relative' && anchor) {
    x = anchor.x + (anchor.width - size.width) / 2;
    y = anchor.y + Math.max(38, (anchor.height - size.height) / 2);
  } else {
    x = area.x + (area.width - size.width) / 2;
    y = area.y + (area.height - size.height) / 2;
  }
  /* Offset same-display windows in a short cycle to avoid unbounded drift. */
  const shift = (Math.max(0, openCount) % 4) * CASCADE;
  return contain({ x: x + shift, y: y + shift, ...size }, area);
}

function restored(spec, area, saved) {
  const size = sizeFor(spec, area, saved);
  return contain({ x: saved.x, y: saved.y, ...size }, area);
}

module.exports = { EDGE, sizeFor, contain, initial, restored };
