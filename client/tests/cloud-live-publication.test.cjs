'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const cloud = require('../main/conversation/cloud-handoff');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { create: createOwners } = require('../main/pi-session/session-owner.cjs');

function identity(uid = 'alice') {
  const now = Math.floor(Date.now() / 1000);
  return { hub: 'http://127.0.0.1:18989', clientId: 'desktop',
    session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'desktop', iat: now - 10, exp: now + 3600 }))
      .toString('base64url') + '.' + 'a'.repeat(64) };
}

test('cloud polling publishes through the owned registry view after desktop continuation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-publication-'));
  const app = { getPath: () => root };
  let current = identity(), sent = false, detached = 0, notifications = [], nativeNotify;
  const owners = createOwners({ app, cachedIdentity: () => current, localOwner: () => '', enrollmentIdentity: () => current });
  const bridge = createPiSessionBridge({ runnerAdapters: [], sessionModule: {
    open: () => assert.fail('must not start local execution'), probe: () => assert.fail('must not probe local execution'),
  } });
  t.after(async () => { await bridge.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const request = async (_identity, route) => {
    if (route.startsWith('/cloud-conversations')) return { ok: true, chats: [{
      id: 'mobile-n1', taskId: 'task-n1', ref: 'runner-ref', title: 'N1', state: 'done', canSend: true,
    }] };
    if (route.endsWith('/ai-say')) { sent = true; return { ok: true, ref: 'runner-ref', state: 'running' }; }
    if (route.includes('/ai-session?')) {
      const since = Number(new URL('http://fixture' + route).searchParams.get('since'));
      const items = [{ seq: 1, kind: 'user', text: 'Original mobile input' },
        { seq: 2, kind: 'say', text: 'Original reply' },
        ...(sent ? [{ seq: 3, kind: 'user', text: 'Desktop continuation' },
          { seq: 4, kind: 'say', text: 'New cloud reply' }] : [])];
      return { ok: true, ref: 'runner-ref', status: 'completed', last: sent ? 4 : 2,
        items: items.filter(item => item.seq > since) };
    }
    if (route.endsWith('/ai-status')) return { ok: true, status: 'completed' };
    if (route.endsWith('/attachments')) return [];
    assert.fail('Unexpected request: ' + route);
  };
  const filename = require.resolve('../main/conversation/cloud-handoff-ipc');
  const nativeRequire = createRequire(filename);
  const sandbox = { module: { exports: {} }, require: name => name === './cloud-handoff' ? {
    create(options) { nativeNotify = options.notify; return cloud.create({ ...options, request, interval: 10 }); },
  } : nativeRequire(name) };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), sandbox, { filename });
  const controller = sandbox.module.exports.install({ app, ipcMain: { handle() {} }, identityOf: async () => current,
    session: { setExternalHistory: source => bridge.setExternalHistory(source),
      get: ref => { const handle = bridge.get(ref); return owners.canAccess(handle) ? handle : null; } },
    notify(handle) {
      // This is the same ownership fence that detaches rejected PC publications.
      if (!owners.canAccess(handle)) { handle.detached = true; detached++; return; }
      notifications.push({ handle, snapshot: handle.snapshot() });
    } });
  await controller.history();
  const raw = await controller.reopen('mobile-n1', 'desktop-view');
  const active = bridge.attachView(raw);
  owners.bind(active, current, { connection: true });
  active.detached = false;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(detached, 0, 'a native callback must not detach the registered view');
  assert.equal((await controller.send(active, 'Desktop continuation', [])).ok, true);
  for (let attempt = 0; attempt < 50 && !notifications.some(n => JSON.stringify(n.snapshot).includes('New cloud reply')); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(detached, 0);
  assert.equal(raw.detached, false);
  assert.ok(notifications.length > 0);
  assert.ok(notifications.every(n => n.handle === active));
  const latest = notifications.at(-1).snapshot;
  for (const text of ['Original reply', 'Desktop continuation', 'New cloud reply']) {
    assert.ok(JSON.stringify(latest).includes(text), text);
  }
  const count = notifications.length;
  nativeNotify({ ref: raw.ref }, { kind: 'settled' });
  assert.equal(notifications.length, count, 'a reused ref cannot publish from another native object');
  current = identity('bob');
  nativeNotify(raw, { kind: 'settled' });
  assert.equal(notifications.length, count, 'an account change blocks old publications');
  await active.close();
  nativeNotify(raw, { kind: 'settled' });
  assert.equal(notifications.length, count, 'disposed views cannot publish');
});
