'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const sizing = require('../core/app-window-sizing');
const area = { x: -1920, y: 30, width: 1920, height: 1050 };

test('unconfigured apps open at laptop size on large screens and fit smaller laptop screens', () => {
  const desktop = sizing.resolve(undefined, { x: -520, y: -1440, width: 2560, height: 1400 });
  assert.deepEqual(desktop.bounds, { x: -140, y: -1303, width: 1800, height: 1125 });
  const largeLaptop = sizing.resolve(undefined, { x: 0, y: 0, width: 1707, height: 1027 });
  assert.deepEqual(largeLaptop.bounds, { x: 0, y: 0, width: 1707, height: 1027 });
  const macLaptop = sizing.resolve(undefined, { x: 0, y: 25, width: 1512, height: 919 });
  assert.deepEqual(macLaptop.bounds, { x: 0, y: 25, width: 1512, height: 919 });
  const laptop = sizing.resolve(undefined, { x: 0, y: 0, width: 1366, height: 728 });
  assert.deepEqual(laptop.bounds, { x: 0, y: 0, width: 1366, height: 728 });
});

test('viewport defaults use the target display work area and center fixed sizes on negative-coordinate monitors', () => {
  const full = sizing.resolve({ width: '100vw', height: '100vh' }, area);
  assert.deepEqual(full.bounds, area);
  const fixed = sizing.resolve({ width: '1280', height: 720 }, area);
  assert.deepEqual(fixed.bounds, { x: -1600, y: 195, width: 1280, height: 720 });
});

test('screen-filling openings keep smaller centered restore bounds without changing authored limits or fixed openings', () => {
  const screen = { x: -1707, y: 25, width: 1707, height: 1027 };
  const full = sizing.opening(undefined, screen);
  assert.equal(full.startMaximized, true);
  assert.deepEqual(full.bounds, screen);
  assert.ok(full.normalBounds.width < screen.width && full.normalBounds.height < screen.height);
  assert.ok(full.normalBounds.x > screen.x && full.normalBounds.y > screen.y);
  assert.deepEqual(full.limits, { minWidth: 480, minHeight: 360 });
  const fixed = sizing.opening({ width: 600, height: 450, minWidth: 300, minHeight: 200, maxWidth: 640 }, screen);
  assert.equal(fixed.startMaximized, false); assert.deepEqual(fixed.normalBounds, fixed.bounds);
  const desktop = sizing.opening(undefined, { width: 2560, height: 1400 });
  assert.equal(desktop.startMaximized, false); assert.equal(desktop.normalBounds.width, 1800);
  const constrained = sizing.opening({ minWidth: 1680, minHeight: 1000 }, screen);
  assert.ok(constrained.normalBounds.width >= 1680 && constrained.normalBounds.height >= 1000);
  const locked = sizing.opening({ minWidth: 2000, minHeight: 1500 }, screen);
  assert.equal(locked.startMaximized, false); assert.deepEqual(locked.normalBounds, screen);
});
test('opening caps do not impose a native maximum and accept the requested 17800 height', () => {
  const result = sizing.resolve({ width: '100vw', height: '100vh', maxWidth: 2680, maxHeight: 17800 },
    { x: 0, y: 0, width: 3840, height: 2160 });
  assert.equal(result.bounds.width, 2680); assert.equal(result.bounds.height, 2160);
  assert.deepEqual(Object.keys(result.limits).sort(), ['minHeight', 'minWidth']);
  assert.equal(sizing.normalize({ maxHeight: 17800 }).maxHeight, '17800px');
});
test('first matching screen rule overrides only its supplied sizes and preserves shared limits', () => {
  const value = { width: '1400px', height: '80vh', minWidth: '600px', rules: [
    { maxScreenWidth: 1366, width: '100vw', height: '100vh' },
    { minScreenWidth: 1367, maxScreenWidth: 2560, width: '90vw' },
    { minScreenWidth: 1367, width: 1200, height: 800 },
  ] };
  const laptop = sizing.resolve(value, { width: 1280, height: 720 });
  assert.equal(laptop.matchedRule, 0); assert.equal(laptop.bounds.width, 1280); assert.equal(laptop.bounds.height, 720);
  const desktop = sizing.resolve(value, area);
  assert.equal(desktop.matchedRule, 1); assert.equal(desktop.bounds.width, 1728); assert.equal(desktop.bounds.height, 840);
  assert.equal(desktop.limits.minWidth, 600);
  assert.equal(sizing.resolve(value, { width: 3200, height: 1800 }).matchedRule, 2);
});
test('missing screen matches retain defaults, and small screens keep their title bar accessible', () => {
  const result = sizing.resolve({ rules: [{ minScreenWidth: 2000, width: 1800 }] }, area);
  assert.equal(result.matchedRule, -1); assert.equal(result.bounds.width, 1800);
  const small = sizing.resolve({ minWidth: 1400, minHeight: 1000 }, { x: 10, y: 20, width: 800, height: 600 });
  assert.deepEqual(small.bounds, { x: 10, y: 20, width: 800, height: 600 });
  assert.deepEqual(small.limits, { minWidth: 800, minHeight: 600 });
});
test('malformed settings and impossible static bounds are rejected instead of silently changing opening behavior', () => {
  for (const width of ['calc(100vw - 20px)', '-10px', 'Infinity', '0', {}, true, '100;global.x=1', '1000000px']) {
    assert.throws(() => sizing.normalize({ width }), /宽度/);
  }
  assert.throws(() => sizing.normalize({ minWidth: 900, maxWidth: 800 }), /不能大于/);
  assert.throws(() => sizing.normalize({ rules: {} }), /规则须为列表/);
  assert.throws(() => sizing.normalize({ rules: Array(13).fill({ width: 1000 }) }), /最多 12/);
  assert.throws(() => sizing.normalize({ rules: [{ minScreenWidth: 1600, maxScreenWidth: 1000, width: 800 }] }), /上限不能小于/);
  assert.throws(() => sizing.normalize({ rules: [{ minScreenWidth: 'wide', width: 800 }] }), /须为非负整数/);
  assert.throws(() => sizing.normalize({ rules: [{}] }), /至少填写/);
});
