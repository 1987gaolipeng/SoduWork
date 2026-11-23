'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t, fileSystem = fs, platform = process.platform) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-work-root-picker-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const app = { getPath: name => path.join(temporary, name) };
  fs.mkdirSync(app.getPath('userData'));
  const file = path.resolve(__dirname, '../main/pi-session/environment-ipc.js');
  const localRequire = createRequire(file);
  const module = { exports: {} };
  const owner = {};
  const picker = { result: { canceled: true, filePaths: [] }, calls: [] };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, console, Promise, setTimeout, clearTimeout, process: { platform },
    require(name) {
      if (name === 'fs') return fileSystem;
      if (name === 'electron') return {
        shell: {}, BrowserWindow: { fromWebContents: () => owner },
        dialog: { async showOpenDialog(parent, options) {
          picker.calls.push({ parent, options });
          return picker.result;
        } },
      };
      if (name === '../native-locale.cjs') return { dialogOptions: value => value };
      return localRequire(name);
    },
  }, { filename: file });
  const config = module.exports.createConfiguration(() => app);
  const handlers = new Map();
  function install(save = config._saveConf) {
    module.exports.install({ app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      session: {}, identityOf: async () => ({}), capabilityGrantsOf: () => [],
      _skillDirs: () => [], ...config, _saveConf: save });
  }
  install();
  return { temporary, app, picker, owner, config, install,
    reopen: () => module.exports.createConfiguration(() => app),
    select: options => handlers.get('pi-session-pick-workdir')({ sender: {} }, options),
    save: dir => handlers.get('pi-session-save-workdir')({ sender: {} }, dir) };
}

test('native folder selection persists the chosen directory for new conversations after restart', async t => {
  const f = fixture(t);
  const selected = path.join(f.temporary, 'selected folder');
  fs.mkdirSync(selected);
  f.picker.result = { canceled: false, filePaths: [selected] };
  f.config._saveConf({ workDir: f.temporary });
  const result = await f.select({ defaultPath: f.temporary, persist: false });
  assert.equal(result.ok, true);
  assert.equal(result.dir, selected);
  assert.deepEqual(fs.readdirSync(selected), []);
  assert.equal(f.config.workDir(f.app), f.temporary, 'selection alone must not change the native root');
  assert.equal((await f.save(result.dir)).ok, true);
  assert.equal(f.picker.calls[0].parent, f.owner);
  assert.equal(f.picker.calls[0].options.defaultPath, f.temporary);
  assert.deepEqual(Array.from(f.picker.calls[0].options.properties), ['openDirectory', 'createDirectory']);
  const restarted = f.reopen();
  assert.equal(restarted.workDir(f.app), selected);
  assert.equal(restarted._newSessionCwd(f.app, 'next-chat', {}), path.join(selected, 'temp', 'next-chat'));
});

test('canceling the native picker preserves the persisted directory', async t => {
  const f = fixture(t);
  f.config._saveConf({ workDir: f.temporary });
  const before = fs.readFileSync(path.join(f.app.getPath('userData'), 'chat-config.json'), 'utf8');
  const result = await f.select();
  assert.equal(result.canceled, true);
  assert.equal(f.picker.calls[0].options.defaultPath, f.temporary);
  assert.equal(fs.readFileSync(path.join(f.app.getPath('userData'), 'chat-config.json'), 'utf8'), before);
});

test('a writable filesystem root retains its absolute path when selected', async t => {
  const f = fixture(t, { ...fs, accessSync() {},
    mkdtempSync: prefix => fs.mkdtempSync(path.join(os.tmpdir(), path.basename(prefix))) });
  const selected = path.parse(f.temporary).root;
  f.picker.result = { canceled: false, filePaths: [selected] };
  const result = await f.select({ defaultPath: selected });
  assert.equal(result.ok, true);
  assert.equal(f.picker.calls[0].options.defaultPath, selected);
  assert.equal(f.reopen()._conf().workDir, selected);
  assert.equal(path.isAbsolute(result.dir), true);
});

test('a failed settings write does not report a successful directory change', async t => {
  const f = fixture(t);
  const selected = path.join(f.temporary, 'new');
  fs.mkdirSync(selected);
  f.config._saveConf({ workDir: f.temporary });
  f.install(patch => ({ ...f.config._conf(), ...patch }));
  f.picker.result = { canceled: false, filePaths: [selected] };
  const result = await f.save(selected);
  assert.equal(result.ok, false);
  assert.equal(result.reason, '无法保存工作目录，请重试');
  assert.equal(f.reopen().workDir(f.app), f.temporary);
});

test('saving an invalid directory preserves the native work root', async t => {
  const f = fixture(t);
  f.config._saveConf({ workDir: f.temporary });
  const ordinaryFile = path.join(f.temporary, 'file.txt');
  fs.writeFileSync(ordinaryFile, 'not a directory');
  for (const dir of ['', 'relative/path', ordinaryFile, path.join(f.temporary, 'missing')]) {
    assert.equal((await f.save(dir)).ok, false);
    assert.equal(f.reopen().workDir(f.app), f.temporary);
  }
});

test('unusable picker results report a reason and preserve the saved directory', async t => {
  const f = fixture(t);
  f.config._saveConf({ workDir: f.temporary });
  const ordinaryFile = path.join(f.temporary, 'file.txt');
  fs.writeFileSync(ordinaryFile, 'not a directory');
  for (const selected of [ordinaryFile, path.join(f.temporary, 'unmounted')]) {
    f.picker.result = { canceled: false, filePaths: [selected] };
    for (const persist of [false, true]) {
      const result = await f.select({ persist });
      assert.equal(result.ok, false);
      assert.ok(result.reason);
      assert.equal(f.reopen()._conf().workDir, f.temporary);
    }
  }
});

test('read-only folders cannot be returned by the picker or saved directly', async t => {
  const f = fixture(t, { ...fs, accessSync(dir, mode) {
    if (mode & fs.constants.W_OK) throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' });
    fs.accessSync(dir, mode);
  } });
  f.config._saveConf({ workDir: f.temporary });
  const selected = path.join(f.temporary, 'read-only');
  fs.mkdirSync(selected);
  f.picker.result = { canceled: false, filePaths: [selected] };
  for (const result of [await f.save(selected), await f.select({ persist: false }), await f.select()]) {
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  }
  assert.equal(f.reopen()._conf().workDir, f.temporary);
});

test('Windows folder ACLs can deny creation even after the access check succeeds', async t => {
  const f = fixture(t, { ...fs, accessSync() {}, mkdtempSync() {
    throw Object.assign(new Error('Access is denied'), { code: 'EPERM' });
  } }, 'win32');
  f.config._saveConf({ workDir: f.temporary });
  const selected = path.join(f.temporary, 'acl-protected');
  fs.mkdirSync(selected);
  assert.equal((await f.save(selected)).ok, false);
  assert.equal(f.reopen()._conf().workDir, f.temporary);
});
