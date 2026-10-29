'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function submitter() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-submit.js'), 'utf8'), { window });
  return window.ComposeDraftSubmit.submit;
}
test('retry retains one persisted Task and uploads only missing materials before AI dispatch', async () => {
  const submit = submitter(), state = { id: 'single-task' }, first = { name: 'brief.md' }, second = { name: 'diagram.png' };
  const calls = { created: 0, uploads: [], dispatches: 0, stored: 0 };
  let failed = false;
  const context = {
    files: [first, second],
    create: async id => { calls.created++; return { id, title: 'Requirement' }; },
    onStored: () => calls.stored++,
    upload: async (id, file) => {
      calls.uploads.push([id, file.name]);
      if (file === second && !failed) { failed = true; throw Error('offline'); }
      return { id: file.name };
    },
    dispatch: async task => { calls.dispatches++; assert.equal(task.id, 'single-task'); return { who: 'AI' }; },
  };
  await assert.rejects(submit(state, context), /diagram.png/);
  assert.equal(calls.created, 1); assert.equal(calls.stored, 1); assert.equal(calls.dispatches, 0);
  const result = await submit(state, { create: () => { throw Error('must retain original context'); } });
  assert.equal(result.id, 'single-task'); assert.equal(result.outcome.who, 'AI');
  assert.deepEqual(Array.from(result.attachments, file => [file.id, file.filename]),
    [['brief.md', 'brief.md'], ['diagram.png', 'diagram.png']]);
  assert.equal(calls.created, 1); assert.equal(calls.dispatches, 1);
  assert.deepEqual(calls.uploads.map(row => row[1]), ['brief.md', 'diagram.png', 'diagram.png']);
  await submit(state, context); assert.equal(calls.dispatches, 1);
});
test('concurrent submit clicks share one request, upload and dispatch', async () => {
  const submit = submitter(), state = { id: 'single-task' };
  let release, created = 0, dispatched = 0;
  const context = { files: [], create: id => { created++; return new Promise(resolve => { release = () => resolve({ id }); }); },
    dispatch: async () => { dispatched++; return {}; } };
  const one = submit(state, context), two = submit(state, context);
  release(); const results = await Promise.all([one, two]);
  assert.equal(created, 1); assert.equal(dispatched, 1); assert.equal(results[0].id, results[1].id);
});
test('failed creation retries the same id without uploading or dispatching prematurely', async () => {
  const submit = submitter(), state = { id: 'stable-request-id' }, ids = [];
  let count = 0;
  const context = { files: [], create: async id => { ids.push(id); if (++count === 1) throw Error('offline'); return { id }; },
    dispatch: async () => ({}) };
  await assert.rejects(submit(state, context), /offline/);
  assert.equal(state.stored, undefined);
  await submit(state, context);
  assert.deepEqual(ids, ['stable-request-id', 'stable-request-id']);
});
test('missing uploader cannot silently discard user materials', async () => {
  const submit = submitter(), state = { id: 'material-task' }; let dispatched = 0;
  await assert.rejects(submit(state, { files: [{ name: 'requirements.md' }], create: async id => ({ id }),
    dispatch: async () => { dispatched++; } }), /requirements.md/);
  assert.equal(dispatched, 0); assert.equal(state.stored.id, 'material-task');
});
test('缺少服务端附件标识时不能把材料显示为保存成功', async () => {
  const submit = submitter(), state = { id: 'material-task' }; let dispatched = 0;
  await assert.rejects(submit(state, { files: [{ name: '缺陷文档.md' }], create: async id => ({ id }),
    upload: async () => ({ ok: true }), dispatch: async () => { dispatched++; } }), /附件未上传/);
  assert.equal(dispatched, 0); assert.equal(state.uploaded.size, 0);
});
test('closing a draft observer does not duplicate or interrupt a persisted submission', async () => {
  const submit = submitter(), state = { id: 'persisted' }; let dispatched = 0;
  const result = await submit(state, { files: [], create: async id => ({ id }), onStored: () => { throw Error('view closed'); },
    dispatch: async () => { dispatched++; return {}; } });
  assert.equal(result.id, 'persisted'); assert.equal(dispatched, 1);
});

test('identity change after persistence stops uploads and dispatch, including retries', async () => {
  const submit = submitter(), state = { id: 'old-account' };
  let identity = 'first', uploaded = 0, dispatched = 0;
  const context = { files: [{name:'private.md'}],
    guard: () => { if (identity !== 'first') throw Error('identity changed'); },
    create: async id => { identity = 'second'; return {id}; },
    upload: async () => { uploaded++; return {}; }, dispatch: async () => { dispatched++; return {}; } };
  await assert.rejects(submit(state, context), /identity changed/);
  await assert.rejects(submit(state, {guard:()=>{},files:[]}), /identity changed/);
  assert.equal(uploaded, 0); assert.equal(dispatched, 0);
});

test('提交失败交给当前宿主弹窗处理，回调异常仍保留默认错误提示', async () => {
  for (const throws of [false, true]) {
    const notices = [], errors = [], window = { SoduWorkAPI: { taskStorageKey: () => 'scope' },
      petSay: message => notices.push(message) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-submit.js'), 'utf8'), { window });
    const options = { onBeforeSubmit: async () => { throw Error('草稿保存失败'); },
      onSubmitError: (error, detail) => { errors.push([error.message, detail.stored]); if (throws) throw Error('view removed'); return true; } };
    const record = window.ComposeDraftSubmit.card(options), state = {}, btn = {};
    await window.ComposeDraftSubmit.createRequirement({ draft: { who: { kind: 'me' } }, options, state,
      card: record, btn, current: () => true, box: { querySelectorAll: () => [], querySelector: () => null } });
    assert.deepEqual(errors, [['草稿保存失败', false]]);
    assert.equal(record.phase, 'error'); assert.equal(btn.disabled, false);
    assert.equal(notices.length, throws ? 1 : 0);
  }
});
