'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const maker = require('../../skills/mcp-studio/scripts/mcp-config.cjs');
const personal = require('../main/personal-plugins');
const resources = require('../main/plugin-resources');
const { readPersonalArchive } = require('../main/plugin-package-reader.cjs');
const metadata = { key: 'fixture-connector', name: 'Fixture connector', version: '1.0.0',
  description: 'Use the declared connector', instructions: 'Read the authorized source and return a factual answer.' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-connector-authoring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, app: { getPath: () => root }, input: path.join(root, 'input.json'), metadata: path.join(root, 'metadata.json') };
}
function input(f, row, name = 'fixture') { fs.writeFileSync(f.input, JSON.stringify({ mcpServers: { [name]: row } })); }
const http = () => ({ type: 'http', url: 'https://fixture.invalid/mcp', headers: { Authorization: 'never-export-sensitive-value' } });

test('maker rejects invalid transports, mixed settings, aliases and unsafe portable names before writing', t => {
  const f = fixture(t), out = path.join(f.root, 'out');
  for (const row of [
    { ...http(), type: 'sse' }, { ...http(), type: 'stdio' }, { ...http(), env: {} },
    { ...http(), command: 'node' }, { ...http(), extraAuth: {} }, { ...http(), headers: { Host: 'private' } },
    { ...http(), headers: { Authorization: '', authorization: '' } },
    { ...http(), enabledTools: [], enabled_tools: ['read'] },
    { ...http(), toolTimeoutSeconds: 10, tool_timeout_sec: 20 },
    { ...http(), url: 'https://fixture.invalid/mcp?authorization=never-export-sensitive-value' },
    { command: 'soduwork-connector', args: ['missing'] },
    { command: 'soduwork-connector', args: ['postgres'], env: { NODE_OPTIONS: 'private' } },
    { command: 'soduwork-connector', args: ['postgres'], enabledTools: ['invented_tool'] },
    { command: 'node', args: null }, { command: 'node', env: null },
  ]) {
    input(f, row);
    assert.throws(() => maker.prepare(f.input, out), error => !error.message.includes('never-export-sensitive-value'));
    assert.equal(fs.existsSync(out), false);
  }
  for (const name of ['__proto__', 'constructor', '../outside', 'a/b', 'a\\b', 'CON', 'name.', ' fixture', 'e\u0301']) {
    input(f, http(), name); assert.throws(() => maker.prepare(f.input, out)); assert.equal(fs.existsSync(out), false);
  }
});

test('all reviewed templates survive the packaged maker, actual Hub personal importer and portable plugin preflight', t => {
  const f = fixture(t), plugin = personal.get(f.app, personal.MCP_STUDIO_ID);
  const materialized = resources.materialize(plugin.localDraft.resources, f.root, 'maker');
  const tool = require(path.join(materialized.directory, 'references/mcp-studio/scripts/mcp-config.cjs'));
  const documents = [];
  for (const entry of tool.catalog()) {
    const output = path.join(f.root, entry.id);
    const templateReport = tool.fromTemplate(entry.id, output);
    const connectionName = entry.id === 's3' ? entry.id : entry.name;
    assert.deepEqual(templateReport.connections, [connectionName]);
    const config = fs.readFileSync(path.join(output, 'mcp-config.json'), 'utf8');
    const row = JSON.parse(config).mcpServers[connectionName];
    assert.equal(row.enabled, false);
    assert.ok(Object.values(row.env).every(v => v === ''));
    assert.deepEqual(Object.keys(row.env).sort(), entry.fields.map(f => f.key).sort());
    documents.push(JSON.parse(config));
    fs.writeFileSync(f.metadata, JSON.stringify({ ...metadata, key: 'fixture-' + entry.id }));
    const bundle = path.join(f.root, 'plugin-' + entry.id);
    const report = tool.bundle(path.join(output, 'mcp-config.json'), f.metadata, bundle);
    const draft = JSON.parse(fs.readFileSync(path.join(bundle, report.pluginDraft), 'utf8'));
    assert.equal(personal.preflight(draft).ok, true);
    assert.deepEqual(draft.mcpServers, [connectionName]);
    assert.equal(report.resources[0].sha256, crypto.createHash('sha256').update(draft.resources[0].content).digest('hex'));
  }
  assert.equal(documents.length, 59);
  const backend = path.resolve(__dirname, '../../hub-backend');
  const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const script = [
    'import json,sys',
    'from app.services import mcp_import',
    'from app.api.mcp_management import personal_candidates',
    'results=[]',
    'for document in json.load(sys.stdin):',
    ' result=personal_candidates(mcp_import.parse(json.dumps(document).encode(),"fixture.json"))',
    ' results.extend({"valid":r["valid"],"errors":r.get("errors",[]),"enabled":r["row"].get("enabled")} for r in result["items"])',
    'print(json.dumps(results))',
  ].join('\n');
  const result = spawnSync(python, ['-c', script], { cwd: backend, encoding: 'utf8', input: JSON.stringify(documents),
    windowsHide: true, timeout: 30000, env: { ...process.env, DATABASE_URL: 'sqlite+aiosqlite:///:memory:',
      AUTH_SECRET: 'connector-authoring-isolated-fixture-key', ADMIN_PASS: 'connector-authoring-isolated-fixture-password' } });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const imported = JSON.parse(result.stdout);
  assert.equal(imported.length, 59);
  assert.ok(imported.every(r => r.valid && r.enabled === false), JSON.stringify(imported.filter(r => !r.valid)));
});

test('one command produces an installable connector draft whose templates survive real archive export and reinstall', async t => {
  const f = fixture(t);
  input(f, { ...http(), enabledTools: ['read_status'], disabledTools: ['delete_item'], toolTimeoutSeconds: 25 });
  fs.writeFileSync(f.metadata, JSON.stringify(metadata));
  const out = path.join(f.root, 'delivery'), report = maker.bundle(f.input, f.metadata, out);
  assert.equal(report.connectionTested, false); assert.equal(report.pluginInstalled, false);
  const raw = fs.readFileSync(path.join(out, report.pluginDraft), 'utf8');
  assert.ok(!raw.includes('never-export-sensitive-value'));
  const draft = JSON.parse(raw), created = personal.create(f.app, draft).plugin;
  const exported = await personal.exportToFile(f.app, { showSaveDialog: async () => ({ canceled: false,
    filePath: path.join(f.root, 'fixture.soduwork-plugin') }) }, created.pluginId);
  assert.equal(exported.ok, true);
  const restored = readPersonalArchive(fs.readFileSync(exported.filePath));
  const other = path.join(f.root, 'other'); fs.mkdirSync(other);
  const installed = personal.create({ getPath: () => other }, restored).plugin;
  assert.deepEqual(installed.capabilities.mcpServers, ['fixture']);
  const content = Buffer.from(restored.resources[0].content, 'base64').toString('utf8');
  const row = JSON.parse(content).mcpServers.fixture;
  assert.equal(row.enabled, false); assert.equal(row.headers.Authorization, '');
  assert.deepEqual(row.enabledTools, ['read_status']); assert.deepEqual(row.disabledTools, ['delete_item']);
  assert.equal(row.toolTimeoutSeconds, 25);
  assert.equal(fs.readFileSync(path.join(out, restored.resources[0].path), 'utf8'), content);
});

test('arbitrary local commands are identified for admin review and cannot become a personal connector package', t => {
  const f = fixture(t);
  input(f, { command: 'node', args: ['unreviewed.js'], env: {} });
  fs.writeFileSync(f.metadata, JSON.stringify(metadata));
  assert.deepEqual(maker.prepare(f.input, path.join(f.root, 'prepared')).requiresAdminReview, ['fixture']);
  assert.throws(() => maker.bundle(f.input, f.metadata, path.join(f.root, 'bundle')), /管理员审查/);
  assert.equal(fs.existsSync(path.join(f.root, 'bundle')), false);
});

test('REST authoring bundles the canonical document, scope and empty credentials through installed resources', t => {
  const f = fixture(t), api = { name: 'Projects', baseUrl: 'https://fixture.invalid',
    securitySchemes: { account: { type: 'http', scheme: 'bearer' } }, security: [{ account: [] }],
    endpoints: [{ method: 'GET', path: '/projects', operationId: 'list_projects' }] };
  input(f, { command: 'soduwork-api', args: [], apiDefinition: api, enabledTools: ['list_projects'] });
  fs.writeFileSync(f.metadata, JSON.stringify(metadata));
  maker.bundle(f.input, f.metadata, path.join(f.root, 'api'));
  const draft = JSON.parse(fs.readFileSync(path.join(f.root, 'api/soduwork-plugin-draft.json'), 'utf8'));
  assert.equal(personal.preflight(draft).ok, true);
  const row = JSON.parse(draft.resources[0].content).mcpServers.fixture;
  assert.equal(row.apiDefinition.openapiDocument.openapi, '3.0.3');
  assert.deepEqual(row.enabledTools, ['list_projects']);
  assert.ok(Object.values(row.env).every(x => x === ''));
  assert.throws(() => maker.bundle(f.input, f.metadata, path.join(f.root, 'api')), /已存在/);
});
