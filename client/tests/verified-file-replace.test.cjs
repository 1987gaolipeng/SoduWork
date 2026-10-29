'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const os = require('node:os'), path = require('node:path');
const files = require('../main/verified-file-replace.cjs');
const failure = code => Object.assign(Error('injected ' + code), { code });

for (const sync of [false, true]) {
  const label = sync ? 'sync' : 'async';
  async function fixture(t) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-replace-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'next.tmp'), target = path.join(root, '成果.json');
    await fsp.writeFile(source, 'new content'); await fsp.writeFile(target, 'original content');
    const api = sync ? fs : fsp, copyKey = sync ? 'copyFileSync' : 'copyFile';
    const realCopy = api[copyKey].bind(api);
    t.mock.method(api, sync ? 'renameSync' : 'rename', sync
      ? () => { throw failure('EXDEV'); } : async () => { throw failure('EXDEV'); });
    const replace = () => sync ? files.replaceFileSync(source, target) : files.replaceFile(source, target);
    const reject = pattern => assert.rejects(async () => replace(), pattern);
    return { root, source, target, replace, reject, realCopy, mockCopy: fn => t.mock.method(api, copyKey, fn) };
  }
  test(label + ': EXDEV verifies replacement, preserves unrelated backups and removes source only on success', async t => {
    const f = await fixture(t), legacy = f.target + '.bak';
    await fsp.writeFile(legacy, 'user backup');
    await f.replace();
    assert.equal(await fsp.readFile(f.target, 'utf8'), 'new content');
    assert.equal(await fsp.readFile(legacy, 'utf8'), 'user backup');
    await assert.rejects(fsp.stat(f.source), { code: 'ENOENT' });
    assert.deepEqual((await fsp.readdir(f.root)).sort(), [path.basename(f.target), path.basename(legacy)].sort());
  });
  for (const stage of ['backup', 'target']) for (const throws of [false, true]) {
    test(label + ': ' + stage + ' copy ' + (throws ? 'failure' : 'corruption') + ' retains the complete original', async t => {
      const f = await fixture(t);
      const copy = (source, target, flags) => {
        const injected = stage === 'backup' ? source === f.target : source === f.source;
        if (!injected) return f.realCopy(source, target, flags);
        fs.writeFileSync(target, 'partial');
        if (throws) throw failure('EIO');
      };
      f.mockCopy(sync ? copy : async (...args) => copy(...args));
      await f.reject(throws ? /injected EIO/ : /完整性/);
      assert.equal(await fsp.readFile(f.target, 'utf8'), 'original content');
      assert.equal(await fsp.readFile(f.source, 'utf8'), 'new content');
      assert.deepEqual((await fsp.readdir(f.root)).sort(), ['next.tmp', path.basename(f.target)].sort());
    });
  }
  test(label + ': failed recovery retains a verified uniquely named backup', async t => {
    const f = await fixture(t);
    const copy = (source, target, flags) => {
      if (target === f.target) { fs.writeFileSync(target, 'partial'); throw failure('EIO'); }
      return f.realCopy(source, target, flags);
    };
    f.mockCopy(sync ? copy : async (...args) => copy(...args));
    await assert.rejects(async () => f.replace(), error => {
      assert.equal(error.code, 'EIO'); assert.equal(error.recoveryError.code, 'EIO');
      assert.equal(fs.readFileSync(error.recoveryPath, 'utf8'), 'original content'); return true;
    });
    assert.equal(await fsp.readFile(f.source, 'utf8'), 'new content');
  });
  test(label + ': non-EXDEV rename failures never copy or modify the target', async t => {
    const f = await fixture(t), api = sync ? fs : fsp;
    t.mock.method(api, sync ? 'renameSync' : 'rename', sync
      ? () => { throw failure('EACCES'); } : async () => { throw failure('EACCES'); });
    f.mockCopy(() => assert.fail('permission errors must not fall back to copying'));
    await f.reject({ code: 'EACCES' });
    assert.equal(await fsp.readFile(f.target, 'utf8'), 'original content');
  });
  test(label + ': a backup name collision does not overwrite or delete the existing backup', async t => {
    const f = await fixture(t); let collision;
    const copy = (source, target) => {
      assert.equal(source, f.target);
      collision = target; fs.writeFileSync(target, 'existing backup'); throw failure('EEXIST');
    };
    f.mockCopy(sync ? copy : async (...args) => copy(...args));
    await f.reject({ code: 'EEXIST' });
    assert.equal(await fsp.readFile(collision, 'utf8'), 'existing backup');
    assert.equal(await fsp.readFile(f.target, 'utf8'), 'original content');
  });
}
