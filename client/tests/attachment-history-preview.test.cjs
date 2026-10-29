'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contract = require('../main/pi-session/attachment-contract');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-image-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('soduwork-history-image-'));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const cwd = path.join(root, 'project'), work = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZioAAAAASUVORK5CYII=', 'base64');
  const write = name => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes);
    return target;
  };
  let messages = [], current = true;
  const handle = {cwd, snapshot: () => ({messages})}, handlers = new Map();
  require('../main/pi-session/artifact-ipc').install({app: {getPath: () => root},
    ipcMain: {handle: (name, fn) => handlers.set(name, fn)}, BrowserWindow: {}, workDir: () => work,
    session: {get: ref => current && ref === 'chat-reopened' ? handle : null}});
  return {root, bytes, write, handle,
    record(target, role = 'user') {
      // Round trip through the same legacy message protocol used by history.
      messages = [{role, attachments: contract.parse(contract.augment('旧图片', [{path: target, name: '旧图片.png'}])).files}];
    },
    close() { current = false; },
    read: target => handlers.get('pi-session-attachment-image')({}, 'chat-reopened', contract.previewRef(target), 'full'),
    copy: target => handlers.get('pi-session-copy-attachment-image')({}, 'chat-reopened', contract.previewRef(target)),
  };
}

test('reopened history reads the exact recorded image from its original runtime staging folder', async t => {
  const f = fixture(t), target = f.write('work/temp/chat-original/.soduwork-inputs/old.png');
  f.record(target);
  const result = await f.read(target);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(Buffer.from(result.data, 'base64'), f.bytes);
  assert.equal(result.mimeType, 'image/png');
});

test('current workspace and current staging attachments still preview normally', async t => {
  const f = fixture(t);
  for (const target of [f.write('project/current.png'), f.write('work/temp/chat-reopened/.soduwork-inputs/current.png')]) {
    const result = await f.read(target);
    assert.equal(result.ok, true, result.reason);
  }
  assert.equal((await f.read('current.png')).ok, true);
});

test('history authorization never grants its sibling files, another conversation or arbitrary recorded paths', async t => {
  const f = fixture(t), own = f.write('work/temp/chat-original/.soduwork-inputs/own.png');
  f.record(own);
  for (const other of [f.write('work/temp/chat-original/.soduwork-inputs/sibling.png'),
    f.write('work/temp/chat-other/.soduwork-inputs/other.png')]) {
    assert.equal((await f.read(other)).ok, false);
    assert.equal((await f.copy(other)).ok, false);
  }
  for (const outside of [f.write('outside.png'), f.write('work/temp/chat-original/not-input.png')]) {
    f.record(outside);
    assert.equal((await f.read(outside)).ok, false);
  }
  f.record(own, 'assistant');
  assert.equal((await f.read(own)).ok, false);
  f.record(own); f.close();
  assert.equal((await f.read(own)).ok, false);
});

test('history preview rejects directory junctions escaping the original staging location', async t => {
  const f = fixture(t), outside = f.write('outside/image.png');
  const link = path.join(f.root, 'work/temp/chat-original/.soduwork-inputs');
  fs.mkdirSync(path.dirname(link), {recursive: true});
  fs.symlinkSync(path.dirname(outside), link, process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(link, 'image.png');
  f.record(target);
  assert.equal((await f.read(target)).ok, false);
});

test('missing historic images fail explicitly without substituting a same-name current image', async t => {
  const f = fixture(t), target = f.write('work/temp/chat-original/.soduwork-inputs/gone.png');
  f.write('work/temp/chat-reopened/.soduwork-inputs/gone.png');
  f.record(target); fs.unlinkSync(target);
  const result = await f.read(target);
  assert.equal(result.ok, false);
  assert.match(result.reason, /ENOENT/);
});
