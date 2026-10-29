/* Test small displays, monitor changes, and invalid saved bounds without Electron. */
const assert = require('node:assert/strict');
const layout = require('./window-layout');
const specs = require('./window-specs');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  PASS  ${name}\n`);
}

function inside(bounds, area) {
  assert.ok(bounds.x >= area.x);
  assert.ok(bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
}

check('主工作区首次打开居中并保留安全边距', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = layout.initial(specs.workspace, area, null, 0);
  assert.deepEqual(b, { x: 230, y: 70, width: 1460, height: 900 });
  inside(b, area);
});

check('1366×768 小屏会缩放工作区而不是把标题栏挤出屏幕', () => {
  const area = { x: 0, y: 0, width: 1366, height: 728 };
  const b = layout.initial(specs.workspace, area, null, 0);
  assert.deepEqual(b, { x: 24, y: 24, width: 1318, height: 680 });
  inside(b, area);
});

check('极小远程桌面仍能完整找回窗口', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 };
  const b = layout.initial(specs.workspace, area, null, 0);
  assert.deepEqual(b, { x: 24, y: 24, width: 752, height: 552 });
  inside(b, area);
});

check('副屏使用负坐标时仍在对应工作区内居中', () => {
  const area = { x: -1600, y: 0, width: 1600, height: 900 };
  const b = layout.initial(specs.workspace, area, null, 0);
  assert.deepEqual(b, { x: -1530, y: 24, width: 1460, height: 852 });
  inside(b, area);
});

check('从发起窗口打开表单时相对定位且不会越界', () => {
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  const anchor = { x: 1040, y: 520, width: 200, height: 160 };
  const b = layout.initial(specs.add, area, anchor, 0);
  assert.deepEqual(b, { x: 100, y: 48, width: 1180, height: 672 });
  inside(b, area);
});

check('配置工具首次打开贴近屏幕右侧但留出边距', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = layout.initial(specs.settings, area, null, 0);
  assert.deepEqual(b, { x: 1136, y: 24, width: 760, height: 760 });
  inside(b, area);
});

check('保存的超大尺寸和屏外坐标会被完整收回', () => {
  const area = { x: 0, y: 0, width: 1440, height: 860 };
  const saved = { x: 1200, y: 700, width: 2400, height: 1800 };
  const b = layout.restored(specs.workspace, area, saved);
  assert.deepEqual(b, { x: 48, y: 48, width: 1392, height: 812 });
  inside(b, area);
});

check('同屏窗口只做有限错位且第四次回到基准位置', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const base = layout.initial(specs.console, area, null, 0);
  const third = layout.initial(specs.console, area, null, 3);
  const fourth = layout.initial(specs.console, area, null, 4);
  assert.deepEqual(fourth, base);
  assert.ok(third.x > base.x && third.y > base.y);
  inside(third, area);
});

process.stdout.write(`\nwindow layout: ${passed} passed, 0 failed\n`);
