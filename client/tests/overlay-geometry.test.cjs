'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { desktop, localPoint } = require('../main/overlay-geometry.cjs');

test('equal-scale desktop bounds include negative-origin portrait monitors', () => {
  const screens = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { bounds: { x: -1080, y: -500, width: 1080, height: 1920 } }];
  assert.deepEqual(desktop({ getAllDisplays: () => screens }, 'linux').bounds,
    { x: -1080, y: -500, width: 3000, height: 1920 });
});

test('mixed Windows scales use physical monitor coverage and the spanning window scale', () => {
  const displays = [{ bounds: { x: 0, y: 0, width: 2048, height: 1280 }, scaleFactor: 1.25 },
    { bounds: { x: -2560, y: -200, width: 2560, height: 1440 }, scaleFactor: 1.5 }];
  const screen = { getAllDisplays: () => displays,
    dipToScreenRect: (_win, r) => r.x < 0 ? { x: -3840, y: -300, width: 3840, height: 2160 }
      : { x: 0, y: 0, width: 2560, height: 1600 } };
  assert.deepEqual(desktop(screen, 'win32'), {
    pixels: { x: -3840, y: -300, width: 6400, height: 2160 },
    bounds: { x: -2560, y: -200, width: 4267, height: 1440 },
  });
});

test('cursor hit testing crosses DPI boundaries in physical space before converting to local DIP', () => {
  const win = { getContentBounds: () => ({ x: -3072, y: -240, width: 5120, height: 1728 }) };
  const screen = { dipToScreenRect: () => ({ x: -3840, y: -300, width: 6400, height: 2160 }),
    dipToScreenPoint: p => p.x < 0 ? { x: p.x * 1.5, y: p.y * 1.5 } : { x: p.x * 1.25, y: p.y * 1.25 } };
  assert.deepEqual(localPoint(screen, win, { x: -2000, y: 0 }, 'win32'), { x: 672, y: 240 });
  assert.deepEqual(localPoint(screen, win, { x: 200, y: 0 }, 'win32'), { x: 3272, y: 240 });
});
