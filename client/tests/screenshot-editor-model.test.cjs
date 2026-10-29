const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../components/screenshot/screenshot-model.js');

test('dragging backwards creates a normalized bounded selection', () => {
  assert.deepEqual(M.rectangle({ x: 400, y: 300 }, { x: -30, y: 80 }, 800, 600), { x: 0, y: 80, width: 400, height: 220 });
});
test('move keeps the selected area on its monitor', () => {
  assert.deepEqual(M.move({ x: 100, y: 100, width: 300, height: 200 }, 800, -200, 1000, 600), { x: 700, y: 0, width: 300, height: 200 });
});
test('resize all eight handles keeps opposite edges and minimum size', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  assert.deepEqual(M.resize(rect, 'nw', { x: 500, y: 500 }, 800, 600, 8), { x: 292, y: 192, width: 8, height: 8 });
  assert.deepEqual(M.resize(rect, 'se', { x: 900, y: 900 }, 800, 600, 8), { x: 100, y: 100, width: 700, height: 500 });
  for (const handle of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const resized = M.resize(rect, handle, { x: 200, y: 150 }, 800, 600, 8);
    assert.ok(resized.width >= 8 && resized.height >= 8);
  }
});
test('toolbar stays visible for selections touching every edge', () => {
  for (const rect of [{ x: 0, y: 0, width: 800, height: 600 }, { x: 740, y: 560, width: 60, height: 40 }, { x: 0, y: 0, width: 20, height: 20 }]) {
    const pos = M.toolbarPosition(rect, 570, 96, 800, 600);
    assert.ok(pos.x >= 8 && pos.y >= 8);
    assert.ok(pos.x + 570 <= 792 && pos.y + 96 <= 592);
  }
});
test('crop bounds include fractional edge pixels at high DPI', () => {
  assert.deepEqual(M.cropBounds({ x: 1.2, y: 2.9, width: 10.3, height: 20.3 }, 100, 100), { x: 1, y: 2, width: 11, height: 22 });
});
test('image validation rejects impossible or excessive allocations', () => {
  assert.equal(M.validImage(7680, 4320), true);
  assert.equal(M.validImage(32768, 1024), true);
  assert.equal(M.validImage(8192, 8192), true);
  for (const [w, h] of [[0, 20], [Infinity, 20], [32769, 20], [12000, 12000], [2.3, 20]]) assert.equal(M.validImage(w, h), false);
});
test('undo redo restores selection and annotation without sharing mutable state', () => {
  const history = M.createHistory({ selection: null, marks: [] });
  const next = { selection: { x: 1, y: 1, width: 100, height: 50 }, marks: [{ type: 'text', text: '你好' }] };
  history.push(next);
  next.marks[0].text = 'changed';
  assert.equal(history.current().marks[0].text, '你好');
  assert.equal(history.undo().selection, null);
  assert.equal(history.redo().marks[0].text, '你好');
  const copy = history.current(); copy.marks.length = 0;
  assert.equal(history.current().marks.length, 1);
});
test('editing after undo drops the obsolete redo branch', () => {
  const h = M.createHistory({ value: 0 }); h.push({ value: 1 }); h.push({ value: 2 }); h.undo(); h.push({ value: 3 });
  assert.equal(h.canRedo(), false); assert.deepEqual(h.redo(), { value: 3 });
  assert.deepEqual(h.undo(), { value: 1 });
});
test('move translates every annotation kind without mutating its original', () => {
  const marks = [{ type: 'pen', points: [{ x: 1, y: 2 }] }, { type: 'text', x: 3, y: 4, text: 'test' }, { type: 'arrow', x: 1, y: 2, endX: 4, endY: 5 }];
  const moved = M.translateMarks(marks, 10, -2);
  assert.deepEqual(moved[0].points, [{ x: 11, y: 0 }]);
  assert.equal(moved[1].x, 13); assert.equal(moved[2].endY, 3);
  assert.equal(marks[1].x, 3);
});
test('history cap bounds memory while keeping latest operations undoable', () => {
  const h = M.createHistory({ value: 0 }, 3);
  for (let i = 1; i < 10; i++) h.push({ value: i });
  assert.deepEqual(h.undo(), { value: 8 }); assert.deepEqual(h.undo(), { value: 7 }); assert.equal(h.canUndo(), false);
});
