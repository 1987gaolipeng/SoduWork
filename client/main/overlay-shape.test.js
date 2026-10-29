const assert = require('node:assert/strict');
const shape = require('./overlay-shape');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  PASS  ${name}\n`);
}

const bounds = { width: 1920, height: 1080 };

check('小数矩形向外取整，避免裁掉组件边缘', () => {
  assert.deepEqual(shape.normalize([{ x: 10.8, y: 20.2, width: 30.1, height: 40.1 }], bounds), [
    { x: 10, y: 20, width: 31, height: 41 },
  ]);
});

check('越过窗口边界的命中区会被裁回客户区', () => {
  assert.deepEqual(shape.normalize([{ x: -8, y: 1060, width: 30, height: 40 }], bounds), [
    { x: 0, y: 1060, width: 22, height: 20 },
  ]);
});

check('空结果停放在右下角一像素，不恢复成整屏透明窗', () => {
  assert.deepEqual(shape.resolve([], bounds), [{ x: 1919, y: 1079, width: 1, height: 1 }]);
});

check('只有竖条时补一个分离锚点，让 Windows 保持复杂原生区域', () => {
  const dock = { x: 1810, y: 220, width: 42, height: 205 };
  const applied = shape.resolve([dock], bounds);
  assert.equal(applied.length, 2);
  assert.deepEqual(applied[0], dock);
  assert.deepEqual(applied[1], { x: dock.x - 2, y: dock.y, width: 1, height: 1 });
  assert.equal(Math.max(...applied.map(r => r.x + r.width)) - Math.min(...applied.map(r => r.x)), dock.width + 2);
});

check('输入命中只看真实组件，不把原生稳定锚点算成可点击区域', () => {
  const dock = [{ x: 1810, y: 220, width: 42, height: 205 }];
  assert.equal(shape.containsPoint(dock, 1810, 220), true);
  assert.equal(shape.containsPoint(dock, 1851, 424), true);
  assert.equal(shape.containsPoint(dock, 1852, 424), false);
  assert.equal(shape.containsPoint(dock, 0, 0), false);
});

check('整窗业务区域不添加稳定锚点', () => {
  const full = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(shape.resolve([full], bounds), [full]);
});

check('非法、空尺寸与重复矩形不会进入原生窗口区域', () => {
  assert.deepEqual(shape.normalize([
    null,
    { x: 'bad', y: 0, width: 10, height: 10 },
    { x: 2, y: 3, width: 0, height: 8 },
    { x: 2, y: 3, width: 8, height: 9 },
    { x: 2, y: 3, width: 8, height: 9 },
  ], bounds), [{ x: 2, y: 3, width: 8, height: 9 }]);
});

check('上报矩形数量有硬上限', () => {
  const many = Array.from({ length: shape.MAX_RECTS + 20 }, (_, i) => ({ x: i * 2, y: 1, width: 1, height: 1 }));
  assert.equal(shape.normalize(many, bounds).length, shape.MAX_RECTS);
});

process.stdout.write(`\noverlay shape: ${passed} passed, 0 failed\n`);
