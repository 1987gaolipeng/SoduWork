'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../main/mobile-capabilities.cjs');
const plugins = require('../main/personal-plugins');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mobile-capability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let uid = 'owner';
  const app = { getPath: () => root };
  const identityOf = async () => ({ hub: 'https://fixture.invalid', clientId: 'pc',
    session: Buffer.from(JSON.stringify({ typ: 'device', cid: 'pc', uid })).toString('base64url') + '.fixture' });
  const opened = [], sent = [];
  const conversation = { open: async options => { opened.push(options); return { ok: true, sessionId: 'session', ref: 'ref' }; },
    send: async (...args) => { sent.push(args); return { ok: true }; }, sync: async () => {} };
  const deps = { app, identityOf, conversation, inspectSkills: async () => ({ ok: true, items: [], businessSkills: [] }),
    verifyRequest: async () => ({ ok: true }), fetchCatalog: async (_identity, route) => route === '/capabilities'
    ? { skills: [{ name: 'local skill', available: true, runtimeAvailable: true, token: 'do-not-expose' }] }
    : route === '/mcp-servers' ? { personal: [{ name: 'connector', headers: { Authorization: 'private' } }] }
    : { items: [{ name: 'market' }, { name: 'hidden', listed: false }, { name: 'personal', personal: true }] } };
  let handler = create(deps);
  let seq = 0;
  return { app, deps, opened, sent, switchAccount: () => { uid = 'other'; }, restart: () => { handler = create(deps); },
    call: (operation, args = {}, id = `request-${++seq}`) => handler({ operation, args, requestId: id,
      ownerUserId: 'owner', targetClientId: 'pc', expiresAt: Date.now() / 1000 + 90 }) };
}
const draft = { template: 'method', name: '手机方法', version: '0.1.0', description: '只回复测试内容', instructions: '按用户要求回复' };

test('expired or wrong-target requests cannot read or modify local plugins', async t => {
  const f = fixture(t), handler = create(f.deps);
  const request = { operation: 'plugin.install', args: { draft }, requestId: 'expired-request',
    ownerUserId: 'owner', targetClientId: 'pc', expiresAt: 0 };
  await assert.rejects(handler(request), /等待过久/);
  await assert.rejects(handler({ ...request, targetClientId: 'another', expiresAt: Date.now() / 1000 + 30 }), /账号已变化/);
  assert.equal(plugins.catalog(f.app, true).some(row => row.name === draft.name), false);
});

test('private-pipe input without Hub authorization cannot access the local catalog', async t => {
  const f = fixture(t);
  f.deps.verifyRequest = async () => { throw Error('invalid Hub ticket'); };
  f.restart();
  await assert.rejects(f.call('catalog'), /invalid Hub ticket/);
  await assert.rejects(f.call('plugin.install', { draft }), /invalid Hub ticket/);
  assert.equal(plugins.catalog(f.app, true).some(row => row.name === draft.name), false);
});

test('catalog comes from selected PC identity and excludes connector secrets and private market entries', async t => {
  const f = fixture(t), result = await f.call('catalog');
  assert.ok(result.plugins.length > 0);
  assert.deepEqual(result.skills, [{ name: 'local skill', available: true, runtimeAvailable: true, installed: true }]);
  assert.deepEqual(result.connectors, [{ name: 'connector' }]);
  assert.deepEqual(result.market, [{ name: 'market' }]);
});

test('skill catalog matches desktop policy and local installation filters', async t => {
  const f = fixture(t);
  f.deps.fetchCatalog = async () => ({ skills: [
    { name: 'blocked', available: false, portable: true },
    { name: 'hub-only', available: true },
    { name: 'local', available: true },
    { name: 'portable', available: true, portable: true },
  ] });
  f.deps.inspectSkills = async () => ({ ok: true, items: [{ skillName: 'local', available: true }] });
  f.restart();
  assert.deepEqual((await f.call('catalog')).skills.map(row => row.name), ['local', 'portable']);
});

test('skill switches use signed selected-PC preference writes with durable retry receipts', async t => {
  const f = fixture(t), writes = [], catalog = f.deps.fetchCatalog;
  f.deps.fetchCatalog = async (identity, route, body) => {
    if (route !== '/desktop-capabilities/skill-selection') return catalog(identity, route);
    writes.push({ identity, body });
    return { ok: true, ...body.request.args };
  };
  f.restart();
  const args = { name: 'local skill', enabled: false };
  assert.equal((await f.call('skill.set', args, 'switch-once')).enabled, false);
  f.restart();
  await f.call('skill.set', args, 'switch-once');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.request.targetClientId, 'pc');
  await assert.rejects(f.call('skill.set', { name: 'unknown', enabled: true }), /不可用/);
  await assert.rejects(f.call('skill.set', { name: 'local skill', enabled: 'true' }), /不正确/);
  f.switchAccount();
  await assert.rejects(f.call('skill.set', args), /账号已变化/);
  assert.equal(writes.length, 1);
});

test('create, edit, install and use reuse real personal plugin store with durable duplicate protection', async t => {
  const f = fixture(t);
  assert.equal((await f.call('plugin.preflight', { draft })).ok, true);
  const installed = await f.call('plugin.install', { draft }, 'install-first');
  assert.equal(installed.ok, true);
  const id = installed.plugin.pluginId;
  f.restart();
  assert.equal((await f.call('plugin.install', { draft }, 'install-first')).plugin.pluginId, id);
  await assert.rejects(f.call('plugin.install', { draft }), /已有同名/);
  const detail = (await f.call('plugin.get', { pluginId: id })).plugin;
  assert.equal(detail.localDraft.instructions, draft.instructions);
  const args = { pluginId: id, expectedChecksum: detail.checksum, draft: { ...detail.localDraft, version: '0.1.1', description: '更新用途' } };
  const updated = await f.call('plugin.install', args);
  assert.equal(updated.plugin.version, '0.1.1');
  await assert.rejects(f.call('plugin.install', args), /已有变化/);
  const use = { pluginId: id, expectedChecksum: updated.plugin.checksum, text: '只回复 OK' };
  assert.equal((await f.call('plugin.use', use, 'use-request')).sourceSessionId, 'session');
  f.restart();
  assert.equal((await f.call('plugin.use', use, 'use-request')).sourceSessionId, 'session');
  assert.equal(f.sent.length, 1);
  assert.equal(f.opened[0].pluginLock.checksum, updated.plugin.checksum);
  await assert.rejects(f.call('plugin.use', { ...use, text: 'different' }, 'use-request'), /编号已使用/);
});

test('account changes during catalog read never release prior-account results', async t => {
  const f = fixture(t);
  f.deps.fetchCatalog = async () => { f.switchAccount(); return { skills: [{ name: 'private' }] }; };
  f.restart();
  await assert.rejects(f.call('catalog'), /账号或服务已切换/);
  await assert.rejects(f.call('plugin.install', { draft }), /登录账号已变化/);
  assert.equal(plugins.catalog(f.app, true).some(row => row.name === draft.name), false);
});

test('catalog reports source failures and never pretends the list is empty and successful', async t => {
  const f = fixture(t);
  f.deps.fetchCatalog = async () => { throw Error('offline'); }; f.restart();
  const result = await f.call('catalog');
  assert.equal(result.errors.skills, 'offline');
  assert.equal(result.errors.connectors, 'offline');
  assert.equal(result.errors.market, 'offline');
});

test('interrupted native send is fenced across process restarts and cannot execute again', async t => {
  const f = fixture(t), installed = await f.call('plugin.install', { draft });
  f.deps.conversation.send = async () => { f.sent.push('attempt'); throw Error('connection lost'); };
  const args = { pluginId: installed.plugin.pluginId, expectedChecksum: installed.plugin.checksum, text: 'work' };
  await assert.rejects(f.call('plugin.use', args, 'uncertain-use'), /connection lost/);
  f.restart();
  await assert.rejects(f.call('plugin.use', args, 'uncertain-use'), /connection lost/);
  assert.equal(f.sent.length, 1);
});
