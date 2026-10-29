'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const personal = require('../main/personal-plugins');
const grant = require('../main/pi-session/plugin-grant');
const access = require('../main/plugin-source-access');

const body = { template: 'method', key: 'enterprise-derived', name: '企业改进副本', version: '1.0.0',
  description: '用于验证企业派生插件授权', instructions: '整理用户资料并交付总结。', sourcePluginId: 'source-plugin' };
const identity = { hub: 'https://hub.invalid', clientId: 'fixture-device', session: 'fixture-session' };
function response(canUse, canEdit) {
  return { ok: true, status: 200, json: async () => ({ canUse, canEdit }) };
}
function fixture(fetchImpl, identityOf = async () => identity) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-source-access-'));
  const handlers = new Map(), app = { isPackaged: false, getPath: () => root };
  personal.install({ app, identityOf, fetchImpl, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  return { root, app, handlers, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('native personal plugins preserve offline install and execution without identity requests', async () => {
  const f = fixture(() => { throw Error('must stay offline'); }, () => { throw Error('must stay offline'); });
  try {
    const localBody = { ...body }; delete localBody.sourcePluginId;
    const made = await f.handlers.get('personal-plugin-create')(null, localBody);
    const out = await grant.resolve({ app: f.app, pluginIds: [made.plugin.pluginId],
      identityOf: () => { throw Error('must stay offline'); } });
    assert.equal(out.items.length, 1);
    assert.equal(out.grant, null);
  } finally { f.close(); }
});

test('every sourced local turn checks use before materializing any resource and sees revocation', async () => {
  let allowed = true, calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; assert.equal(url, identity.hub + '/api/v1/plugins/source-plugin/permissions');
    assert.equal(options.headers.Authorization, 'Device fixture-session');
    return response(allowed, true);
  };
  const f = fixture(fetchImpl);
  try {
    const made = personal.create(f.app, { ...body,
      resources: [{ path: 'references/data.txt', kind: 'reference', encoding: 'utf8', content: 'fixture' }] });
    const options = { app: f.app, pluginIds: [made.plugin.pluginId], identityOf: async () => identity,
      fetchImpl, cwd: path.join(f.root, 'authorized') };
    fs.mkdirSync(options.cwd);
    const out = await grant.resolve(options);
    assert.equal(out.items.length, 1);
    allowed = false;
    await assert.rejects(grant.resolve({ ...options, cwd: path.join(f.root, 'revoked') }), /使用权限/);
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(path.join(f.root, 'revoked')), false);
  } finally { f.close(); }
});

test('edit-only grant can save improved drafts but cannot execute or configure a use session', async () => {
  const f = fixture(async () => response(false, true));
  try {
    const made = await f.handlers.get('personal-plugin-create')(null, body);
    assert.equal(made.plugin.localDraft.sourcePluginId, 'source-plugin');
    await assert.rejects(f.handlers.get('personal-plugin-resolve')(null, [made.plugin.pluginId]), /使用权限/);
    await assert.rejects(f.handlers.get('personal-plugin-configure')(null, made.plugin.pluginId, made.plugin.checksum, {}), /使用权限/);
    const detail = f.handlers.get('personal-plugin-get')(null, made.plugin.pluginId);
    assert.equal(detail.plugin.localDraft.sourcePluginId, 'source-plugin');
  } finally { f.close(); }
});

test('clearing or changing source cannot bypass saved lineage when saving or signing', async () => {
  let edit = true;
  const f = fixture(async () => response(true, edit));
  try {
    const made = await f.handlers.get('personal-plugin-create')(null, body);
    edit = false;
    await assert.rejects(f.handlers.get('personal-plugin-create')(null, {
      ...body, sourcePluginId: '', version: '1.0.1' }), /编辑改进权限/);
    await assert.rejects(f.handlers.get('personal-plugin-preflight')(null, {
      ...body, sourcePluginId: '', version: '1.0.1' }), /编辑改进权限/);
    await assert.rejects(f.handlers.get('personal-plugin-sign')(null, { pluginKey: body.key }), /编辑改进权限/);
    await assert.rejects(f.handlers.get('personal-plugin-export')(null, made.plugin.pluginId), /编辑改进权限/);
    await assert.rejects(f.handlers.get('personal-plugin-create')(null, {
      ...body, sourcePluginId: 'different-source', version: '1.0.1' }), /不能更换/);
    assert.equal(personal.get(f.app, made.plugin.pluginId).version, '1.0.0');
  } finally { f.close(); }
});

test('authorized saves inherit omitted source and version rollback cannot shed the source', async () => {
  const f = fixture(async () => response(true, true));
  try {
    const original = { ...body }; delete original.sourcePluginId;
    const first = personal.create(f.app, original);
    await f.handlers.get('personal-plugin-create')(null, { ...body, version: '1.0.1' });
    const next = await f.handlers.get('personal-plugin-create')(null, { ...original, version: '1.0.2' });
    assert.equal(next.plugin.localDraft.sourcePluginId, 'source-plugin');
    personal.setVersion(f.app, first.plugin.pluginId, '1.0.0');
    assert.equal(personal.get(f.app, first.plugin.pluginId).localDraft.sourcePluginId, 'source-plugin');
    assert.deepEqual(access.sourcesForIds(personal._read(f.app).plugins, [first.plugin.pluginId]), ['source-plugin']);
  } finally { f.close(); }
});

test('sourced plugin fails closed offline while inspection and cleanup stay available', async () => {
  const f = fixture(async () => { throw Error('offline'); }, async () => null);
  try {
    const made = personal.create(f.app, body);
    await assert.rejects(f.handlers.get('personal-plugin-resolve')(null, [made.plugin.pluginId]), /连接后台/);
    const detail = f.handlers.get('personal-plugin-get')(null, made.plugin.pluginId);
    assert.equal(detail.plugin.name, body.name);
    assert.equal((await f.handlers.get('personal-plugin-enable')(null, made.plugin.pluginId, false)).ok, true);
    assert.equal(f.handlers.get('personal-plugin-delete')(null, made.plugin.pluginId).ok, true);
  } finally { f.close(); }
});

test('permission checks are bounded even when transport ignores abort', async () => {
  await assert.rejects(access.check({ sourceIds: ['source-plugin'], action: 'use',
    identityOf: async () => identity, timeoutMs: 20, fetchImpl: () => new Promise(() => {}) }), /超时/);
});

test('account change during authorization prevents continuing with the previous grant', async () => {
  let reads = 0;
  await assert.rejects(access.check({ sourceIds: ['source-plugin'], action: 'edit',
    identityOf: async () => ++reads === 1 ? identity : { ...identity, session: 'next-account-session' },
    fetchImpl: async () => response(true, true) }), /账号已变化/);
});

test('source lineage survives archive export and reimport', async () => {
  const f = fixture(async () => response(true, true));
  try {
    const made = personal.create(f.app, body), filePath = path.join(f.root, 'fixture.soduwork-plugin');
    await personal.exportToFile(f.app, { showSaveDialog: async () => ({ filePath }) }, made.plugin.pluginId);
    const imported = personal.preflightArchive(fs.readFileSync(filePath).toString('base64'));
    assert.equal(imported.personalDraft.sourcePluginId, 'source-plugin');
  } finally { f.close(); }
});

test('a concurrent source attachment cannot turn an unchecked native save into a sourced write', async () => {
  let reads = 0;
  const auth = access.authorizer({ normalizeBody: raw => raw,
    read: () => ({ plugins: ++reads === 1 ? [] : [{ key: body.key, sourcePluginId: 'source-plugin' }] }),
    identityOf: () => { throw Error('native read must not request an identity'); } });
  const native = { ...body }; delete native.sourcePluginId;
  await assert.rejects(auth.body(native), /来源已变化/);
});
