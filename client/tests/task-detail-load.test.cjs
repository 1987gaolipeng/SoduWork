'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
function fixture() {
  const calls = [], context = {detailId: null, visible: true,
    document: {querySelector: () => context.visible ? {} : null},
    openDetailEntry: id => {calls.push(['open', id]); return 'opened';},
    RequirementsDetail: {open: () => {throw new Error('A live refresh must not reopen the drawer');},
      refresh: id => {calls.push(['refresh', id]); return Promise.resolve();}},
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-detail.js'), 'utf8'), context);
  return {context, calls};
}
test('stored detail links delegate to the single requirement entry without rendering another page', () => {
  const {context, calls} = fixture();
  assert.equal(context.openDetail(123), 'opened');
  assert.equal(context.detailId, '123');
  assert.deepEqual(calls, [['open', '123']]);
});
test('legacy refresh callbacks only refresh a matching visible requirement drawer', async () => {
  const {context, calls} = fixture(); context.detailId = 'task';
  await context.refreshOpenDetail('another'); assert.deepEqual(calls, []);
  context.visible = false; await context.refreshOpenDetail('task'); assert.deepEqual(calls, []);
  context.visible = true; await context.refreshOpenDetail('task');
  assert.deepEqual(calls, [['refresh', 'task']]);
});
