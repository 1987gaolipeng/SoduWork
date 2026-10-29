'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const crypto = require('node:crypto'), { File } = require('node:buffer');
const personal = require('../main/personal-plugins');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/plugin-mcp-gate.js'), 'utf8');
const name = 'fixture-crm', resourcePath = 'references/connections/' + name + '.mcp.json';
const config = { type: 'http', url: 'https://fixture.invalid/mcp', headers: { Authorization: '' },
  enabled: false, enabledTools: ['read_status'], disabledTools: ['delete_item'], toolTimeoutSeconds: 30 };
const body = { template: 'connector', key: 'fixture-report', name: '报告助手', version: '1.0.0',
  description: '检查连接模板流程', instructions: '读取状态后生成报告。', mcpServers: [name] };
function fixture(t, override) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-template-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const draft = { ...body, resources: [{ path: resourcePath, kind: 'reference', encoding: 'utf8',
    content: JSON.stringify({ mcpServers: { [name]: { ...config, ...override } } }) }] };
  const item = personal.create(app, draft).plugin;
  const window = { crypto: crypto.webcrypto };
  vm.runInNewContext(source, { window, File, URL, TextEncoder, TextDecoder, Uint8Array, atob });
  let catalog = { personal: [], company: [], enabledCompany: [] }, imported;
  const calls = []; let viewRevision = 0;
  const options = { api: { myMcpServers: async () => catalog,
    personalPlugin: async id => { calls.push(['detail', id]); return { ok: true, plugin: personal.get(app, id) }; } },
    setCatalog: () => {}, say: value => calls.push(['say', value]), errorText: error => error.message,
    viewRevision: () => viewRevision, openPanel: async () => { viewRevision++; }, openEditor: (...args) => calls.push(['editor', ...args]),
    openImport: value => { imported = value; calls.push(['preview']); }, resume: () => calls.push(['resume']) };
  return { app, draft, item, calls, options, gate: window.SoduWorkPluginMcpGate,
    leaveView: () => { viewRevision++; }, setCatalog: value => { catalog = value; }, get imported() { return imported; } };
}
test('current installed resource uses existing detail contract and preserves disabled state', async t => {
  const f = fixture(t);
  assert.equal(await f.gate.ensure(f.item, f.options), false);
  assert.deepEqual(f.calls.filter(row => row[0] !== 'say'), [['detail', f.item.pluginId], ['preview']]);
  assert.deepEqual(JSON.parse(await f.imported.file.text()), { mcpServers: { [name]: config } });
  await f.imported.beforeImport();
  assert.equal(f.calls.filter(row => row[0] === 'detail').length, 2);
  f.imported.onSaved({ personal: [{ name, enabled: false }] });
  assert.equal(f.calls.some(row => row[0] === 'resume'), false);
  f.imported.onSaved({ personal: [{ name, enabled: true }] });
  assert.equal(f.calls.filter(row => row[0] === 'resume').length, 1);
});
test('template survives portable export/import without schema extension', async t => {
  const f = fixture(t), other = fixture(t);
  const imported = personal.create(other.app, personal.exportDraft(f.app, f.item.pluginId)).plugin;
  const file = await other.gate.templateFor(imported, name, other.options.api);
  assert.deepEqual(JSON.parse(await file.text()).mcpServers[name], config);
});
test('newer installed version cannot supply the old catalog item template', async t => {
  const f = fixture(t);
  personal.create(f.app, { ...f.draft, version: '1.0.1' });
  await f.gate.ensure(f.item, f.options);
  assert.equal(f.imported, undefined); assert.match(f.calls.at(-1)[1], /版本已变化/);
});
test('version changes after preview are rejected before import', async t => {
  const f = fixture(t); await f.gate.ensure(f.item, f.options);
  personal.create(f.app, { ...f.draft, version: '1.0.1' });
  await assert.rejects(f.imported.beforeImport(), /版本已变化/);
});
test('tampered bytes and mismatched checksums are rejected', async t => {
  const f = fixture(t), detail = personal.get(f.app, f.item.pluginId);
  f.options.api.personalPlugin = async () => ({ plugin: detail });
  detail.localDraft.resources[0].content = Buffer.from('X'.repeat(detail.localDraft.resources[0].size)).toString('base64');
  await assert.rejects(f.gate.templateFor(f.item, name, f.options.api), /校验未通过/);
  detail.checksum = '0'.repeat(64);
  await assert.rejects(f.gate.templateFor(f.item, name, f.options.api), /版本已变化/);
});
test('bundled credential values never reach preview or echo in errors', async t => {
  const f = fixture(t, { headers: { Authorization: 'fixture-sensitive-value' } });
  await f.gate.ensure(f.item, f.options);
  assert.equal(f.imported, undefined); assert.match(f.calls.at(-1)[1], /不能携带凭据/);
  assert.doesNotMatch(JSON.stringify(f.calls), /fixture-sensitive-value/);
});
test('foreign names, extra connections, OAuth and credential URLs are rejected', t => {
  const f = fixture(t);
  const candidates = [{ mcpServers: { wrong: config } }, { mcpServers: { [name]: config, extra: config } },
    ...[{ oauth: {} }, { headersHelper: 'run-me' }, { url: 'https://user:pass@fixture.invalid/mcp' },
      { url: 'https://fixture.invalid/mcp?key=private' }, { url: 'https://fixture.invalid/mcp?api_key=private' }, { env: { KEY: 'private' } }]
      .map(extra => ({ mcpServers: { [name]: { ...config, ...extra } } }))];
  for (const value of candidates) assert.throws(() => f.gate.cleanTemplate(JSON.stringify(value), name));
  assert.throws(() => f.gate.cleanTemplate('{ secret-is-never-echoed', name), e => !e.message.includes('secret-is-never-echoed'));
});
test('existing disabled personal connection opens its unchanged configuration', async t => {
  const f = fixture(t), existing = { id: 'owned', name, url: 'https://kept.invalid/mcp', enabled: false };
  f.setCatalog({ personal: [existing], company: [], enabledCompany: [] });
  await f.gate.ensure(f.item, f.options);
  assert.equal(f.calls.find(row => row[0] === 'editor')[1], existing);
  assert.equal(f.imported, undefined); assert.equal(f.calls.some(row => row[0] === 'detail'), false);
  assert.equal(existing.url, 'https://kept.invalid/mcp'); assert.equal(existing.enabled, false);
});
test('company case-insensitive collisions do not create or enable a connection', async t => {
  const f = fixture(t);
  f.setCatalog({ personal: [], company: [{ name: name.toUpperCase() }], enabledCompany: [] });
  await f.gate.ensure(f.item, f.options);
  assert.equal(f.imported, undefined); assert.equal(f.calls.some(row => row[0] === 'editor'), false);
  assert.match(f.calls.at(-1)[1], /手动启用/);
});
test('connection created after preview is caught before import', async t => {
  const f = fixture(t); await f.gate.ensure(f.item, f.options);
  f.setCatalog({ personal: [{ name, enabled: true }], company: [], enabledCompany: [] });
  await assert.rejects(f.imported.beforeImport(), /同名连接已存在/);
});
test('legacy and enterprise plugins keep fallback without private resource access', async t => {
  const f = fixture(t);
  for (const item of [{ ...f.item, capabilities: { mcpServers: [name] } }, { ...f.item, personal: false }]) {
    await f.gate.ensure(item, f.options);
    assert.equal(f.calls.at(-1)[0], 'editor'); assert.equal(f.calls.at(-1)[3].name, name);
  }
  assert.equal(f.calls.some(row => row[0] === 'detail'), false);
});
test('enabled dependencies bypass templates and superseded previews cannot import', async t => {
  const f = fixture(t); await f.gate.ensure(f.item, f.options); const old = f.imported;
  f.setCatalog({ personal: [{ name, enabled: true }], company: [], enabledCompany: [] });
  assert.equal(await f.gate.ensure(f.item, f.options), true);
  await assert.rejects(old.beforeImport(), /配置入口已变化/);
});
test('creator prompts preserve resource and authorization boundaries', t => {
  const f = fixture(t), builder = personal.get(f.app, personal.BUILDER_ID);
  assert.equal(builder.version, '1.4.3');
  assert.match(builder.localDraft.instructions, /source\.type=package.*entry=ui\/index\.html/);
  assert.equal(require('../main/mcp-studio-plugin').body(f.app).version, '1.3.0');
  assert.match(builder.localDraft.instructions, /references\/connections\//);
  assert.match(builder.localDraft.instructions, /所有 headers\/env 值必须为空/);
  assert.match(builder.localDraft.instructions, /静态预检通过不等于真实连接/);
});

test('leaving during template loading cancels stale UI and an explicit new trial works', async t => {
  const f = fixture(t); let release;
  const get = f.options.api.personalPlugin;
  f.options.api.personalPlugin = async id => { await new Promise(resolve => { release = resolve; }); return get(id); };
  const pending = f.gate.ensure(f.item, f.options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  f.leaveView(); // Close the capability panel or select another tab while detail IPC is pending.
  release(); await pending;
  assert.equal(f.imported, undefined); assert.equal(f.calls.some(row => row[0] === 'editor'), false);
  f.options.api.personalPlugin = get;
  await f.gate.ensure(f.item, f.options);
  assert.ok(f.imported); await f.imported.beforeImport();
});
test('leaving during panel loading does not open the old plugin template', async t => {
  const f = fixture(t); let release;
  f.options.openPanel = () => new Promise(resolve => { release = resolve; });
  const pending = f.gate.ensure(f.item, f.options);
  await new Promise(resolve => setImmediate(resolve)); f.leaveView(); release(); await pending;
  assert.equal(f.imported, undefined); assert.equal(f.calls.some(row => row[0] === 'detail'), false);
});

test('saving an existing disabled dependency does not reopen the same setup dialog', async t => {
  const f = fixture(t); f.setCatalog({ personal: [{ name, enabled: false }], company: [], enabledCompany: [] });
  await f.gate.ensure(f.item, f.options);
  const saved = f.calls.find(row => row[0] === 'editor')[3].onSaved;
  saved({ personal: [{ name, enabled: false }] });
  assert.equal(f.calls.some(row => row[0] === 'resume'), false);
  saved({ personal: [{ name, enabled: true }] });
  assert.equal(f.calls.filter(row => row[0] === 'resume').length, 1);
});


test('API connector plugin template retains document and policies without trusting compiled fields', async t => {
  const { compile } = require('../../skills/mcp-tools/connectors/api-definition.cjs');
  const apiDefinition = compile({name:'Projects',baseUrl:'https://api.example.com',
    securitySchemes:{account:{type:'oauth2',flows:{authorizationCode:{
      authorizationUrl:'https://login.example.com/authorize',tokenUrl:'https://login.example.com/token',scopes:{read:''}}}}},
    security:[{account:['read']}],endpoints:[{method:'GET',path:'/projects',name:'list_projects'}]});
  const f = fixture(t, {type:'stdio',url:undefined,headers:undefined,command:'soduwork-api',args:[],
    apiDefinition:{...apiDefinition,tools:[{name:'untrusted'}]},env:{AUTH_ACCOUNT_CLIENT_ID:'',AUTH_ACCOUNT_CLIENT_SECRET:''},
    enabledTools:['list_projects'],disabledTools:[]});
  await f.gate.ensure(f.item,f.options);
  assert.ok(f.imported);
  const spec = JSON.parse(await f.imported.file.text()).mcpServers[name];
  assert.equal(spec.enabled,false);
  assert.deepEqual(spec.enabledTools,['list_projects']);
  assert.equal(spec.apiDefinition.tools,undefined);
  assert.deepEqual(compile(spec.apiDefinition).tools.map(t=>t.name),['list_projects']);
  assert.equal(spec.oauth,undefined);
  for(const extra of [{command:'node'},{url:'https://other.example/mcp'},{args:['script.js']},
    {oauth:{connectionId:'borrowed'}},{env:{AUTH_ACCOUNT_CLIENT_SECRET:'private'}}]) {
    assert.throws(()=>f.gate.cleanTemplate(JSON.stringify({mcpServers:{[name]:{...spec,...extra}}}),name));
  }
});
