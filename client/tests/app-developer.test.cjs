'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const personal = require('../main/personal-plugins');
const resources = require('../main/plugin-resources');
const drafts = require('../main/pi-session/plugin-draft');
const reader = require('../main/plugin-package-reader.cjs');
const { scaffold } = require('../../skills/app-developer/scripts/scaffold.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-authoring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, app: { getPath: () => root }, out: path.join(root, 'candidate') };
}
function build(f) {
  return scaffold({ out: f.out, key: 'notes-demo', name: '便签应用', url: 'http://127.0.0.1:8098/' });
}
function collected(f) {
  const entry = { artifactId: 'app-draft', path: path.join(f.out, drafts.DRAFT_NAME), relative: drafts.DRAFT_NAME };
  return drafts.readSession({ cwd: f.out, sessionId: 'author', inFlight: () => false,
    outputSnapshot: () => ({ files: [entry], delivery: { items: [entry] } }) }, entry.artifactId);
}

test('bundled authoring check uses installer rules, rejects root scripts and missing icons, and preserves portable artwork', async t => {
  const f = fixture(t);
  scaffold({ out: f.out, key: 'brainstorm-canvas', name: '头脑风暴画布' });
  const developer = personal.get(f.app, personal.APP_DEVELOPER_ID);
  const bundle = resources.materialize(developer.localDraft.resources, f.root, developer.key);
  const folder = path.join(bundle.directory, 'references/developer');
  const validator = require(path.join(folder, 'scripts/validate.cjs'));
  for (const name of require('../main/app-developer-plugin.cjs').VALIDATION_FILES) {
    assert.deepEqual(fs.readFileSync(path.join(folder, 'validation', name)),
      fs.readFileSync(path.resolve(__dirname, '..', name)), name + ' must match the installer');
  }
  const draft = path.join(f.out, drafts.DRAFT_NAME);
  const body = JSON.parse(fs.readFileSync(draft, 'utf8'));
  assert.throws(() => validator.validate(draft, f.root), /缺少专属彩色图标/);
  body.icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=';
  const write = () => fs.writeFileSync(draft, JSON.stringify(body));
  write();
  const before = fs.readFileSync(draft);
  assert.equal(validator.validate(draft, f.root).ok, true);
  assert.deepEqual(fs.readFileSync(draft), before, 'validation must be read-only');
  fs.mkdirSync(path.join(f.out, 'assets'));
  const artwork = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#7c5cff" d="M8 8h32v32H8z"/><circle fill="#ffc83d" cx="24" cy="24" r="10"/></svg>';
  fs.writeFileSync(path.join(f.out, 'assets/icon.svg'), artwork);
  const image = { path: 'assets/icon.svg', kind: 'icon' };
  body.resources.push(image); write();
  for (const kind of ['icon', 'assets', 'scripts', 'references']) {
    image.kind = kind; write();
    assert.throws(() => validator.validate(draft, f.root), /插件资源类型不合法：assets\/icon\.svg/);
    const rejected = collected(f);
    assert.equal(rejected.ok, false); assert.match(rejected.reason, /插件资源类型不合法：assets\/icon\.svg/);
  }
  image.kind = 'asset'; write();
  assert.equal(validator.validate(draft, f.root).ok, true);
  assert.equal(collected(f).ok, true);
  for (const name of ['server.cjs', 'start.cmd', 'package.json', 'data/board.json', '../outside.js']) {
    body.resources.push({ path: name, kind: 'script' }); write();
    assert.throws(() => validator.validate(draft, f.root), error =>
      /资源须放在/.test(error.message) && error.message.includes(name));
    const read = collected(f);
    assert.equal(read.ok, false); assert.ok(read.reason.includes(name));
    body.resources.pop();
  }
  body.resources.push({ path: 'scripts/server.cjs', kind: 'script' }); write();
  assert.throws(() => validator.validate(draft, f.root), /ENOENT/);
  fs.mkdirSync(path.join(f.out, 'scripts'));
  fs.writeFileSync(path.join(f.out, 'scripts/server.cjs'), 'throw Error("must never execute on install")');
  assert.equal(validator.validate(draft, f.root).ok, true);
  body.ui.contributions[0].source.entry = 'ui/missing.html'; write();
  assert.throws(() => validator.validate(draft, f.root), /入口未包含/);
  body.ui.contributions[0].source.entry = 'ui/index.html'; write();
  const checked = validator.validate(draft, f.root);
  assert.equal(checked.installed, false); assert.equal(checked.runtimeTested, false);
  const installed = personal.create(f.app, collected(f).body).plugin;
  assert.equal(installed.icon, body.icon);
  const file = path.join(f.root, 'brainstorm.soduwork-plugin');
  await personal.exportToFile(f.app, { showSaveDialog: async () => ({ filePath: file }) }, installed.pluginId);
  const imported = reader.readPersonalArchive(fs.readFileSync(file));
  assert.equal(imported.icon, body.icon);
  const portableArtwork = imported.resources.find(row => row.path === 'assets/icon.svg');
  assert.equal(portableArtwork.kind, 'asset');
  assert.equal(Buffer.from(portableArtwork.content, 'base64').toString(), artwork);
  assert.equal(personal.preflight(imported).manifest.icon, body.icon);
  for (const guide of [developer.localDraft.instructions, fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8')]) {
    assert.match(guide, /彩色图标/); assert.match(guide, /validate\.cjs/);
    assert.match(guide, /顶层.*icon/); assert.match(guide, /96\s?KB/);
  }
});

test('built-in app developer inherits the current plugin contract and exact public SDK, without installation side effects', t => {
  const f = fixture(t), detail = personal.get(f.app, personal.APP_DEVELOPER_ID);
  assert.equal(detail.builtIn, true);
  assert.equal(detail.name, '即用开发');
  assert.equal(detail.localDraft.locales['en-us'].name, 'App Developer');
  assert.equal(detail.entrypoints.automation, false);
  assert.deepEqual(detail.capabilities.runtime, ['files', 'terminal', 'browser']);
  assert.ok(personal.catalog(f.app).some(x => x.pluginId === personal.APP_DEVELOPER_ID));
  const bundle = resources.materialize(detail.localDraft.resources, f.root, detail.key);
  const folder = path.join(bundle.directory, 'references/developer');
  assert.equal(fs.readFileSync(path.join(folder, 'plugin-development.md'), 'utf8'), require('../main/plugin-builder-plugin.cjs').body().instructions);
  assert.deepEqual(fs.readFileSync(path.join(folder, 'sdk/soduwork-app.js')), fs.readFileSync(path.resolve(__dirname, '../sdk/soduwork-app.js')));
  const entryGuide = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
  // Apply the same Markdown character budget on LF and CRLF checkouts.
  assert.ok(entryGuide.replace(/\r\n/g, '\n').length < 1600, 'entrypoint stays concise');
  assert.match(entryGuide,/references\/host-sdk\.md/);
  const workflow = fs.readFileSync(path.join(folder, 'references/development-workflow.md'), 'utf8');
  const design = fs.readFileSync(path.join(folder, 'references/design-quality.md'), 'utf8');
  const structure = fs.readFileSync(path.join(folder, 'references/local-app-structure.md'), 'utf8');
  assert.deepEqual(fs.readFileSync(path.join(folder, 'references/local-files.md')),
    fs.readFileSync(path.resolve(__dirname, '../../skills/app-developer/references/local-files.md')),
    'file guidance must be physically distributed with the developer plugin');
  assert.equal(detail.localDraft.version, require('../main/app-developer-plugin.cjs').body(f.app).version);
  assert.match(entryGuide, /references\/local-app-structure\.md/);
  assert.match(workflow, /local-app-structure\.md/);
  assert.match(detail.localDraft.instructions, /简单本地即用[\s\S]*直接挂载 div[\s\S]*Web服务\/H5技术栈不限/);
  assert.match(structure, /mount\(container, context\)/);
  assert.match(structure, /300～500[\s\S]*800行是评审提醒/);
  assert.match(structure, /Web 服务与 H5[\s\S]*Vue、React/);
  assert.match(structure, /解除事件、订阅、定时器[\s\S]*丢弃旧响应/);
  assert.match(workflow, /一句必填意图[\s\S]*标题＋内容[\s\S]*派生字段由AI/);
  assert.match(workflow, /禁止分类下拉、标签输入等管理表单/);
  assert.match(workflow, /复制、搜索、分页、校验、游戏实时交互直接执行/);
  assert.match(design, /避免模板化渐变、大圆角卡片堆叠/);
  assert.match(design, /视觉网站查询可选[\s\S]*最新[\s\S]*未查询不虚构出处/);
  assert.match(design, /性能、可访问性与维护成本/);
  const developerGuide = fs.readFileSync(path.join(folder, 'references/bridge-and-delivery.md'), 'utf8');
  const sdkGuide = fs.readFileSync(path.join(folder, 'sdk/README.md'), 'utf8');
  assert.match(detail.localDraft.instructions, /机器人[\s\S]*soduWorkApp\.automation\.create/);
  for (const guide of [developerGuide, sdkGuide]) {
    assert.match(guide, /即用页面严禁出现“自动化”按钮/);
    assert.match(guide, /订阅简报/);
    assert.doesNotMatch(guide, /偷菜/);
    assert.match(guide, /automation\.create/);
    assert.match(guide, /不代表业务执行成功|不是执行结果/);
  }
  assert.match(developerGuide, /不能编造 SDK 尚未提供的列表、暂停、删除接口/);
  const script = path.join(folder, 'scripts/scaffold.cjs');
  require(script).scaffold({ out: f.out, key: 'notes-demo', name: '便签应用', url: 'http://127.0.0.1:8098/' });
  const resolved = personal.resolve(f.app, [personal.APP_DEVELOPER_ID], { cwd: f.root });
  assert.match(resolved.items[0].context, /references\/developer\/SKILL.md/);
  assert.equal(fs.existsSync(path.join(f.root, 'personal-plugins.json')), false);
});

test('bundled file handoff example preserves retry identity and separates accepted sends from cleanup failures', async t => {
  const f = fixture(t), detail = personal.get(f.app, personal.APP_DEVELOPER_ID);
  const bundle = resources.materialize(detail.localDraft.resources, f.root, detail.key);
  const guide = fs.readFileSync(path.join(bundle.directory, 'references/developer/references/local-files.md'), 'utf8');
  const code = guide.match(/```js\r?\n([\s\S]*?)\r?\n```/)[1];
  const calls = [], picked = [{ id: 'opaque-file', name: 'material.txt', size: 12 }];
  let sendFails = true, cleanupFails = false;
  const context = vm.createContext({ soduWorkApp: {
    createRequestId: () => 'stable-submission',
    attachments: {
      pick: async () => ({ ok: true, items: picked }),
      check: async ids => { calls.push(['check', [...ids]]); return { ok: true }; },
      release: async ids => { calls.push(['release', [...ids]]); if (cleanupFails) throw Error('cleanup blocked'); return { ok: true }; },
    },
    chat: { send: async request => { calls.push(['send', JSON.parse(JSON.stringify(request))]);
      return sendFails ? { ok: false, reason: 'not accepted' } : { ok: true }; } },
  } });
  vm.runInContext(code, context);
  const submission = context.makeSubmission('Process the selected file', await context.pickFiles());
  await assert.rejects(context.sendSubmission(submission), /not accepted/);
  assert.equal(calls.some(row => row[0] === 'release'), false, 'failure retains file references');
  sendFails = false; cleanupFails = true;
  const result = await context.sendSubmission(submission);
  assert.equal(result.accepted, true, 'release failure cannot turn an accepted send into a retry');
  assert.equal(result.cleanupWarning, 'cleanup blocked');
  const sent = calls.filter(row => row[0] === 'send').map(row => row[1]);
  assert.deepEqual(sent[0], sent[1], 'retry retains the original request and attachment IDs');
  assert.equal(sent[0].requestId, 'stable-submission');
  assert.deepEqual(sent[0].attachmentIds, ['opaque-file']);
  picked.length = 0;
  assert.equal((await context.pickFiles()).length, 0, 'native cancellation supplies no files');
});

test('generated app installs from its own conversation artifact, exports and reimports with type and resources intact', async t => {
  const f = fixture(t); build(f);
  const read = collected(f); assert.equal(read.ok, true, read.reason);
  const checked = personal.preflight(read.body);
  assert.equal(checked.manifest.template, 'app');
  assert.equal(checked.capabilities.network, true);
  assert.equal(checked.capabilities.interactiveUi, true);
  assert.equal(checked.capabilities.entrypoints.automation, false);
  assert.equal(checked.manifest.appWindow, undefined);
  assert.deepEqual(checked.capabilities.mcpServers, [], 'standalone apps do not acquire an MCP prerequisite');
  assert.deepEqual(read.body.ui.contributions[0].source.bridge.capabilities, ['conversation.send', 'composer.control']);
  const standalone = require('../main/application-turn-context.cjs').describe({ pluginId: 'local:notes-demo',
    pageUrl: read.body.ui.contributions[0].source.url }, [{ pluginId: 'local:notes-demo',
    capabilities: checked.capabilities }], []);
  assert.equal(standalone.connection.status, 'not_declared', 'a standalone app needs no business credentials to prepare its conversation');
  const created = personal.create(f.app, read.body).plugin;
  assert.equal(created.template, 'app');
  const packagePath = path.join(f.root, 'notes.soduwork-plugin');
  await personal.exportToFile(f.app, { showSaveDialog: async () => ({ filePath: packagePath }) }, created.pluginId);
  const imported = reader.readPersonalArchive(fs.readFileSync(packagePath));
  assert.equal(imported.template, 'app');
  assert.equal(imported.resources.length, 3);
  assert.equal(personal.preflight(imported).manifest.template, 'app');
  assert.deepEqual(imported.ui, personal.get(f.app, created.pluginId).ui);
  assert.equal(personal.create(f.app, read.body).created, false);
  assert.throws(() => personal.create(f.app, { ...read.body, instructions: '修改了内容' }), /版本/);
});

test('default static H5 scaffold declares a bundled entry and survives portable export without a service URL', async t => {
  const f = fixture(t);
  scaffold({ out: f.out, key: 'static-demo', name: '单机便签', entry: 'ui/pages/index.html' });
  const read = collected(f); assert.equal(read.ok, true, read.reason);
  const source = read.body.ui.contributions[0].source;
  assert.equal(source.type, 'package'); assert.equal(source.entry, 'ui/pages/index.html'); assert.equal(source.url, undefined);
  assert.deepEqual(read.body.mcpServers, []);
  assert.match(fs.readFileSync(path.join(f.out, source.entry), 'utf8'), /src="\.\.\/soduwork-app.js"/);
  const created = personal.create(f.app, read.body).plugin;
  const file = path.join(f.root, 'static.soduwork-plugin');
  await personal.exportToFile(f.app, { showSaveDialog: async () => ({ filePath: file }) }, created.pluginId);
  const imported = reader.readPersonalArchive(fs.readFileSync(file));
  assert.equal(personal.preflight(imported).manifest.ui.contributions[0].source.type, 'package');
  assert.ok(imported.resources.some(row => row.path === 'ui/pages/index.html' && row.kind === 'ui'));
  for (const entry of ['../index.html', 'ui/../index.html', 'file:///index.html', '/ui/index.html', 'ui/index.js', 'ui/%2e%2e/index.html']) {
    const bad = structuredClone(read.body); bad.ui.contributions[0].source.entry = entry;
    assert.throws(() => personal.preflight(bad), /入口|路径/);
  }
  const missing = structuredClone(read.body); missing.resources = missing.resources.filter(row => row.path !== source.entry);
  assert.throws(() => personal.preflight(missing), /入口未包含/);
});

test('app discriminator rejects missing, external-only or credentialed pages and leaves old method manifests compatible', t => {
  const f = fixture(t); build(f); const { body } = collected(f);
  for (const ui of [undefined, { contributions: [] }, { contributions: [{ id: 'main', title: '应用', slot: 'workspace.navigation', source: { type: 'external', openMode: 'external', url: 'https://example.invalid/' } }] },
    { contributions: [{ id: 'main', title: '应用', slot: 'workspace.navigation', source: { type: 'external', url: 'https://user:pass@example.invalid/' } }] }]) {
    assert.throws(() => personal.preflight({ ...body, ui }));
  }
  const legacy = personal.preflight({ ...body, template: 'method' });
  assert.equal(legacy.manifest.template, undefined);
  assert.equal(legacy.capabilities.interactiveUi, true);
});

test('scaffolding never overwrites an existing directory, declares actual resources and never claims runtime testing', t => {
  const f = fixture(t), result = build(f);
  assert.equal(result.installed, false); assert.equal(result.runtimeTested, false);
  const manifest = require('../main/conversation/delivery-contract').readManifest(f.out);
  assert.equal(manifest.invalid, undefined);
  assert.equal(manifest.deliverables[0].path, 'soduwork-plugin-draft.json');
  assert.throws(() => build(f), /已经存在/);
  assert.equal(collected(f).body.resources.length, 3);
  fs.unlinkSync(path.join(f.out, 'ui/app.js'));
  assert.equal(collected(f).ok, false);
  for (const url of ['file:///tmp/a', 'https://u:p@example.invalid/', 'https://example.invalid/?token=hidden']) {
    assert.throws(() => scaffold({ out: path.join(f.root, 'other'), key: 'valid-key', name: '应用', url }));
    assert.equal(fs.existsSync(path.join(f.root, 'other')), false);
  }
});

test('app entry selects the built-in developer in a new conversation while retaining the plugin entry', () => {
  const calls = [], context = { window: { WorkspaceHost: { open: (route, payload) => calls.push({ route, payload }) } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components/panels/panels-plugin-builder-entry.js'), 'utf8'), context);
  context.window.PluginBuilderEntry.openApp('开发便签');
  context.window.PluginBuilderEntry.open('周报');
  assert.equal(calls[0].route, 'create');
  assert.equal(calls[0].payload.pluginId, 'local:app-developer');
  assert.equal(calls[0].payload.prefill, '开发即用：开发便签');
  assert.equal(calls[0].payload.newSession, true);
  assert.equal(calls[0].payload.autoSend, undefined);
  assert.equal(calls[1].payload.pluginId, 'local:plugin-builder');
  const build = require('../package.json').build;
  assert.ok(build.files.includes('sdk/**/*'));
  assert.ok(build.files.includes('app-window-chrome.html'));
  assert.ok(build.extraResources.some(x => x.from === '../skills'));
});


test('authoring validator compiles packaged scripts and modules without executing either', t => {
  const f = fixture(t); scaffold({out:f.out,key:'syntax-demo',name:'语法检查'});
  const draft = path.join(f.out,drafts.DRAFT_NAME), body = JSON.parse(fs.readFileSync(draft,'utf8'));
  body.icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=';
  const validator = require('../../skills/app-developer/scripts/validate.cjs');
  const write=()=>fs.writeFileSync(draft,JSON.stringify(body)); write();
  const file=path.join(f.out,'ui/app.js');
  fs.writeFileSync(file,'const pendingCopy = 1; const pendingCopy = 2;');
  assert.throws(()=>validator.validate(draft,f.root),/语法检查失败：ui\/app\.js/);
  fs.writeFileSync(file,'throw Error("must not execute app code");');
  fs.writeFileSync(path.join(f.out,'ui/module.mjs'),'export const value=1; throw Error("must not execute module code");');
  body.resources.push({path:'ui/module.mjs',kind:'ui'}); write();
  const result=validator.validate(draft,f.root);
  assert.equal(result.syntaxChecked,3); assert.equal(result.runtimeTested,false);
  fs.writeFileSync(path.join(f.out,'ui/module.mjs'),'export const value = ;');
  assert.throws(()=>validator.validate(draft,f.root),/语法检查失败：ui\/module\.mjs/);
});

test('Chinese 即用 and English App intentionally share a product concept across loaded catalogs', () => {
  const context=vm.createContext({});
  for(const file of ['en-US.js','en-US-gap-pages.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../core/locales',file),'utf8'),context);
  }
  const catalogs=context.SoduWorkLocaleMessages;
  assert.equal(catalogs['en-US']['即用'],'App');
  assert.equal(catalogs['en-US']['创建即用'],'Create app');
  assert.equal(catalogs['en-US']['打开即用'],'Open app');
  assert.equal(catalogs['en-US']['搜索即用'],'Search apps');
  assert.match(catalogs['en-US']['首屏发现脚本、资源或SDK运行错误：{value1}'],/error detected/);
  assert.match(catalogs['en-US']['原生启动检查失败：{value1}'],/failed/);
  for(const [key,value] of Object.entries(catalogs['en-US'])) if(key.includes('即用')) assert.doesNotMatch(value,/Instant/);
});

test('new authored data declarations require explicit storage while legacy package import stays local-compatible',t=>{
  const f=fixture(t);scaffold({out:f.out,key:'storage-contract',name:'数据声明',storage:'cloud'});
  const file=path.join(f.out,drafts.DRAFT_NAME),body=JSON.parse(fs.readFileSync(file,'utf8'));
  body.icon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=';
  const validator=require('../../skills/app-developer/scripts/validate.cjs');
  const write=()=>fs.writeFileSync(file,JSON.stringify(body));write();
  assert.equal(validator.validate(file,f.out).storageLocation,'cloud');
  delete body.jiyong.storage;write();
  assert.throws(()=>validator.validate(file,f.out),/必须显式声明 jiyong.storage.location/);
  assert.equal(personal.preflight(collected(f).body).ok,true,'runtime import preserves existing standalone packages');
  body.jiyong.storage={location:'local'};write();
  assert.equal(validator.validate(file,f.out).storageLocation,'local');
});
