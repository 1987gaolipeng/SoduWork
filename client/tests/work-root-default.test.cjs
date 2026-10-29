'use strict';





const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('main process preserves the public default workspace directory', t => {
  const main = read('main.js');
  const handler = main.match(/^ipcMain\.handle\('work-root-default', \(\) => \{[\s\S]*?^\}\);/m)?.[0];
  assert.ok(handler, '主进程必须注册默认工作目录 IPC');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-default-work-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  {
    let callback;
    const profile = require('../main/distribution.cjs').current();
    vm.runInNewContext(handler, { _distribution: { current: () => profile },
      ipcMain: { handle: (_, fn) => { callback = fn; } },
      require: name => name === 'os' ? { homedir: () => home } : require(name) });
    const expected = path.join(home, 'SoduWork');
    assert.equal(callback(), expected);
    assert.equal(fs.statSync(expected).isDirectory(), true);
  }
  assert.match(read('preload.js'), /getDefaultWorkRoot:.*work-root-default/);
});

test('渲染层没设置时自动采用默认，清空保存恢复默认', () => {
  const settings = read('components/settings/settings.js');
  assert.match(settings, /_ensureDefaultWorkRoot/);
  assert.match(settings, /getDefaultWorkRoot/);
  // Never overwrite an explicit workspace preference with automatic fallback.
  assert.match(settings, /if \(localStorage\.getItem\(_WORK_ROOT_KEY\)\) return/);
  // Clearing resets to the default workspace.
  assert.match(settings, /v \? localStorage\.setItem\(KEY, v\) : localStorage\.removeItem\(KEY\)/);
  assert.match(settings, /if \(!v\)\s*\{[\s\S]*?_ensureDefaultWorkRoot\(\)\.then\(/);
  // Preserve the shared legacy storage key for existing workspace preferences.
  assert.match(settings, /_WORK_ROOT_KEY = 'soduwork_work_root'/);
});
