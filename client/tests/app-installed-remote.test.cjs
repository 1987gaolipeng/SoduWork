'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const remote = require('../main/app-installed-remote.cjs');

test('market bridges use installed capabilities and UI while a newer release is available', async () => {
  const plugin = { pluginId: 'market-app', installed: true, permissions: { canUse: true },
    versionId: 'new-version', capabilities: { mcpServers: ['new-server'] },
    ui: { contributions: [] }, conversationVersionId: 'installed-version', conversationVersion: '1.0.0',
    conversationCapabilities: { mcpServers: ['installed-server'] },
    conversationUi: { contributions: [{ id: 'installed-main' }] } };
  const item = await remote.get({ app: {}, identityOf: () => ({ hub: 'https://hub.example' }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ items: [plugin] }) }) }, plugin.pluginId);
  assert.equal(item.versionId, 'installed-version');
  assert.deepEqual(item.capabilities.mcpServers, ['installed-server']);
  assert.equal(item.ui.contributions[0].id, 'installed-main');
  assert.equal(plugin.versionId, 'new-version');
});

test('market application authorization uses the current device session when legacy secret authentication is disabled', async () => {
  let authenticated = 0, raw = 0;
  const plugin = { pluginId:'market-app', installed:true, permissions:{canUse:true} };
  const deps = {
    app: {},
    identityOf: () => { raw++; return {hub:'https://hub.example',clientId:'device',secret:'fixture-secret'}; },
    authenticatedIdentityOf: async () => { authenticated++; return {hub:'https://hub.example',clientId:'device',secret:'fixture-secret',session:'fixture-session'}; },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://hub.example/api/v1/plugins/catalog');
      const ok = options.headers.Authorization === 'Device fixture-session';
      return {ok,status:ok?200:401,json:async()=>({items:[plugin]})};
    },
  };
  assert.equal(await remote.get(deps,plugin.pluginId), plugin);
  assert.equal(authenticated,1);
  assert.equal(raw,0);
});

test('session renewal failure cannot fall back to a different identity or fetch an unauthorized catalog', async () => {
  let fetched = false, raw = false;
  await assert.rejects(remote.get({app:{},
    authenticatedIdentityOf:async()=>{throw Error('账号或服务已变化');},
    identityOf:()=>{raw=true;return {hub:'https://other.example'};},
    fetchImpl:async()=>{fetched=true;return {ok:true,json:async()=>({items:[]})};},
  },'market-app'),/账号或服务已变化/);
  assert.equal(fetched,false); assert.equal(raw,false);
});

test('catalog rejection keeps the HTTP status without exposing response contents or device credentials', async () => {
  await assert.rejects(remote.get({app:{},identityOf:()=>({hub:'https://hub.example',secret:'private-fixture'}),
    fetchImpl:async()=>({ok:false,status:403,text:async()=>{throw Error('must not expose remote body');}}),
  },'market-app'), error=>error.message.includes('HTTP 403')&&!error.message.includes('private-fixture'));
});

test('production app bridges and settings management wire authenticated device identities', () => {
  const main = fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  assert.match(main, /_workPreview\.install\(\{[^;]*authenticatedIdentityOf:\s*_deviceAuth\.authenticatedIdentity/);
  assert.match(main, /require\('\.\/main\/app-settings-ipc\.cjs'\)\.install\(\{[^;]*identityOf:\s*_deviceAuth\.authenticatedIdentity/);
});
