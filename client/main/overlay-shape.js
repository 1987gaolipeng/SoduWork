'use strict';

/*
 * Normalize renderer rectangles into safe integer native window regions. Keep geometry
 * pure and testable independently of main-process application.
 */

const MAX_RECTS = 64;

function _number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(rects, bounds) {
  const maxWidth = Math.max(1, Math.floor(_number(bounds && bounds.width) || 1));
  const maxHeight = Math.max(1, Math.floor(_number(bounds && bounds.height) || 1));
  const source = Array.isArray(rects) ? rects.slice(0, MAX_RECTS) : [];
  const seen = new Set();
  const result = [];

  for (const rect of source) {
    const x = _number(rect && rect.x);
    const y = _number(rect && rect.y);
    const width = _number(rect && rect.width);
    const height = _number(rect && rect.height);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) continue;

    const left = Math.max(0, Math.min(maxWidth, Math.floor(x)));
    const top = Math.max(0, Math.min(maxHeight, Math.floor(y)));
    const right = Math.max(0, Math.min(maxWidth, Math.ceil(x + width)));
    const bottom = Math.max(0, Math.min(maxHeight, Math.ceil(y + height)));
    if (right <= left || bottom <= top) continue;

    const safe = { x: left, y: top, width: right - left, height: bottom - top };
    const key = `${safe.x},${safe.y},${safe.width},${safe.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(safe);
  }
  return result;
}

function parking(bounds) {
  const width = Math.max(1, Math.floor(_number(bounds && bounds.width) || 1));
  const height = Math.max(1, Math.floor(_number(bounds && bounds.height) || 1));
  return [{ x: width - 1, y: height - 1, width: 1, height: 1 }];
}

/*
 * Add a detached 1x1 native anchor to single non-fullscreen regions to retain
 * COMPLEXREGION behavior on affected Windows layered windows. The anchor is not a business
 * hit region and remains passthrough under the input guard.
 */
function stabilize(rects, bounds) {
  const safe = normalize(rects, bounds);
  if (safe.length !== 1) return safe;
  const width = Math.max(1, Math.floor(_number(bounds && bounds.width) || 1));
  const height = Math.max(1, Math.floor(_number(bounds && bounds.height) || 1));
  const only = safe[0];
  if (only.x === 0 && only.y === 0 && only.width === width && only.height === height) return safe;

  const candidates = [
    // Keep the detached anchor next to the widget. A screen-corner anchor
    // needlessly expands the region's bounding box across the desktop.
    { x: only.x - 2, y: only.y, width: 1, height: 1 },
    { x: only.x + only.width + 1, y: only.y, width: 1, height: 1 },
    { x: only.x, y: only.y - 2, width: 1, height: 1 },
    { x: only.x, y: only.y + only.height + 1, width: 1, height: 1 },
  ];
  const anchor = candidates.find((point) => (
    point.x >= 0 && point.y >= 0 && point.x < width && point.y < height && (
      point.x + point.width < only.x || point.x > only.x + only.width ||
      point.y + point.height < only.y || point.y > only.y + only.height)
  ));
  return anchor ? safe.concat(anchor) : safe;
}

function containsPoint(rects, x, y) {
  const px = _number(x);
  const py = _number(y);
  if (px === null || py === null || !Array.isArray(rects)) return false;
  return rects.some((rect) => px >= rect.x && py >= rect.y &&
    px < rect.x + rect.width && py < rect.y + rect.height);
}

function resolve(rects, bounds) {
  const safe = stabilize(rects, bounds);
  return safe.length ? safe : parking(bounds);
}

function equal(left, right) {
  return left.length === right.length && left.every((r, i) => {
    const next = right[i];
    return r.x === next.x && r.y === next.y && r.width === next.width && r.height === next.height;
  });
}

module.exports = { MAX_RECTS, normalize, parking, stabilize, containsPoint, resolve, equal };
