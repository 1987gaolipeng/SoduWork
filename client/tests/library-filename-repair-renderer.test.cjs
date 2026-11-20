'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-library.js'), 'utf8');

function fixture(answer) {
  const calls = [], prompts = [], errors = [], notifications = [], events = new Map();
  let finish;
  const pending = answer === undefined ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(answer);
  const context = {
    setTimeout, clearTimeout, console,
    addEventListener: (type, fn) => events.set(type, fn),
    document: {},
    SoduWorkLibraryDialogs: { create: () => ({
      openNameDialog: options => { prompts.push(options); return pending; },
      showError: async (error, fallback) => errors.push({ error, fallback }), close() {},
    }) },
    SoduWorkAPI: {
      repairLocalLibraryFilename: async (...args) => { calls.push(['repair', ...args]); },
      updateLibraryItem: async (...args) => { calls.push(['update', ...args]); },
    },
    SoduWorkLibraryFileIcons: { markup: () => '<svg></svg>' },
    petSay: value => notifications.push(value),
  };
  context.window = context;
  vm.createContext(context);
  const seam = '  global.openLibraryPanel = openLibraryPanel;';
  assert.equal(source.split(seam).length, 2);
  vm.runInContext(source.replace(seam, `
    load = async () => {};
    global.review = { state, repairFilename, renameItem, itemActions, itemRow };
${seam}`), context);
  return { ...context.review, context, calls, prompts, errors, notifications, finish,
    switchAccount: () => events.get('soduwork-data-scope-changed')(),
    button: { disabled: false, isConnected: true, hasAttribute: () => false } };
}

const local = { id: 'local-fixture', title: 'Visible title', filename: 'legacy.p', backend: 'local', kind: 'file', size: 12 };

test('filename repair asks for the full stored name and submits an explicit extension without using title rename', async () => {
  const f = fixture('recovered.pdf');
  f.state.items = [local];
  await f.repairFilename(f.button, local.id);
  assert.equal(f.prompts[0].value, 'legacy.p');
  assert.match(f.prompts[0].label, /扩展名/);
  assert.match(f.prompts[0].description, /不转换文件格式/);
  assert.deepEqual(f.calls, [['repair', local.id, 'recovered.pdf']]);
  assert.equal(f.errors.length, 0);
  assert.equal(f.notifications.at(-1), '文件名已修复');
  assert.equal(f.button.disabled, false);
});

test('cancelling the filename dialog does not mutate the library', async () => {
  const f = fixture(''); f.state.items = [local];
  await f.repairFilename(f.button, local.id);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.notifications, []);
});

test('confirming the current filename still repairs a differing legacy display title', async () => {
  const f = fixture('legacy.p'); f.state.items = [local];
  await f.repairFilename(f.button, local.id);
  assert.equal(f.prompts[0].value, local.filename);
  assert.deepEqual(f.calls, [['repair', local.id, 'legacy.p']]);
});

test('a filename dialog accepted after an account switch cannot send an old selection', async () => {
  const f = fixture(); f.state.items = [local];
  const operation = f.repairFilename(f.button, local.id);
  assert.equal(f.prompts.length, 1);
  f.switchAccount();
  f.finish('late.pdf');
  await operation;
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.notifications, []);
});

test('repair remains available for every active local file but never remote, historical or trashed files', async () => {
  const f = fixture('unused.pdf');
  for (const filenameIssue of [undefined, 'duplicate', 'invalid', 'check']) {
    const row = { ...local, filenameIssue };
    assert.match(f.itemActions(row), /data-library-repair-filename="local-fixture"/);
    const html = f.itemRow(row);
    assert.equal(html.includes('请核对文件名'), Boolean(filenameIssue));
    assert.doesNotMatch(html, /文件损坏/);
  }
  for (const row of [
    { ...local, id: 'remote-fixture', backend: 'nfs', filenameIssue: 'check' },
    { ...local, id: 'history-fixture', storageOrigin: 'server-history', filenameIssue: 'check' },
  ]) {
    f.state.items = [row];
    assert.doesNotMatch(f.itemActions(row), /data-library-repair-filename/);
    assert.doesNotMatch(f.itemRow(row), /请核对文件名/);
    await f.repairFilename(f.button, row.id);
  }
  f.state.scope = 'trash'; f.state.items = [local];
  assert.doesNotMatch(f.itemActions(local), /data-library-repair-filename/);
  await f.repairFilename(f.button, local.id);
  assert.deepEqual(f.calls, []);
  assert.equal(f.prompts.length, 0);
});

test('a pending repair is cancelled when its item leaves the current listing or the user enters trash', async () => {
  for (const change of [f => { f.state.items = []; }, f => { f.state.scope = 'trash'; }]) {
    const f = fixture(); f.state.items = [local];
    const operation = f.repairFilename(f.button, local.id);
    change(f); f.finish('late.pdf');
    await operation;
    assert.deepEqual(f.calls, []);
  }
});

test('ordinary rename keeps the title-only update contract', async () => {
  const f = fixture('Normal title'); f.state.items = [local];
  await f.renameItem(f.button, local.id);
  assert.equal(f.prompts[0].value, 'Visible title.p');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['update', local.id, { title: 'Normal title' }]]);
});

test('failed repair retains the row, reports the error and releases the action', async () => {
  const f = fixture('duplicate.pdf'); f.state.items = [local];
  const failure = Error('The filename is already used');
  f.context.SoduWorkAPI.repairLocalLibraryFilename = async () => { throw failure; };
  await f.repairFilename(f.button, local.id);
  assert.equal(f.state.items[0], local);
  assert.equal(f.errors[0].error, failure);
  assert.equal(f.errors[0].fallback, '文件名修复失败');
  assert.deepEqual(f.notifications, []);
  assert.equal(f.button.disabled, false);
});
