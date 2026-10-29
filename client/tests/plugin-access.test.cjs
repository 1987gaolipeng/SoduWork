const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/plugin-access.js'), 'utf8');
function setup(options = {}) {
  const events = {}, buttons = {};
  for (const name of ['capPluginTry', 'capEnterpriseInstall', 'capPluginOpenUI', 'capEnterpriseEdit', 'capEnterpriseImprove']) {
    buttons[name] = { disabled: false, hidden: false, dataset: {}, addEventListener(type, fn) { this[type] = fn; } };
  }
  const layer = { isConnected: true, querySelector: name => buttons[name.slice(1)],
    querySelectorAll: names => names.split(', ').map(name => buttons[name.slice(1)]) };
  const calls = [], listeners = new Map();
  const window = { addEventListener(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    events[name] = event => Promise.all([...listeners.get(name)].map(listener => listener(event)));
  } };
  const api = { enterprisePluginDraft: async id => { calls.push(['fetch', id]); return { draft: { key: 'fixture', sourcePluginId: id } }; },
    enterprisePluginPermissions: async () => ({ canUse: false, canEdit: false }) };
  const ctx = { closeModal: () => calls.push(['close']), createWithAgent: draft => calls.push(['improve', draft]),
    errorText: error => error.message, say: message => calls.push(['error', message]) };
  vm.runInNewContext(source, { window, SoduWorkAPI: api });
  const access = window.SoduWorkPluginAccess;
  const item = { pluginId: 'enterprise', permissions: options.permissions || { canUse: true, canEdit: true } };
  access.bind(layer, item, ctx, (_, draft) => calls.push(['edit', draft]), options.refreshDetail);
  return { events, buttons, layer, calls, api, access, item, window };
}
test('enterprise edit and improve each fetch a freshly authorized draft', async () => {
  const s = setup();
  await s.buttons.capEnterpriseEdit.click();
  await s.buttons.capEnterpriseImprove.click();
  assert.deepEqual(s.calls.map(row => row[0]), ['fetch', 'close', 'edit', 'fetch', 'improve']);
  assert.equal(s.calls[2][1].sourcePluginId, 'enterprise');
  assert.equal(s.calls[4][1].sourcePluginId, 'enterprise');
});

test('granting use to an open edit-only detail requests fresh authoritative actions', async () => {
  const refreshed = [];
  const s = setup({ permissions: { canUse: false, canEdit: true },
    refreshDetail: async (permissions, isCurrent) => refreshed.push([permissions.canUse, isCurrent()]) });
  s.api.enterprisePluginPermissions = async () => ({ canUse: true, canEdit: true });
  await s.events['soduwork-plugin-policy']({ detail: { pluginId: 'enterprise' } });
  assert.deepEqual(refreshed, [[true, true]]);
});

test('detail refresh cannot reopen a replaced modal after awaiting the catalog', async () => {
  let valid, release;
  const s = setup({ refreshDetail: async (_, isCurrent) => {
    await new Promise(resolve => { release = resolve; }); valid = isCurrent();
  } });
  const pending = s.events['soduwork-plugin-policy']({ detail: { pluginId: 'enterprise' } });
  await new Promise(resolve => setImmediate(resolve));
  s.layer.hidden = true;
  release?.(); await pending;
  assert.equal(valid, false);
});

test('a policy round trip refreshes even when the latest grant matches the original detail', async () => {
  const refreshes = [];
  const s = setup({ refreshDetail: async permissions => refreshes.push(permissions.canUse) });
  await s.events['soduwork-plugin-policy']({ detail: {} });
  s.api.enterprisePluginPermissions = async () => ({ canUse: true, canEdit: true });
  await s.events['soduwork-plugin-policy']({ detail: {} });
  assert.deepEqual(refreshes, [false, true]);
});

test('grant-deny-grant with a delayed denial cannot poison the real catalog cache', async () => {
  let catalog;
  const s = setup({ refreshDetail: async () => { await catalog.load(); } });
  s.window.SoduWorkPluginCatalogFormat = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-capability-plugins.js'), 'utf8'), {window:s.window,SoduWorkAPI:s.api});
  catalog = s.window.SoduWorkCapabilityPlugins;
  const pending = [];
  s.api.pluginCatalog = () => new Promise(resolve => pending.push(resolve));
  const denied = s.events['soduwork-plugin-policy']({detail:{}});
  await new Promise(resolve => setImmediate(resolve));
  s.api.enterprisePluginPermissions = async () => ({canUse:true,canEdit:true});
  const granted = s.events['soduwork-plugin-policy']({detail:{}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length,2);
  pending[1]({items:[{pluginId:'enterprise',permissions:{canUse:true,canEdit:true}}]}); await granted;
  pending[0]({items:[{pluginId:'enterprise',permissions:{canUse:false,canEdit:false}}]}); await denied;
  assert.equal(catalog.snapshot().items[0].permissions.canUse,true);
});
test('revoked server access cannot open a stale editor or improvement chat', async () => {
  const s = setup();
  s.api.enterprisePluginDraft = async () => { throw Error('permission revoked'); };
  await s.buttons.capEnterpriseEdit.click();
  await s.buttons.capEnterpriseImprove.click();
  assert.deepEqual(s.calls.map(row => row[0]), ['error', 'error']);
});
test('derived personal drafts recheck edit access every time, native personal drafts stay offline', async () => {
  const s = setup(); let calls = 0, allowed = true;
  s.api.enterprisePluginPermissions = async id => { calls++; assert.equal(id, 'source'); return { canEdit: allowed }; };
  await s.access.assertEditable({ key: 'personal' });
  assert.equal(calls, 0);
  await s.access.assertEditable({ sourcePluginId: 'source' });
  allowed = false;
  await assert.rejects(s.access.assertEditable({ sourcePluginId: 'source' }));
  assert.equal(calls, 2);
  s.api.enterprisePluginPermissions = async () => { throw Error('offline'); };
  await assert.rejects(s.access.assertEditable({ sourcePluginId: 'source' }), /offline/);
});
test('live permissions immediately disable an open detail without overriding other blockers', async () => {
  const s = setup();
  s.buttons.capEnterpriseInstall.disabled = true;
  await s.events['soduwork-plugin-policy']({ detail: { pluginId: 'enterprise' } });
  assert.equal(s.buttons.capPluginTry.disabled, true);
  assert.equal(s.buttons.capEnterpriseImprove.hidden, true);
  s.api.enterprisePluginPermissions = async () => ({ canUse: true, canEdit: true });
  await s.events['soduwork-plugin-policy']({ detail: { pluginId: 'enterprise' } });
  assert.equal(s.buttons.capPluginTry.disabled, false);
  assert.equal(s.buttons.capEnterpriseInstall.disabled, true);
  assert.equal(s.buttons.capEnterpriseImprove.hidden, false);
});
test('a delayed earlier permission response cannot undo a later revocation', async () => {
  const s = setup(), pending = [];
  s.api.enterprisePluginPermissions = () => new Promise(resolve => pending.push(resolve));
  const first = s.events['soduwork-plugin-policy']({ detail: {} });
  const second = s.events['soduwork-plugin-policy']({ detail: {} });
  pending[1]({ canUse: false, canEdit: false }); await second;
  pending[0]({ canUse: true, canEdit: true }); await first;
  assert.equal(s.buttons.capPluginTry.disabled, true);
  assert.equal(s.buttons.capEnterpriseEdit.hidden, true);
});
test('closed detail ignores draft completion; enterprise permissions do not apply to personal plugins', async () => {
  const s = setup();
  s.layer.isConnected = false;
  await s.buttons.capEnterpriseEdit.click();
  assert.deepEqual(s.calls.map(row => row[0]), ['fetch']);
  assert.equal(s.access.actions({ personal: true }, false), '');
  assert.match(s.access.actions({ permissions: { canEdit: false } }, false), /hidden/);
  assert.doesNotMatch(s.access.actions({ permissions: { canEdit: true } }, false), /hidden/);
});
test('a hidden reusable modal ignores a pending draft and policy events', async () => {
  const s = setup(); let finish;
  s.api.enterprisePluginDraft = () => new Promise(resolve => { finish = resolve; });
  const pending = s.buttons.capEnterpriseEdit.click();
  s.layer.hidden = true;
  finish({ draft: { key: 'fixture', sourcePluginId: 'enterprise' } }); await pending;
  await s.events['soduwork-plugin-policy']({ detail: {} });
  assert.equal(s.calls.length, 0);
  assert.equal(s.buttons.capPluginTry.disabled, false);
});
test('an uninstalled edit-only plugin is discoverable without offering use', () => {
  const window = {}, context = { window };
  for (const file of ['plugin-presentation.js', 'plugin-lifecycle.js']) vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), context);
  const item = { pluginId: 'editable', installed: false, listed: false, permissions: { canUse: false, canEdit: true } };
  const model = window.SoduWorkPluginPresentation.libraryModel({ items: [item] }, {}, () => true, () => 'attention');
  assert.equal(model.items.length, 1);
  const state = window.SoduWorkPluginLifecycle.resolve(item);
  assert.equal(state.code, 'editOnly');
  assert.equal(state.blocking, true);
  assert.notEqual(state.nextAction, 'use');
});
