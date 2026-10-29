// Real Electron renderer -> production preload -> production IPC -> disk.
// Only native picker selection and external platform replies are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CdpPage, waitForPage, delay } from './lib/cdp.mjs';
const require = createRequire(import.meta.url);
const personal = require('../main/personal-plugins');
const drafts = require('../main/pi-session/plugin-draft');
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-authoring-ui-'));
const evidence = path.resolve(process.argv[2] || path.join(client, '../outputs/plugin-authoring'));
fs.mkdirSync(evidence, { recursive: true });
const profile = path.join(root, 'profile'), app = { getPath: () => profile };
const cwd = path.join(root, 'work');
fs.mkdirSync(path.join(cwd, 'templates'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'templates/report.md'), '# Weekly report');
const body = { template: 'connector', key: 'team-brief', name: '团队简报助手', version: '1.0.0',
  description: '汇总企业微信与钉钉的资料，使用模板生成简报。', instructions: '读取已授权资料，按模板生成简报。',
  platforms: ['wecom', 'dingtalk'], resources: [{ path: 'templates/report.md', kind: 'template' }],
  setup: { title: '简报偏好', preferences: [{ key: 'department', label: '部门', type: 'text', required: true },
    { key: 'compact', label: '精简内容', type: 'boolean', default: false }] } };
// Older generated drafts put fields directly in setup; exercise the real import boundary.
body.setup = body.setup.preferences;
fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), '\uFEFF' + JSON.stringify(body));
const importRoot = path.join(root, 'imports');
fs.mkdirSync(path.join(importRoot, 'templates'), { recursive: true });
fs.writeFileSync(path.join(importRoot, 'templates/report.md'), '# Local report');
const importBody = { template: 'method', key: 'local-json', name: '本机资料整理', version: '1.0.0',
  description: '读取模板整理资料', instructions: '复制随附模板并整理用户资料。', resources: body.resources };
const jsonPath = path.join(importRoot, 'local-draft.json');
fs.writeFileSync(jsonPath, '\uFEFF' + JSON.stringify(importBody));
const archiveBody = { ...importBody, key: 'local-archive', name: '归档报告助手',
  resources: [{ ...body.resources[0], encoding: 'utf8', content: '# Packaged report' }] };
const sourceApp = { getPath: () => path.join(root, 'export-source') };
const originalArchive = personal.create(sourceApp, archiveBody).plugin;
const archivePath = path.join(importRoot, 'local-archive.soduwork-plugin');
await personal.exportToFile(sourceApp, { showSaveDialog: async () => ({ canceled: false, filePath: archivePath }) }, originalArchive.pluginId);
const controlFile = path.join(root, 'control.json');
let control = { cwd, startedAt: Date.now() - 2000, history: false, selectedPackage: jsonPath };
function updateControl(patch) { control = { ...control, ...patch }; fs.writeFileSync(controlFile, JSON.stringify(control)); }
updateControl({});
const events = () => JSON.parse(fs.readFileSync(path.join(root, 'ipc-events.json'), 'utf8'));
const installs = () => events().filter(event => event.channel === 'personal-plugin-create').length;
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(client, 'node_modules/electron/dist/electron.exe'),
  [path.join(client, 'e2e/fixtures/plugin-authoring-window.cjs'), profile, controlFile, '--remote-debugging-port=' + port],
  { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
let processLog = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { processLog = (processLog + data).slice(-12000); });
let page;
const checks = [];
async function click(selector) {
  await page.waitFor(s => { const node = document.querySelector(s);
    return Boolean(node && !node.disabled && node.getClientRects().length); }, selector);
  const point = await page.run(s => {
    const node = document.querySelector(s); node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  for (const type of ['mousePressed', 'mouseReleased']) await page.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function shot(name) {
  const image = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function assertFits(selector) {
  const rect = await page.run(s => { const r = document.querySelector(s).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; }, selector);
  assert.ok(rect.left >= -1 && rect.right <= rect.width + 1 && rect.top >= -1 && rect.bottom <= rect.height + 1, JSON.stringify(rect));
}
try {
  for (let index = 0; index < 50; index++) {
    try { page = await CdpPage.connect(await waitForPage(port, row => row.url.endsWith('/plugin-authoring.html'), 1000)); break; }
    catch { await delay(150); }
  }
  assert.ok(page, 'isolated Electron starts: ' + processLog);
  await page.call('Page.enable');
  await page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitFor(() => Boolean(document.querySelector('[data-install-plugin-draft]')), null);
  const discovered = await page.run(() => visibleArtifacts.find(item => item.pluginDraft));
  assert.match(discovered.artifactId, /^art_/);
  assert.equal(discovered.pluginName, body.name);
  assert.equal(discovered.changedInTurn, true);
  assert.equal(fs.existsSync(path.join(cwd, '.soduwork/delivery.json')), false);
  assert.equal(await page.run(() => document.querySelector('.nmsg p').textContent.includes('json')), false);
  const placement = await page.run(() => {
    const draft = visibleArtifacts.find(item => item.pluginDraft), at = Number(draft.at);
    const snapshot = { status: 'idle', messages: [
      { role: 'user', sentAt: at - 1000 }, { role: 'assistant', completedAt: at - 200 },
      { role: 'assistant', completedAt: at + 100 }, { role: 'user', sentAt: at + 200 },
      { role: 'assistant', completedAt: at + 400 },
    ] };
    const transcript = `<div class="nmsg user" data-chat-node="message:0">制作一个插件</div>
      <div class="nmsg ai" data-chat-node="message:1" data-delivery-final="false"><p>正在生成 ${draft.name}。</p></div>
      <div class="nmsg ai" data-chat-node="message:2" data-delivery-final="true" data-delivery-current="false"><p>插件与配套资源已准备好，请检查并安装。</p></div>
      <div class="nmsg user" data-chat-node="message:3">下一轮无关问题</div>
      <div class="nmsg ai" data-chat-node="message:4" data-delivery-final="true"><p>这轮没有制作或修改插件。</p></div>`;
    const chat = document.querySelector('#chat');
    chat.innerHTML = ChatOutputLinks.decorate(transcript, visibleArtifacts, 'authoring', snapshot);
    const first = chat.querySelector('.nplugin-draft').parentElement.dataset.chatNode;
    chat.innerHTML = ChatOutputLinks.decorate(transcript, visibleArtifacts, 'authoring', snapshot, chat);
    const afterRerender = chat.querySelector('.nplugin-draft').parentElement.dataset.chatNode;
    delete snapshot.messages[0].sentAt;
    chat.innerHTML = ChatOutputLinks.decorate(transcript, visibleArtifacts, 'authoring', snapshot, chat);
    const undatedFirst = chat.querySelector('.nplugin-draft').parentElement.dataset.chatNode;
    snapshot.messages[0].sentAt = at - 1000;
    snapshot.messages[2].completedAt = at - 100;
    delete snapshot.messages[3].sentAt;
    chat.innerHTML = ChatOutputLinks.decorate(transcript, visibleArtifacts, 'authoring', snapshot, chat);
    const undatedLater = chat.querySelector('.nplugin-draft').parentElement.dataset.chatNode;
    snapshot.messages[2].completedAt = at + 100;
    snapshot.messages[3].sentAt = at + 200;
    chat.innerHTML = ChatOutputLinks.decorate(transcript, visibleArtifacts, 'authoring', snapshot, chat);
    return { first, afterRerender, undatedFirst, undatedLater,
      count: chat.querySelectorAll('.nplugin-draft').length,
      intermediate: chat.querySelector('[data-chat-node="message:1"] .nplugin-draft') !== null };
  });
  assert.deepEqual(placement, { first: 'message:2', afterRerender: 'message:2',
    undatedFirst: 'message:2', undatedLater: 'message:4', count: 1, intermediate: false });
  await page.run(() => document.querySelector('.nplugin-draft').scrollIntoView({ block: 'center' }));
  await assertFits('.nplugin-draft');
  checks.push('draft install action stays beside producing turn final reply, handles mixed missing user times, survives rerender once, and ignores later unrelated replies');
  await shot('01-conversation-install-entry');
  await click('[data-chat-node="message:2"] [data-install-plugin-draft]');
  await page.waitFor(() => document.querySelector('#capLocalInstall'), null);
  assert.equal(personal.catalog(app).filter(item => !item.builtIn).length, 0);
  assert.equal(await page.run(() => document.querySelector('.cap-resource-pack').open), false);
  await assertFits('.cap-local-install-modal');
  await shot('02-install-preview');
  const initialAccent = await page.run(() => getComputedStyle(document.querySelector('#capLocalInstall')).backgroundColor);
  await page.run(() => { document.documentElement.dataset.theme = 'ruby'; });
  await page.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 680, deviceScaleFactor: 1, mobile: false });
  await assertFits('.cap-local-install-modal');
  await assertFits('#capLocalOnly'); await assertFits('#capLocalInstall');
  await page.waitFor(previous => getComputedStyle(document.querySelector('#capLocalInstall')).backgroundColor !== previous, initialAccent);
  assert.notEqual(await page.run(() => getComputedStyle(document.querySelector('#capLocalInstall')).backgroundColor), initialAccent);
  await shot('02b-enterprise-theme-360px');
  await page.run(() => { delete document.documentElement.dataset.theme; });
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 940, deviceScaleFactor: 1, mobile: false });
  await click('#capLocalCancel');
  checks.push('production filesystem index and IPC expose install action without delivery manifest or filename in response');

  fs.mkdirSync(path.join(cwd, '.soduwork'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), JSON.stringify({ schemaVersion: 1,
    deliverables: [{ path: drafts.DRAFT_NAME, kind: 'file' }] }));
  updateControl({ since: Date.now(), history: false });
  await click('#reopen');
  await page.waitFor(() => visibleArtifacts.length === 0, null);
  assert.equal(await page.run(() => document.querySelectorAll('[data-install-plugin-draft]').length), 0);
  checks.push('fresh conversation scope sharing the author workspace ignores old draft and old delivery manifest');
  updateControl({ since: 0, history: true, pluginSince: Date.now() });
  const beforeHistoryRender = await page.run(() => window.conversationRenderCount);
  await click('#reopen');
  await page.waitFor(previous => window.conversationRenderCount > previous, beforeHistoryRender);
  assert.equal(await page.run(() => visibleArtifacts.some(item => item.pluginDraft)), false);
  assert.equal(await page.run(() => document.querySelectorAll('[data-install-plugin-draft]').length), 0);
  checks.push('reopened trial history still excludes author draft through its persisted plugin time boundary');
  updateControl({ since: 0, history: true, pluginSince: control.startedAt });
  await click('#reopen');
  await page.waitFor(() => visibleArtifacts.some(item => item.pluginDraft && !item.changedInTurn), null);
  assert.equal(await page.run(() => document.querySelectorAll('[data-install-plugin-draft]').length), 1);
  assert.equal(await page.run(() => visibleArtifacts.find(item => item.pluginDraft).artifactId), discovered.artifactId);
  await click('[data-install-plugin-draft]');
  await page.waitFor(() => document.querySelector('#capLocalOnly'), null);
  await page.run(() => { window.failCatalog = true; });
  await click('#capLocalOnly');
  await page.waitFor(() => document.querySelector('#capLocalTry'), null);
  assert.equal(installs(), 1);
  assert.equal(personal.catalog(app).find(item => item.key === body.key).setupState, 'needs_setup');
  assert.equal(await page.run(() => window.trial || null), null);
  assert.equal(fs.existsSync(path.join(profile, 'personal-plugins.json')), true);
  await shot('03-installed-locally');
  checks.push('history reopen retains one install entry; install-only persists despite catalog refresh failure and does not start trial');

  await click('#capLocalTry');
  await page.waitFor(() => document.querySelector('[data-setup-key="department"]'), null);
  await click('#capSetupSave');
  await page.waitFor(() => document.querySelector('[data-field="department"] .cap-setup-error').textContent.includes('填写'), null);
  await page.call('Emulation.setDeviceMetricsOverride', { width: 520, height: 820, deviceScaleFactor: 1, mobile: false });
  await assertFits('.cap-modal');
  await shot('04-required-preferences-narrow');
  await click('[data-setup-key="department"]');
  await page.call('Input.insertText', { text: '运营团队' });
  await click('#capSetupSave');
  await page.waitFor(() => document.querySelector('#capPlatformStart'), null);
  assert.equal(personal.catalog(app).find(item => item.key === body.key).setupConfig.department, '运营团队');
  await shot('05-first-platform');
  await click('#capPlatformStart');
  await page.waitFor(() => !document.querySelector('#capPlatformContinue').hidden, null);
  assert.equal(await page.run(() => window.trial || null), null);
  await click('#capPlatformContinue');
  await page.waitFor(() => document.querySelector('#capModalTitle').textContent.includes('钉钉'), null);
  await click('#capPlatformStart');
  await page.waitFor(() => !document.querySelector('#capPlatformContinue').hidden, null);
  await click('#capPlatformContinue');
  await page.waitFor(() => window.trial, null);
  const trial = await page.run(() => window.trial);
  assert.deepEqual(events().filter(event => event.channel === 'platform-connect').map(event => event.key), ['wecom', 'dingtalk']);
  const installed = personal.get(app, trial.payload.pluginId);
  assert.equal(trial.type, 'create'); assert.equal(trial.payload.newSession, true);
  assert.match(personal.resolve(app, [installed.pluginId], { cwd }).items[0].context, /运营团队/);
  assert.doesNotMatch(JSON.stringify(personal.exportDraft(app, installed.pluginId)), /运营团队/);
  assert.equal(installs(), 1);
  checks.push('real required preferences persist; both platform confirmations precede new trial; private settings stay out of export');

  await page.call('Page.reload');
  await page.waitFor(() => document.querySelector('[data-install-plugin-draft]'), null);
  await click('[data-install-plugin-draft]');
  await page.waitFor(() => document.querySelector('#capLocalCancel'), null);
  await click('#capLocalCancel');
  await click('#use-installed');
  // A new renderer refreshes account status before remembering platform-ready
  // state. Continue existing connections, without issuing another login.
  for (const label of ['企业微信', '钉钉']) {
    await page.waitFor(expected => document.querySelector('#capModalTitle')?.textContent.includes(expected) &&
      document.querySelector('#capPlatformContinue') && !document.querySelector('#capPlatformContinue').hidden, label);
    await click('#capPlatformContinue');
  }
  await page.waitFor(() => window.trial, null);
  assert.equal((await page.run(() => window.trial)).payload.pluginId, installed.pluginId);
  assert.equal(installs(), 1);
  assert.equal(events().filter(event => event.channel === 'platform-connect').length, 2);
  checks.push('after renderer reload, saved plugin and preferences start another trial without reinstalling');

  await page.run(() => { window.trial = null; });
  updateControl({ selectedPackage: jsonPath });
  await click('#import');
  await page.waitFor(() => document.querySelector('#capLocalOnly'), null);
  assert.equal(await page.run(() => document.querySelector('.cap-plugin-preview b').textContent), importBody.name);
  await assertFits('.cap-local-install-modal');
  await shot('06-json-import-narrow');
  await click('#capLocalOnly');
  await page.waitFor(() => document.querySelector('#capLocalTry'), null);
  const jsonInstalled = personal.catalog(app).find(item => item.key === importBody.key);
  assert.ok(jsonInstalled);
  assert.equal(Buffer.from(personal.exportDraft(app, jsonInstalled.pluginId).resources[0].content, 'base64').toString(), '# Local report');
  await click('#capLocalTry');
  await page.waitFor(() => window.trial, null);
  assert.equal((await page.run(() => window.trial)).payload.pluginId, jsonInstalled.pluginId);
  checks.push('local UTF-8 BOM JSON import uses production picker, collects adjacent resource bytes, installs and starts trial');

  await page.run(() => { window.trial = null; });
  updateControl({ selectedPackage: archivePath });
  await click('#import');
  await page.waitFor(() => document.querySelector('#capLocalInstall'), null);
  assert.equal(await page.run(() => document.querySelector('.cap-plugin-preview b').textContent), archiveBody.name);
  assert.equal(await page.run(() => Boolean(document.querySelector('#capUploadSubmit'))), false);
  await shot('07-archive-import-narrow');
  await click('#capLocalInstall');
  await page.waitFor(() => window.trial, null);
  const archived = personal.catalog(app).find(item => item.key === archiveBody.key);
  assert.equal(archived.checksum, originalArchive.checksum);
  assert.equal((await page.run(() => window.trial)).payload.pluginId, archived.pluginId);
  assert.equal(installs(), 3);
  checks.push('real exported .soduwork-plugin archive uses the same local installation dialog and preserves checksum/resources without Hub upload');

  updateControl({ selectedPackage: jsonPath });
  fs.writeFileSync(jsonPath, JSON.stringify({ ...importBody, instructions: '内容有变化，但故意保留相同版本以验证真实安装冲突。' }));
  await click('#import');
  await page.waitFor(() => document.querySelector('#capLocalOnly'), null);
  await click('#capLocalOnly');
  await page.waitFor(() => document.querySelector('#capLocalError') && !document.querySelector('#capLocalError').hidden, null);
  assert.match(await page.run(() => document.querySelector('#capLocalError').textContent), /提升版本/);
  assert.equal(await page.run(() => document.querySelector('#capLocalOnly').disabled), false);
  assert.equal(personal.get(app, jsonInstalled.pluginId).checksum, jsonInstalled.checksum);
  await shot('08-version-conflict-actionable');
  await click('#capLocalCancel');
  checks.push('real version conflict remains inline with controls restored and existing installed version unchanged');

  // Reproduce a rejected generated file, then repair it on disk and retry the
  // same conversation button. An optional real user draft is copied into this
  // isolated workspace only; it is never edited or installed in their profile.
  const retryBody = process.env.SODUWORK_E2E_PLUGIN_DRAFT
    ? JSON.parse(fs.readFileSync(process.env.SODUWORK_E2E_PLUGIN_DRAFT, 'utf8').replace(/^\uFEFF/, ''))
    : { ...archiveBody, key: 'retry-preferences', name: '运行方案偏好验收',
      setup: { preferences: [{ key: 'language', label: '语言', type: 'select', options: ['中文', '英文'], default: '中文' }] } };
  const beforeRetryInstalls = installs();
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify({ ...retryBody, setup: '请填写使用偏好' }));
  updateControl({ since: 0, history: true, pluginSince: control.startedAt });
  await click('#reopen');
  await page.waitFor(name => visibleArtifacts.some(item => item.pluginName === name), retryBody.name);
  await click('[data-install-plugin-draft]');
  await page.waitFor(() => !document.querySelector('.nplugin-draft-error')?.hidden, null);
  const errorMessage = await page.run(() => document.querySelector('.nplugin-draft-error').textContent);
  assert.match(errorMessage, /setup/);
  assert.doesNotMatch(errorMessage, /Error invoking remote method|personal-plugin-preflight/);
  assert.equal(await page.run(() => document.querySelector('[data-install-plugin-draft]').disabled), false);
  assert.equal(installs(), beforeRetryInstalls);
  await shot('09-draft-error-with-retry');
  fs.writeFileSync(path.join(cwd, drafts.DRAFT_NAME), JSON.stringify(retryBody));
  await click('[data-install-plugin-draft]');
  await page.waitFor(() => document.querySelector('#capLocalOnly'), null);
  assert.equal(await page.run(() => document.querySelector('.nplugin-draft-error').hidden), true);
  assert.equal(await page.run(() => document.querySelector('.cap-plugin-preview b').textContent), retryBody.name);
  await shot('10-corrected-draft-install-preview');
  await click('#capLocalOnly');
  await page.waitFor(() => document.querySelector('#capLocalTry'), null);
  const retried = personal.catalog(app).find(item => item.key === retryBody.key);
  assert.ok(retried);
  const canonicalSetup = personal.preflight(retryBody).manifest.setup;
  assert.deepEqual(personal.get(app, retried.pluginId).setup, canonicalSetup);
  assert.equal(personal.get(app, retried.pluginId).localDraft.resources.length, retryBody.resources.length);
  await page.run(() => { window.trial = null; });
  await click('#capLocalTry');
  await page.waitFor(() => document.querySelector('#capSetupSave'), null);
  assert.equal(await page.run(() => document.querySelectorAll('[data-setup-key]').length), canonicalSetup.preferences.length);
  await shot('11-preserved-install-preferences');
  await click('#capSetupSave');
  await page.waitFor(() => window.trial, null);
  const configured = personal.get(app, retried.pluginId);
  assert.equal(configured.setupConfigured, true);
  for (const field of canonicalSetup.preferences) {
    if ('default' in field) assert.deepEqual(configured.setupConfig[field.key], field.default);
  }
  assert.equal((await page.run(() => window.trial)).payload.pluginId, retried.pluginId);
  assert.equal(installs(), beforeRetryInstalls + 1);
  checks.push('real IPC validation rejection is readable, button recovers, retry reads corrected file, installation preserves resources/preferences and starts trial');

  assert.deepEqual(page.takeRuntimeErrors(), []);
  const report = { ok: true, checks, installAttempts: installs(), installedPlugins: personal.catalog(app).filter(item => !item.builtIn).length, realDraft: Boolean(process.env.SODUWORK_E2E_PLUGIN_DRAFT),
    scope: 'Isolated Electron; production preload/draft/install IPC and filesystem. Native picker selection and external account replies are controlled fixtures. No model or business request.' };
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence }));
} catch (error) {
  if (page) { await shot('failure').catch(() => {});
    console.error(JSON.stringify({ error: String(error), runtime: page.takeRuntimeErrors(),
      text: await page.run(() => document.body.innerText).catch(() => ''), checks, processLog }));
  } else console.error(processLog);
  throw error;
} finally {
  if (page) page.close();
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  else child.kill();
  await delay(400);
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unexpected fixture cleanup path');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
