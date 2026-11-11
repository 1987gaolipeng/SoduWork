'use strict';

// Integration fixtures stay offline: only the real parser and inert local CLI stubs run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const resources = require('../main/plugin-resources');
const personal = require('../main/personal-plugins');
const grants = require('../main/pi-session/plugin-grant');
const repo = path.resolve(__dirname, '../..');
const backend = path.join(repo, 'hub-backend');
const sources = path.join(backend, 'plugins', 'platforms');
const providers = ['feishu', 'dingtalk', 'wecom'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const locks = Object.fromEntries(providers.map(name => [name,
  JSON.parse(fs.readFileSync(path.join(sources, name, 'upstream-lock.json'), 'utf8'))]));
let actualPacks;

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-platform-test-'));
  t.after(() => {
    // The only recursive removal target is this verified test-created temporary directory.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('soduwork-platform-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function packs(t) {
  if (actualPacks) return actualPacks;
  const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) { t.skip('Backend venv required; set SODUWORK_TEST_PYTHON for parser integration.'); return null; }
  const code = [
    'import json',
    'from build_platform_plugins import PLATFORMS, package_bytes',
    'from app.services import plugin_packages',
    'result = {}',
    'for provider in PLATFORMS:',
    '    parsed = plugin_packages.parse(package_bytes(provider))',
    '    result[provider] = {"manifest": parsed["manifest"], "bundle": parsed["resourceBundle"],',
    '                        "draft": plugin_packages.personal_draft(parsed)}',
    'print(json.dumps(result, ensure_ascii=False))',
  ].join('\n');
  const result = spawnSync(python, ['-c', code], {
    cwd: backend, env: { ...process.env, PYTHONIOENCODING: 'utf-8',
      DATABASE_URL: 'sqlite+aiosqlite:///:memory:', CLUSTER_REDIS_URL: '',
      AUTH_SECRET: 'isolated-platform-package-fixture-key', ADMIN_PASS: 'isolated-platform-package-fixture-password' },
    encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  actualPacks = JSON.parse(result.stdout);
  return actualPacks;
}
async function launcher(t, provider) {
  const root = temporary(t), folder = path.join(root, 'plugin resources');
  const scripts = path.join(folder, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const runtime = path.join(scripts, 'runtime.mjs');
  fs.copyFileSync(path.join(sources, 'runtime.mjs'), runtime);
  fs.writeFileSync(path.join(folder, 'upstream-lock.json'), JSON.stringify(locks[provider]));
  return { root, folder, runtime, api: await import(pathToFileURL(runtime).href),
    prefix: path.join(root, 'fixed CLI install'), state: path.join(root, 'private user', 'state') };
}
function installStub(f, provider) {
  const lock = locks[provider], dir = path.join(f.prefix, 'node_modules', ...lock.package.split('/'));
  fs.mkdirSync(path.dirname(path.join(dir, lock.entry)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: lock.package, version: lock.version,
    bin: { maliciousAlternative: 'do-not-execute.js' } }));
  const entry = path.join(dir, lock.entry), marker = path.join(f.root, 'entry-executed');
  const source = [
    'const fs = require("node:fs");',
    'fs.writeFileSync(' + JSON.stringify(marker) + ', "stub executed");',
    'console.log(JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(),',
    'env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(DWS_|WECOM_CLI_|SODUWORK_TEST_KEEP)/i.test(key))),',
    'hasUserToken: !!process.env.USER_ACCESS_TOKEN, hasLarkOverride: Object.keys(process.env).some(k => /^LARK_/i.test(k)),',
    'appCredentialsPresent: !!process.env.APP_ID && !!process.env.APP_SECRET}));',
  ].join('\n');
  fs.writeFileSync(entry, source);
  if (provider === 'dingtalk') {
    const vendor = path.join(dir, 'vendor');
    fs.mkdirSync(vendor);
    fs.writeFileSync(path.join(vendor, process.platform === 'win32' ? 'dws.exe' : 'dws'), 'inert binary fixture');
  }
  return { dir, entry, marker };
}
function run(f, args, env = {}) {
  const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(APP_ID$|APP_SECRET$|USER_ACCESS_TOKEN$|LARK_|DWS_|WECOM_CLI_)/i.test(key)));
  return spawnSync(process.execPath, [f.runtime, ...args], {
    cwd: f.root, env: { ...isolated, ...env }, encoding: 'utf8',
    timeout: 15000, shell: false, windowsHide: true,
  });
}
function assertSuccess(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const provider of providers) {
  test(provider + ': actual backend package survives shared grant materialization byte-for-byte', async t => {
    const all = packs(t); if (!all) return;
    const pack = all[provider], root = temporary(t), incoming = structuredClone(pack.bundle);
    const result = await grants.resolve({
      app: { getPath: () => root }, cwd: root, pluginIds: ['shared-' + provider], ref: 'offline-fixture',
      identityOf: async () => ({ hub: 'https://example.invalid', clientId: 'test-device', session: 'fixture' }),
      fetchImpl: async (_url, options) => {
        assert.equal(JSON.parse(options.body).resourceProtocol, 1);
        return { ok: true, json: async () => ({ ok: true, items: [{
          pluginId: 'shared-' + provider, key: pack.manifest.key, name: pack.manifest.name,
          version: pack.manifest.version, context: pack.manifest.instructions,
          capabilities: pack.manifest.capabilities, resourceBundle: incoming,
        }] }) };
      },
    });
    assert.equal(result.items[0].resourceBundle, undefined, 'Binary files never remain in renderer state');
    assert.equal(result.grant, null, 'Fixture grants no live platform access');
    const normalized = resources.normalize(pack.bundle.resources);
    assert.equal(resources.digest(normalized), pack.bundle.digest, 'Python and Node digests agree');
    const materialized = resources.materialize(normalized, root, pack.manifest.key);
    assert.match(result.items[0].context, /本轮插件随包资源/);
    assert.ok(result.items[0].context.includes(materialized.directory));
    for (const item of normalized) {
      const bytes = fs.readFileSync(path.join(materialized.directory, ...item.path.split('/')));
      assert.equal(hash(bytes), item.sha256, item.path);
      assert.equal(bytes.length, item.size, item.path);
    }
    const names = new Set(normalized.map(item => item.path));
    for (const skill of pack.bundle.skills) assert.ok(names.has(skill.path), skill.path);
    for (const upstreamPath of Object.keys(locks[provider].upstreamFiles)) {
      assert.ok(names.has('references/plugin-package/' + upstreamPath), 'Missing upstream reference: ' + upstreamPath);
    }
    assert.ok(names.has('references/plugin-package/scripts/runtime.mjs'));
    assert.ok(names.has('references/plugin-package/skills/' + provider + '/SKILL.md'));
    const runtime = path.join(materialized.directory, 'references/plugin-package/scripts/runtime.mjs');
    const info = spawnSync(process.execPath, [runtime, 'info'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const guidance = assertSuccess(info);
    assert.equal(guidance.version, locks[provider].version, 'Delivered runtime finds its adjacent lock');
    if (provider === 'dingtalk') {
      assert.ok(guidance.installArgv.includes('--ignore-scripts'), 'Official npm skill-writing postinstall is disabled');
      assert.equal(guidance.installArgv.at(-1), locks[provider].package + '@' + locks[provider].version);
      assert.equal(guidance.prepareArgv[0], 'python');
      assert.equal(guidance.prepareArgv[1], path.join(path.dirname(runtime), 'prepare-dingtalk.py'));
      assert.ok(fs.existsSync(guidance.prepareArgv[1]), 'Delivered package includes the safe binary preparer');
      assert.deepEqual(guidance.prepareArgv.slice(2), ['--prefix', '<absolute-dir>']);
    }
    assert.equal(fs.existsSync(path.join(root, 'entry-executed')), false);
  });

  test(provider + ': full personal import, export, reinstall and local turn retain complete resources', async t => {
    const all = packs(t); if (!all) return;
    const pack = all[provider], root = temporary(t), second = temporary(t), work = temporary(t);
    const app = { getPath: () => root };
    const installed = personal.create(app, pack.draft).plugin;
    const exported = personal.exportDraft(app, installed.pluginId);
    assert.deepEqual(resources.summary(exported.resources), resources.summary(pack.bundle.resources));
    const imported = personal.create({ getPath: () => second }, exported).plugin;
    assert.equal(imported.checksum, installed.checksum);
    // A personal Feishu pack still requests the existing Hub grant; the fixture grants no ticket.
    const result = await grants.resolve({ app, cwd: work, pluginIds: [installed.pluginId],
      identityOf: async () => ({ hub: 'https://example.invalid', clientId: 'test-device', session: 'fixture' }),
      fetchImpl: async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body).personalMcpServers, pack.draft.mcpServers);
        return { ok: true, json: async () => ({ ok: true, items: [], mcpGrant: null }) };
      },
    });
    const expected = resources.materialize(exported.resources, work, pack.manifest.key);
    assert.ok(result.items[0].context.includes(expected.directory));
    assert.equal(expected.digest, pack.bundle.digest);
    assert.equal(result.items[0].capabilities.resources.length, pack.bundle.resources.length);
    for (const item of exported.resources) {
      assert.equal(hash(fs.readFileSync(path.join(expected.directory, ...item.path.split('/')))), item.sha256);
    }
  });

  test(provider + ': check is inert and refuses wrong version, absent entry and redirected bin metadata', async t => {
    const f = await launcher(t, provider), lock = locks[provider];
    assert.equal(f.api.inspect(lock, f.prefix).status, 'not-installed');
    const installed = installStub(f, provider);
    assert.equal(f.api.inspect(lock, f.prefix).entry, installed.entry);
    const checked = assertSuccess(run(f, ['check', '--prefix', f.prefix]));
    assert.deepEqual(checked, { status: 'installed', version: lock.version, authentication: 'not-checked' });
    assert.equal(fs.existsSync(installed.marker), false, 'check must not execute or authenticate the CLI');
    if (provider === 'dingtalk') {
      const binary = path.join(installed.dir, 'vendor', process.platform === 'win32' ? 'dws.exe' : 'dws');
      fs.unlinkSync(binary);
      assert.equal(f.api.inspect(lock, f.prefix).status, 'binary-not-prepared');
      assert.equal(run(f, ['check', '--prefix', f.prefix]).status, 2);
      assert.equal(fs.existsSync(installed.marker), false);
      fs.writeFileSync(binary, 'inert binary fixture');
    }
    fs.writeFileSync(path.join(installed.dir, 'package.json'), JSON.stringify({ name: lock.package, version: '0.0.0' }));
    assert.equal(f.api.inspect(lock, f.prefix).status, 'version-mismatch');
    const bad = run(f, ['check', '--prefix', f.prefix]);
    assert.equal(bad.status, 2);
    assert.equal(fs.existsSync(installed.marker), false);
    fs.writeFileSync(path.join(installed.dir, 'package.json'), JSON.stringify({ name: lock.package, version: lock.version }));
    fs.unlinkSync(installed.entry);
    assert.equal(f.api.inspect(lock, f.prefix).status, 'entry-missing');
    assert.throws(() => f.api.inspect(lock, 'relative-path'), /绝对路径/);
  });
}

for (const provider of ['dingtalk', 'wecom']) {
  test(provider + ': spawned CLI receives literal argv and only its selected private authorization state', async t => {
    const f = await launcher(t, provider); installStub(f, provider);
    const namespace = provider === 'wecom' ? 'WECOM_CLI_' : 'DWS_';
    const other = provider === 'wecom' ? 'DWS_' : 'WECOM_CLI_';
    const argv = ['--help', 'a value with spaces', '; echo injected', '$(echo injected)', '& whoami', '"quoted"', '中文'];
    const contamination = { [namespace + 'CONFIG_DIR']: 'unrelated-account', [namespace + 'ACCESS_TOKEN']: 'fixture-value',
      [namespace.toLowerCase() + 'base_url']: 'https://example.invalid', [other + 'KEEP']: 'unrelated-provider',
      SODUWORK_TEST_KEEP: 'preserved' };
    const result = assertSuccess(run(f, ['run', '--prefix', f.prefix, '--state', f.state, '--', ...argv], contamination));
    assert.deepEqual(result.argv, argv, 'No shell interpolation, splitting, or execution');
    assert.equal(result.cwd, fs.realpathSync(f.prefix), 'CLI avoids reading business project configuration');
    assert.equal(result.env[namespace + 'CONFIG_DIR'], f.api.canonicalTarget(f.state));
    assert.equal(result.env[namespace + 'ACCESS_TOKEN'], undefined);
    assert.equal(result.env[namespace.toLowerCase() + 'base_url'], undefined);
    assert.equal(result.env[other + 'KEEP'], 'unrelated-provider');
    assert.equal(result.env.SODUWORK_TEST_KEEP, 'preserved');
    if (provider === 'wecom') {
      assert.equal(result.env.WECOM_CLI_TMP_DIR, path.join(f.state, 'tmp'));
      assert.equal(result.env.WECOM_CLI_LOG_DIR, path.join(f.state, 'logs'));
    }
    assert.equal(fs.existsSync(f.state), false, 'The stub never creates or reads any user account');
    assert.throws(() => f.api.plan(locks[provider], { action: 'run', prefix: f.prefix, args: ['--help'] }, {}), /私有授权目录/);
    assert.throws(() => f.api.plan(locks[provider], { action: 'run', prefix: f.prefix, state: path.join(f.folder, 'account'), args: ['--help'] }, {}), /插件资源包/);
    const alias = path.join(f.root, 'plugin-alias');
    fs.symlinkSync(f.folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.api.plan(locks[provider], { action: 'run', prefix: f.prefix, state: path.join(alias, 'new-state'), args: ['--help'] }, {}), /插件资源包/);
  });
}

test('Feishu serves only the official loopback MCP with application credentials outside argv and output', async t => {
  const f = await launcher(t, 'feishu'); installStub(f, 'feishu');
  const env = { APP_ID: 'fixture-app', APP_SECRET: 'fixture-secret-never-log',
    USER_ACCESS_TOKEN: 'fixture-user-never-use', LARK_DOMAIN: 'https://example.invalid' };
  const opt = { action: 'serve', prefix: f.prefix, port: '4321', tools: 'preset.default', args: [] };
  const planned = f.api.plan(locks.feishu, opt, env);
  assert.equal(planned.command, process.execPath);
  assert.equal(planned.env.APP_SECRET, env.APP_SECRET);
  assert.equal(planned.env.USER_ACCESS_TOKEN, undefined);
  assert.equal(planned.env.LARK_DOMAIN, undefined);
  assert.equal(planned.cwd, fs.realpathSync(f.prefix));
  assert.equal(env.USER_ACCESS_TOKEN, 'fixture-user-never-use', 'Caller environment is not mutated');
  const result = run(f, ['serve', '--prefix', f.prefix, '--port', '4321'], env);
  const observed = assertSuccess(result);
  assert.deepEqual(observed.argv, ['mcp', '-d', 'https://open.feishu.cn', '-m', 'streamable', '--host', '127.0.0.1',
    '-p', '4321', '--token-mode', 'tenant_access_token', '-l', 'zh', '-t', 'preset.default']);
  assert.equal(observed.cwd, fs.realpathSync(f.prefix));
  assert.equal(observed.appCredentialsPresent, true);
  assert.equal(observed.hasUserToken, false);
  assert.equal(observed.hasLarkOverride, false);
  for (const value of Object.values(env)) {
    assert.ok(!result.stdout.includes(value)); assert.ok(!result.stderr.includes(value));
    assert.ok(!JSON.stringify(planned.args).includes(value));
  }
  assert.throws(() => f.api.plan(locks.feishu, opt, {}), /APP_ID 和 APP_SECRET/);
  for (const port of ['1', '65536', 'abc', '4000.5']) {
    assert.throws(() => f.api.plan(locks.feishu, { ...opt, port }, env), /端口/);
  }
  assert.throws(() => f.api.plan(locks.feishu, { ...opt, args: ['--host', '0.0.0.0'] }, env), /透传参数/);
  assert.throws(() => f.api.plan(locks.feishu, { ...opt, action: 'run', args: ['login'] }, env), /只提供 serve/);
});

test('launcher options reject ambiguous controls and retain exact business arguments after delimiter', async t => {
  const f = await launcher(t, 'dingtalk');
  assert.deepEqual(f.api.options(['run', '--prefix', f.prefix, '--state', f.state, '--', '--prefix', 'business']),
    { action: 'run', prefix: f.prefix, state: f.state, args: ['--prefix', 'business'] });
  for (const argv of [['install'], ['run', '--prefix'], ['run', '--prefix', '--state'],
    ['run', '--prefix', f.prefix, '--prefix', f.prefix], ['check', '--unknown', 'value']]) {
    assert.throws(() => f.api.options(argv));
  }
});
test('unconfigured platform detail keeps escaped setup guidance visible before trial is available', async () => {
  const vm = require('node:vm');
  const setup = '配置飞书 <img src=x onerror=alert(1)>，账号独立授权';
  const item = { pluginId: 'feishu', key: 'feishu', name: '飞书', version: '1.0.1', enabled: true,
    installed: false, setup: { description: setup }, capabilities: { hasWorkflow: false, mcpServers: ['feishu'] },
    dependencyReadiness: { missingMcp: ['feishu'] }, conversationUse: { available: false } };
  const window = {
    PluginUIHost: { catalogPresentation: () => ({ notice: '', rows: [], descriptions: [], action: '' }),
      bindCatalogDetail: () => {} },
    SoduWorkPluginPresentation: { tabs: () => '', detail: () => {} },
    SoduWorkPluginInstallSetup: { needs: () => true },
  };
  const sandbox = { window, PluginUIHost: window.PluginUIHost, SoduWorkAPI: { pluginCatalog: async () => ({ items: [item] }) } };
  for (const name of ['plugin-catalog-format.js', 'plugin-dependency-ux.js', 'plugin-lifecycle.js', 'panels-capability-plugins.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(repo, 'client/components/panels', name), 'utf8'), sandbox, { filename: name });
  }
  await window.SoduWorkCapabilityPlugins.load();
  let html = '', actions = '';
  window.SoduWorkCapabilityPlugins.open(item.pluginId, { openModal: (_title, _subtitle, body, footer) => {
    html = body; actions = footer; return { querySelector: () => null };
  } });
  assert.match(html, /使用准备/);
  assert.match(html, /配置飞书 &lt;img src=x onerror=alert\(1\)&gt;，账号独立授权/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.indexOf('使用准备') < html.indexOf('id="capDetailResources"'), 'Guide is in the visible overview');
  assert.doesNotMatch(actions, /id="capPluginTry"/, 'An unconfigured MCP is not advertised as ready');
  const setupSource = fs.readFileSync(path.join(repo, 'client/components/panels/plugin-install-setup.js'), 'utf8');
  assert.match(setupSource, /账号与密钥单独配置，不写入插件偏好；安装不会自动完成平台授权/);
});
test('DingTalk check refuses a prepared binary redirected outside the fixed installation', async t => {
  const f = await launcher(t, 'dingtalk'), stub = installStub(f, 'dingtalk');
  const vendor = path.join(stub.dir, 'vendor'), outside = path.join(f.root, 'untrusted vendor');
  fs.renameSync(vendor, outside);
  fs.symlinkSync(outside, vendor, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.api.inspect(locks.dingtalk, f.prefix), /二进制入口必须位于独立安装目录/);
  assert.equal(fs.existsSync(stub.marker), false);
});

test('each installable package explains only its own authorization flow', t => {
 const bundles=packs(t);if(!bundles)return;
 const names={wecom:'企业微信',dingtalk:'钉钉',feishu:'飞书'};
 for(const key of providers){
  const manifest=bundles[key].manifest;
  assert.match(manifest.setup.description,new RegExp(names[key]));
  for(const other of providers.filter(k=>k!==key))assert.ok(!manifest.setup.description.includes(names[other]),key+' refers to '+other);
  assert.equal(manifest.key,key);assert.equal(locks[key].provider,key);
  assert.deepEqual(manifest.capabilities.mcpServers,key==='feishu'?['feishu']:[]);
 }
});
