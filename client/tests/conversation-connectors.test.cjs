'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const connectors = require('../main/conversation-connectors.cjs');
const grants = require('../main/pi-session/plugin-grant');
const context = require('../main/pi-session/plugin-context');
const hidden = require('../main/pi-session/connector-context.cjs');
const pluginTurn = require('../main/pi-session/plugin-turn');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const policy = () => ({ ok: true, skills: [{ name: 'mcp-tools' }], enabled: ['mcp-tools'], revoked: [] });
const catalog = () => ({ company: [{ name: 'company', enabled: true }], enabledCompany: ['company'],
  personal: [{ name: 'personal', enabled: true, approved: true }] });
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-connectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let current = identity(), requests = [], policies = 0;
  const app = { getPath: () => root };
  const resolve = connectors.resolver({ app, identity: current, identityOf: async () => current,
    allowed: true, ref: 'ordinary-conversation', bridgePath: () => '/fixture/mcp.mjs',
    fetchPolicy: async (...args) => { policies++; assert.equal(args[3], true); return policy(); },
    catalog: async () => catalog(), platformGuidance: async () => '',
    request: async (_identity, body) => { requests.push(body); return {
      mcpGrant: { ticket: 'fixture-private-ticket-' + requests.length, servers: body.personalMcpServers } }; },
    ...extra });
  return { resolve, root, app, requests, changeIdentity: value => { current = value; },
    files: () => fs.existsSync(grants._grantRoot(app)) ? fs.readdirSync(grants._grantRoot(app)) : [],
    get policies() { return policies; } };
}
test('ordinary turns grant only enabled approved names and never expose secrets or full tool schemas', async t => {
  const f = fixture(t);
  const a = await f.resolve();
  assert.deepEqual(a.servers, ['company', 'personal']);
  assert.deepEqual(f.requests[0].pluginIds, []);
  assert.equal(f.requests[0].conversationId, 'ordinary-conversation');
  assert.equal(f.files().length, 1);
  assert.match(fs.readFileSync(path.join(grants._grantRoot(f.app), f.files()[0]), 'utf8'), /fixture-private-ticket-1/);
  assert.doesNotMatch(a.guide, /fixture-private|headers|inputSchema/);
  assert.match(a.guide, /plugin_mcp_list/);
  assert.equal(a.redact('fixture-private-ticket-1'), '[hidden]');
  a.cleanup(); a.cleanup(); assert.deepEqual(f.files(), []);
  const b = await f.resolve(); assert.equal(f.policies, 2); assert.equal(f.requests.length, 2);
  b.cleanup();
});
test('selection respects company precedence, explicit plugin grants and disabled/unapproved personal connections', () => {
  const value = { company: [{ name: 'Office', enabled: true }, { name: 'unchecked', enabled: true }],
    enabledCompany: ['Office'], personal: [
      { name: 'office', enabled: true, approved: true }, { name: 'off', enabled: false, approved: true },
      { name: 'pending', enabled: true, approved: false }, { name: 'incomplete', approved: true },
      { name: 'extra', enabled: true, approved: true }, { name: 'soduwork-media', enabled: true, approved: true }] };
  assert.deepEqual(connectors.names(value), ['Office', 'extra']);
  assert.deepEqual(connectors.names(value, ['OFFICE']), ['extra']);
});
test('session selection, readonly and current policy revoke optional access without blocking a chat', async t => {
  for (const extra of [{ allowed: false }, { fetchPolicy: async () => ({ ...policy(), revoked: ['mcp-tools'] }) },
    { fetchPolicy: async () => ({ ...policy(), enabled: [] }) },
    { fetchPolicy: async () => ({ ok: false }) }]) {
    const f = fixture(t, extra), prepared = await f.resolve();
    assert.deepEqual(prepared.servers, []); assert.equal(f.requests.length, 0); assert.deepEqual(f.files(), []);
    assert.match(prepared.guide, /本轮/);
  }
  const f = fixture(t);
  assert.deepEqual((await f.resolve({ readOnly: true })).servers, []);
  assert.equal(f.policies, 0);
  const explicit = fixture(t, { explicitlySelected: true, fetchPolicy: async () => ({ ...policy(), enabled: [] }) });
  const prepared = await explicit.resolve(); assert.equal(prepared.servers.length, 2); prepared.cleanup();
});
test('scope change during grant preparation cannot write a ticket for another account', async t => {
  let release;
  const f = fixture(t, { request: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.resolve();
  while (!release) await pause(1);
  f.changeIdentity(identity('two'));
  release({ mcpGrant: { ticket: 'must-not-write', servers: ['company', 'personal'] } });
  const prepared = await pending;
  assert.deepEqual(prepared.servers, []); assert.deepEqual(f.files(), []);
});
test('directory/policy requests run concurrently under one timeout and cancellation stops pending preparation', async t => {
  let catalogStarted = false, policyStarted = false;
  const f = fixture(t, { timeoutMs: 80,
    catalog: async () => { catalogStarted = true; return new Promise(() => {}); },
    fetchPolicy: async () => { policyStarted = true; return new Promise(() => {}); } });
  const start = Date.now(), prepared = await f.resolve();
  assert.equal(catalogStarted && policyStarted, true); assert.ok(Date.now() - start < 600);
  assert.deepEqual(prepared.servers, []); assert.equal(f.requests.length, 0);
  let cancelled = false;
  const g = fixture(t, { timeoutMs: 3000, catalog: () => new Promise(() => {}) });
  const pending = g.resolve({ cancelled: () => cancelled }); await pause(10);
  cancelled = true; const stoppedAt = Date.now(); await pending;
  assert.ok(Date.now() - stoppedAt < 300); assert.deepEqual(g.files(), []);
});
test('cancelled or late grant response never writes a temporary file', async t => {
  let release, cancelled = false;
  const f = fixture(t, { request: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.resolve({ cancelled: () => cancelled });
  while (!release) await pause(1);
  cancelled = true; await pending;
  release({ mcpGrant: { ticket: 'late-private-ticket', servers: ['company', 'personal'] } });
  await pause(20); assert.deepEqual(f.files(), []);
});
test('failing optional MCP does not hide independently connected native platform guidance', async t => {
  const f = fixture(t, { request: async () => { throw Error('private diagnostic'); },
    platformGuidance: async () => 'TRUSTED-NATIVE-GUIDANCE' });
  const value = await f.resolve();
  assert.match(value.guide, /TRUSTED-NATIVE-GUIDANCE/); assert.doesNotMatch(value.guide, /private diagnostic/);
  assert.deepEqual(f.files(), []);
});
test('native platform guidance errors do not disable ordinary MCPs', async t => {
  const f = fixture(t, { platformGuidance: async () => { throw Error('broken native installation'); } });
  const value = await f.resolve(); assert.equal(value.servers.length, 2); value.cleanup();
});
test('more than twenty enabled names bounds the grant and explains the actual scope', async t => {
  const f = fixture(t, { catalog: async () => ({ company: [], enabledCompany: [],
    personal: Array.from({ length: 50 }, (_, i) => ({ name: 'connector-' + i, enabled: true, approved: true })) }) });
  const value = await f.resolve(); assert.equal(value.servers.length, 20);
  assert.equal(f.requests[0].personalMcpServers.length, 20); assert.match(value.guide, /20/); value.cleanup();
});
test('connector context is invisible in history and works without inventing a plugin badge', async () => {
  const options = { resolveConnectors: async () => ({ guide: 'INTERNAL-CONNECTOR-GUIDE', cleanup() {} }) };
  const prepared = await pluginTurn.prepare(options, {});
  assert.deepEqual(prepared.plugins, []); assert.deepEqual(prepared.badges, []);
  const prompt = prepared.augment('ordinary visible text');
  assert.match(prompt, /INTERNAL-CONNECTOR-GUIDE/);
  assert.deepEqual(context.parse(prompt), { text: 'ordinary visible text', plugins: [] });
  assert.equal(hidden.strip(hidden.augment('literal ' + hidden.START, 'guide')), 'literal [conversation-connectors]');
  prepared.cleanup();
});
test('explicit plugin failure stays fail-closed; optional failure cannot reject a valid plugin', async () => {
  let called = 0, cleaned = 0;
  const resolveConnectors = async () => { called++; throw Error('secret directory diagnostics'); };
  const invalid = await pluginTurn.prepare({ resolveConnectors, resolvePlugins: async () => { throw Error('revoked'); } }, { pluginIds: ['plugin'] });
  assert.equal(invalid.ok, false); assert.equal(invalid.failureKind, 'plugin-grant'); assert.equal(called, 0);
  const valid = await pluginTurn.prepare({ resolveConnectors, resolvePlugins: async () => ({
    items: [{ pluginId: 'plugin', name: 'fixture', context: 'DECLARED-PLUGIN' }],
    grant: { cleanup() { cleaned++; } } }) }, { pluginIds: ['plugin'] });
  assert.equal(valid.ok, true); assert.match(valid.augment('hello'), /DECLARED-PLUGIN/);
  assert.doesNotMatch(valid.augment('hello'), /secret directory/);
  valid.cleanup(); assert.equal(cleaned, 1);
});

test('an app conversation-only projection never looks for replacement connectors in shared runtime preparation', async () => {
  let optional=0,received;
  const prepared=await pluginTurn.prepare({
    resolvePlugins:async(_ids,_project,turnContext)=>{
      received=turnContext;
      return {items:[{pluginId:'owned-app',name:'App',context:'APP-CONTEXT',capabilities:{mcpServers:[]}}],
        applicationUnavailable:true,applicationGuide:'本轮仅作文字沟通',grant:null};
    },
    resolveConnectors:async()=>{optional++;throw Error('must not seek another connection');},
  }, {pluginIds:['owned-app']}, ()=>false, {allowUnavailableApp:true});
  assert.equal(received.allowUnavailableApp,true);
  assert.equal(prepared.ok,true);
  assert.match(prepared.augment('不看截图'),/本轮仅作文字沟通/);
  assert.equal(optional,0);
  prepared.cleanup();
});

test('turn limitations share hidden connector context without losing the existing grant guide or leaking into message text', async () => {
  for(const options of [{},{resolveConnectors:async()=>({guide:'EXISTING-GUIDE'})},
    {resolveConnectors:async()=>{throw Error('offline');}}]) {
    const prepared=await require('../main/pi-session/connector-turn.cjs').prepare(options);
    const prompt=prepared.augment('用户原文','历史图片不可见');
    assert.match(prompt,/历史图片不可见/);
    if(options.resolveConnectors) assert.match(prompt,/EXISTING-GUIDE|暂时无法确认/);
    assert.equal(context.parse(prompt).text,'用户原文');
    prepared.cleanup();
  }
});
test('production request path reads only metadata and obtains one device-scoped short-lived grant', async t => {
  const calls = [];
  const f = fixture(t, { fetchPolicy: undefined, catalog: undefined, request: undefined,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      const body = url.endsWith('/skills') ? policy() : url.endsWith('/mcp-servers') ? catalog()
        : { ok: true, mcpGrant: { ticket: 'http-fixture-ticket', servers: ['company', 'personal'] } };
      return { ok: true, status: 200, json: async () => body };
    } });
  const result = await f.resolve();
  assert.equal(result.servers.length, 2); assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.url.endsWith('/mcp')));
  assert.ok(calls.every(call => call.init.headers.Authorization.startsWith('Device ')));
  result.cleanup();
});

test('guidance examples roundtrip JSON through the actual guarded Bash without interpolating registry names', async t => {
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork connector quoting '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(root, 'mcp.mjs'), config = path.join(root, 'fixture config.json');
  fs.writeFileSync(bridge, 'const args=process.argv.slice(2);console.log(JSON.stringify({tool:args[4],params:JSON.parse(args[5])}));');
  const maliciousName = 'registry-%PATH%-&-quote"-$(' + 'touch unexpected)';
  const guard = require('../main/pi-session/tool-guard').createGuardedBash(sdk, root, {});
  // Use the same fixed safe example for POSIX and Windows Git Bash without reading credential files.
  for (const platform of ['win32', 'linux']) {
    const guide = connectors.guidance(config, bridge, [maliciousName], false, platform);
    assert.match(guide, /JSON 是工具名后面的最后一个位置参数/);
    assert.match(guide, /不支持 --json 或 --args/);
    const commands = guide.split('\n').filter(line => line.startsWith('node ') && line.includes(' call '));
    assert.equal(commands.length, 2);
    for (let index = 0; index < commands.length; index++) {
      assert.ok(!commands[index].includes(maliciousName));
      assert.ok(!commands[index].includes('%PATH%'));
      assert.doesNotMatch(commands[index], /--json|--args/);
      const result = await guard.execute('quote-fixture', { command: commands[index], timeout: 10 });
      const value = JSON.parse(result.content.find(item => item.type === 'text').text.trim());
      assert.equal(value.tool, index ? 'plugin_mcp_call' : 'plugin_mcp_list');
      assert.equal(value.params.server, 'CONNECTOR_NAME');
      if (index) assert.deepEqual(value.params, { server: 'CONNECTOR_NAME', tool: 'TOOL_FROM_LIST', arguments: {} });
    }
  }
  assert.equal(fs.existsSync(path.join(root, 'unexpected')), false);
});
