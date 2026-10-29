(function (host, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else host.ScreenshotModel = model;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function rectangle(a, b, width, height) {
    const x = clamp(Math.min(a.x, b.x), 0, width);
    const y = clamp(Math.min(a.y, b.y), 0, height);
    return { x, y, width: clamp(Math.max(a.x, b.x), 0, width) - x, height: clamp(Math.max(a.y, b.y), 0, height) - y };
  }
  function move(rect, dx, dy, width, height) {
    return { ...rect, x: clamp(rect.x + dx, 0, width - rect.width), y: clamp(rect.y + dy, 0, height - rect.height) };
  }
  function resize(rect, handle, point, width, height, minimum = 4) {
    let left = rect.x, right = rect.x + rect.width, top = rect.y, bottom = rect.y + rect.height;
    if (handle.includes('w')) left = clamp(point.x, 0, right - minimum);
    if (handle.includes('e')) right = clamp(point.x, left + minimum, width);
    if (handle.includes('n')) top = clamp(point.y, 0, bottom - minimum);
    if (handle.includes('s')) bottom = clamp(point.y, top + minimum, height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  function toolbarPosition(rect, toolbarWidth, toolbarHeight, width, height) {
    const gap = 10, inset = 8;
    let y = rect.y + rect.height + gap;
    if (y + toolbarHeight > height - inset) y = rect.y - toolbarHeight - gap;
    if (y < inset) y = height - toolbarHeight - inset;
    return { x: clamp(rect.x + rect.width - toolbarWidth, inset, Math.max(inset, width - toolbarWidth - inset)), y: clamp(y, inset, Math.max(inset, height - toolbarHeight - inset)) };
  }
  function cropBounds(rect, width, height) {
    const x = clamp(Math.floor(rect.x), 0, width - 1), y = clamp(Math.floor(rect.y), 0, height - 1);
    return { x, y, width: clamp(Math.ceil(rect.x + rect.width), x + 1, width) - x, height: clamp(Math.ceil(rect.y + rect.height), y + 1, height) - y };
  }
  function validImage(width, height) {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 32768 && height <= 32768 && width * height <= 64 * 1024 * 1024;
  }
  function translateMarks(marks, dx, dy) {
    return marks.map((mark) => {
      const next = clone(mark);
      if (next.points) next.points = next.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
      if (typeof next.x === 'number') next.x += dx;
      if (typeof next.y === 'number') next.y += dy;
      if (typeof next.endX === 'number') next.endX += dx;
      if (typeof next.endY === 'number') next.endY += dy;
      return next;
    });
  }
  function createHistory(initial, limit = 30) {
    const states = [clone(initial)]; let index = 0;
    return {
      current: () => clone(states[index]), canUndo: () => index > 0, canRedo: () => index < states.length - 1,
      push(value) {
        if (JSON.stringify(states[index]) === JSON.stringify(value)) return clone(states[index]);
        states.splice(index + 1); states.push(clone(value));
        if (states.length > limit) states.shift();
        index = states.length - 1; return clone(states[index]);
      },
      undo() { index = Math.max(0, index - 1); return clone(states[index]); },
      redo() { index = Math.min(states.length - 1, index + 1); return clone(states[index]); },
    };
  }
  return { clamp, rectangle, move, resize, toolbarPosition, cropBounds, validImage, translateMarks, createHistory };
});
