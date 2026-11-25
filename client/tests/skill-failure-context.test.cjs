'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const context = require('../main/pi-session/skill-failure-context.cjs');
const { readScope } = require('../main/conversation/history-access');

function identity(uid) {
  const iat = Math.floor(Date.now() / 1000);
  const claims = { uid, typ: 'device', cid: 'fixture', iat, exp: iat + 3600 };
  return { hub: 'https://example.invalid', clientId: claims.cid,
    session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + '0'.repeat(64) };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, owner = identity('owner');
  const win = { isDestroyed: () => false }, frame = {}, event = { sender: { mainFrame: frame }, senderFrame: frame };
  const snapshot = { messages: [{ role: 'user', text: 'prior turn', submissionId: 'previous' },
    { role: 'user', text: 'Validate password=synthetic-private', submissionId: 'turn', attachments: [{ name: 'input.csv' }] },
    { role: 'assistant' }, { role: 'user', text: 'ordinary turn', submissionId: 'plain' }],
    tools: [{ id: 'ok', state: 'done', after: 1 }, { id: 'failed', state: 'error', after: 2 },
      { id: 'unrelated', isError: true, after: 3 }] };
  const full = { id: 'failed', name: 'validate', args: { threshold: 3, nested: { token: 'synthetic-private' },
    environment: { EXAMPLE: 'synthetic-private' } }, result: 'Invalid header. password=synthetic-private' };
  const handle = { attachedWindow: win, cwd: root, sessionId: 'local-id', snapshot: () => snapshot, toolDetail: () => full };
  const request = context.handler({ session: { get: ref => ref === 'chat' && handle }, BrowserWindow: { fromWebContents: () => win } });
  context.bind(app, handle, owner);
  return { root, app, owner, win, event, snapshot, handle, request, full };
}

test('only the failed skill turn can produce a local, redacted and reopenable report', async t => {
  const f = fixture(t);
  assert.equal(context.summary(f.handle, f.snapshot), null);
  context.prepared(f.handle, 'turn', [{ name: 'validator', version: '1.2.3' }]);
  assert.deepEqual(context.summary(f.handle, f.snapshot), { id: 'failed' });
  for (const id of ['ok', 'unrelated', 'missing']) assert.equal((await f.request(f.event, 'chat', id)).ok, false);
  const result = await f.request(f.event, 'chat', 'failed');
  assert.ok(result.ok && !result.unsaved);
  const report = result.report;
  assert.deepEqual(report.skills, [{ name: 'validator', version: '1.2.3' }]);
  assert.match(report.prompt, /Validate/); assert.deepEqual(report.files, ['input.csv']);
  assert.equal(JSON.parse(report.input).threshold, 3); assert.match(report.output, /Invalid header/);
  assert.ok(report.system && report.node && report.cwd);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private|prior turn|ordinary turn/);
  const dir = path.join(f.root, 'skill-failure-context'), [filename] = fs.readdirSync(dir);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, filename), 'utf8'), /synthetic-private/);
  const resumed = { ...f.handle, snapshot: () => ({}) };
  context.bind(f.app, resumed, identity('another-owner'));
  assert.equal(context.summary(resumed, {}), null);
  context.bind(f.app, resumed, f.owner);
  assert.deepEqual(context.summary(resumed, {}), { id: 'failed' });
  const reload = context.handler({ session: { get: () => resumed }, BrowserWindow: { fromWebContents: () => f.win } });
  assert.deepEqual((await reload(f.event, 'chat', 'failed')).report, report);
  context.remove(f.app, readScope(f.owner), [f.handle.sessionId]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('another frame, window, session or a detach during a receipt read cannot obtain the report', async t => {
  const f = fixture(t);
  context.prepared(f.handle, 'turn', [{ name: 'validator', checksum: 'v1' }]);
  assert.equal((await f.request({ ...f.event, senderFrame: {} }, 'chat', 'failed')).ok, false);
  assert.equal((await f.request(f.event, 'another-chat', 'failed')).ok, false);
  f.handle.attachedWindow = {};
  assert.equal((await f.request(f.event, 'chat', 'failed')).ok, false);
  f.handle.attachedWindow = f.win;
  f.handle.toolDetail = async () => { f.handle.detached = true; return f.full; };
  assert.equal((await f.request(f.event, 'chat', 'failed')).ok, false);
});
