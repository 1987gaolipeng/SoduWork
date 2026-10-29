'use strict';











const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('竖条重绘幂等：内容没变不碰 DOM（hover 不再被重建打断）', () => {
  const dock = read('components/pet/pet-dock.js');
  // Compare signatures before replacing innerHTML.
  assert.match(dock, /dock\.dataset\.sig === sig && dock\.firstElementChild/);
  assert.match(dock, /dock\.dataset\.sig = sig/);
  const paint = dock.slice(dock.indexOf('function paintDock'));
  const guardAt = paint.indexOf('dock.dataset.sig === sig');
  const writeAt = paint.indexOf('dock.innerHTML');
  assert.ok(guardAt > 0 && writeAt > guardAt, '幂等守卫必须在 innerHTML 之前');
  // Store signatures in data attributes outside class/style shape observation.
  assert.doesNotMatch(paint.slice(0, writeAt), /setAttribute\(['"](class|style)['"]/);
});

test('拖动现役竖条和球时进入拖动模式，松手后退出', () => {
  const dock = read('components/pet/pet-dock.js');
  assert.match(dock, /beginOverlayDrag\(\)/);
  assert.match(dock, /endOverlayDrag\(\)/);
  const pet = read('components/pet/pet-ui.js');
  // Retired task-area drag is gone; the pet and dock each retain balanced drag hooks.
  assert.equal(pet.split('beginOverlayDrag()').length - 1, 1, '球拖动进入一次拖动模式');
  assert.equal(pet.split('endOverlayDrag()').length - 1, 1);
  // Avoid per-frame geometry reads in the drag hot path.
  const move = dock.slice(dock.indexOf('function onPointerMove'),
    dock.indexOf('function onPointerUp'));
  assert.match(move, /if \(!dragW \|\| !dragH\)/, '尺寸应缓存，不该每帧强制布局');
});

test('拖动期形状＝跟着跳的方块：不停掉（裁切）、不整窗（整屏闪）、不每帧（掉帧）', () => {




  const electron = read('core/electron.js');
  assert.match(electron, /window\.beginOverlayDrag\s*=\s*function/);
  assert.match(electron, /window\.endOverlayDrag\s*=\s*function/);
  assert.match(electron, /DRAG_TILE_PAD/);
  // Require positive tile travel allowance to avoid per-frame updates.
  const pad = Number((electron.match(/DRAG_TILE_PAD=(\d+)/) || [])[1]);
  const slack = Number((electron.match(/DRAG_TILE_SLACK=(\d+)/) || [])[1]);
  assert.ok(pad > slack && slack > 0, 'PAD 必须大于 SLACK（每块要能走 PAD-SLACK 像素）');
  // Do not restore full-window drag regions.
  assert.doesNotMatch(electron, /setOverlayShape\(\[\{x:0,y:0/);
  // Do not suspend all region updates during movement.
  assert.doesNotMatch(electron, /_shapeSuspended/);
  // Reset the shape key on release to force precise geometry restoration.
  const end = electron.slice(electron.indexOf('window.endOverlayDrag'));
  assert.match(end.slice(0, end.indexOf('function _queueOverlayShape')), /_lastShapeKey=null/);
});
