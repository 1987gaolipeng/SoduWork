'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { epoch, project } = require('../main/conversation/cloud-timing');
const start = Date.UTC(2026, 9, 24, 3, 0, 0);
test('cloud timing normalizes Hub UTC timestamps and legacy Runner seconds', () => {
  for (const value of ['2026-10-24T03:00:00', '2026-10-24T03:00:00Z',
    '2026-10-24T11:00:00+08:00', start, start / 1000]) assert.equal(epoch(value), start);
  assert.equal(project({ status: 'running', startedAt: '2026-10-24T03:00:00' }, start + 14000).elapsedMs, 14000);
  assert.equal(project({ status: 'running', started: start / 1000 }, start + 14000).elapsedMs, 14000);
});
test('cloud terminal timing stays fixed and missing facts stay unknown', () => {
  const page = { status: 'done', startedAt: new Date(start).toISOString(), finishedAt: new Date(start + 85000).toISOString() };
  assert.equal(project(page, start + 86400000).elapsedMs, 85000);
  assert.equal(project(page, start + 864000000).elapsedMs, 85000);
  assert.equal(project({ status: 'done', startedAt: page.startedAt }).elapsedMs, null);
  assert.equal(project({ status: 'running', startedAt: new Date(start + 1000).toISOString() }, start).elapsedMs, null);
  assert.equal(project({ status: 'running' }).elapsedMs, null);
  assert.equal(project(null).elapsedMs, null);
});
test('remote turn boundaries distinguish resumed rounds on the same execution', () => {
  assert.notEqual(project({ref:'run',round:1,started:start/1000}).timingTurn,
    project({ref:'run',round:2,started:(start+1000)/1000}).timingTurn);
});
