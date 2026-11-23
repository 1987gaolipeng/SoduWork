// Real Electron entry/output/install UI with controlled model file writes.
// Optional source root permits the exact same scenario against an older build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { CdpPage, waitForPage, delay } from './lib/cdp.mjs';
const client = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const evidence = path.resolve(process.argv[2] || path.join(client, '../outputs/plugin-authoring-completion'));
const expectMissing = process.argv.includes('--expect-missing');
const require = createRequire(path.join(client, 'package.json'));
const gate = require('./main/pi-session/plugin-generation-gate.cjs');
const outputs = require('./main/pi-session/outputs');
const personal = require('./main/personal-plugins');
const cache = require('./main/app-resource-cache.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-authoring-completion-'));
const profile = path.join(root, 'profile'), controlFile = path.join(root, 'control.json');
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(path.join(root, 'initial'));
let control = { cwd: path.join(root, 'initial'), startedAt: Date.now() - 1000 };
const setControl = patch => fs.writeFileSync(controlFile, JSON.stringify(control = { ...control, ...patch }));
setControl({});
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(client, 'node_modules/electron/dist/electron.exe'),
  [path.join(client, 'e2e/fixtures/plugin-authoring-window.cjs'), profile, controlFile, '--remote-debugging-port=' + port],
  { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
let processLog = '', page;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { processLog = (processLog + data).slice(-12000); });
const checks = [], cases = [];
async function click(selector) {
  await page.waitFor(s => document.querySelector(s)?.getClientRects().length, selector);
  const point = await page.run(s => {
    const node = document.querySelector(s); node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  for (const type of ['mousePressed', 'mouseReleased']) await page.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function shot(name) {
  fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { page = await CdpPage.connect(await waitForPage(port, row => row.url.endsWith('/plugin-authoring.html'), 1000)); break; }
    catch (error) { if (attempt === 29) throw error; await delay(150); }
  }
  await page.call('Runtime.enable');
  await page.waitFor(() => window.conversationRenderCount > 0, null);
  await page.call('Runtime.evaluate', { expression: fs.readFileSync(path.join(client, 'components/panels/panels-plugin-builder-entry.js'), 'utf8') });
  const payload = await page.run(() => {
    PluginBuilderEntry.open('做一个小说灵感采集器。如果没有主题，采集本周灵感，最终给我输出清晰简明的HTML。');
    return window.trial.payload;
  });
  assert.equal(payload.pluginId, 'local:plugin-builder');
  assert.match(payload.prefill, /^制作插件：/);
  checks.push('production Plugin Developer entry selects the builtin authoring plugin and retains the business HTML request');
  let installedCount = 0;
  for (const source of ['inferred', 'manifest']) {
    const cwd = path.join(root, source); fs.mkdirSync(cwd);
    const app = { getPath: () => profile };
    const handle = { cwd, sessionId: source, deliveryOwner: { account: 'synthetic' }, inFlight: () => true,
      outputSnapshot: () => outputs.scan(cwd, 0, 0) };
    let repairs = 0;
    const turn = await gate.begin({ handle, app, selectedPluginIds: [payload.pluginId], repair: async prompt => {
      repairs++; assert.match(prompt, /draft|plugin/i);
      fs.mkdirSync(path.join(cwd, 'templates'), { recursive: true });
      fs.copyFileSync(path.join(cwd, 'report.html'), path.join(cwd, 'templates/report.html'));
      fs.writeFileSync(path.join(cwd, 'soduwork-plugin-draft.json'), JSON.stringify({
        template: 'method', key: 'novel-inspiration-' + source, name: 'Novel inspiration collector', version: '1.0.0',
        description: 'Collect ideas and produce a concise HTML report', instructions: 'Ask for a topic, collect ideas and produce an HTML report.',
        resources: [{ path: 'templates/report.html', kind: 'template' }],
      }));
      fs.mkdirSync(path.join(cwd, '.soduwork'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), JSON.stringify({ schemaVersion: 1,
        deliverables: [{ path: 'soduwork-plugin-draft.json', primary: true }] }));
      return { ok: true };
    } });
    // Simulate the screenshot's mistaken one-off business execution, not a plugin draft.
    fs.writeFileSync(path.join(cwd, 'report.html'), '<!doctype html><html><title>Weekly ideas</title><h1>Weekly novel inspiration</h1></html>');
    if (source === 'manifest') {
      fs.mkdirSync(path.join(cwd, '.soduwork'));
      fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), JSON.stringify({ schemaVersion: 1,
        deliverables: [{ path: 'report.html', primary: true }] }));
    }
    const before = handle.outputSnapshot();
    assert.equal(before.delivery.source, source);
    assert.equal(before.files.some(file => file.name === 'soduwork-plugin-draft.json'), false);
    const previewBytes = fs.readFileSync(path.join(cwd, 'report.html'));
    setControl({ cwd, since: 0, startedAt: Date.now() - 2000, history: false, inFlight: true });
    let rendered = await page.run(() => window.conversationRenderCount);
    await click('#reopen');
    await page.waitFor(previous => window.conversationRenderCount > previous, rendered);
    const preview = await page.run(() => ({
      hasHtml: visibleArtifacts.some(item => item.kind === 'website' && item.name === 'report.html'),
      installCards: document.querySelectorAll('[data-install-plugin-draft]').length,
    }));
    assert.deepEqual(preview, { hasHtml: true, installCards: 0 });
    assert.deepEqual(await gate.inspect({ handle, snapshot: before, app }), []);
    assert.equal(repairs, 0);
    await page.run(() => { document.querySelector('.nmsg p').textContent = 'HTML 预览已保留，插件仍在制作中。'; });
    await shot(source + '-during-authoring');
    checks.push(source + ' HTML remains available during authoring without repair or an install action');
    const result = await turn.finish({ ok: true });
    const expectedRepair = !expectMissing;
    assert.equal(result.ok, true, result.reason);
    assert.equal(repairs, expectedRepair ? 1 : 0);
    assert.deepEqual(fs.readFileSync(path.join(cwd, 'report.html')), previewBytes);
    setControl({ inFlight: false });
    rendered = await page.run(() => window.conversationRenderCount);
    await click('#reopen');
    await page.waitFor(previous => window.conversationRenderCount > previous, rendered);
    const actual = await page.run(() => ({
      installCards: document.querySelectorAll('[data-install-plugin-draft]').length,
      artifacts: visibleArtifacts.map(item => ({ name: item.name, kind: item.kind, pluginDraft: Boolean(item.pluginDraft) })),
    }));
    assert.equal(actual.installCards, expectedRepair ? 1 : 0);
    await shot(source + '-completion');
    if (expectedRepair) {
      await click('[data-install-plugin-draft]');
      await page.waitFor(() => document.querySelector('#capLocalOnly'), null);
      assert.equal(personal.catalog(app).filter(item => !item.builtIn).length, installedCount);
      await shot(source + '-install-preview');
      await click('#capLocalOnly');
      await page.waitFor(() => document.querySelector('#capLocalTry'), null);
      assert.equal(personal.catalog(app).filter(item => !item.builtIn).length, ++installedCount);
      await shot(source + '-installed');
      await click('#capModalClose');
      checks.push(source + ' HTML-only completion repairs once, preserves the preview, and installs the package only after the user click');
    } else checks.push(source + ' HTML-only delivery completes without an install card (baseline regression reproduced)');
    cases.push({ source, selectedPluginId: payload.pluginId, before: { source: before.delivery.source,
      files: before.files.map(file => file.relative) }, preview, previewPreserved: true, result, repairs, ...actual });
  }
  assert.deepEqual(page.takeRuntimeErrors(), []);
  const report = { ok: true, sourceRoot: client, expectMissing, checks, cases, installedCount,
    scope: 'Isolated Windows Electron production authoring entry, output scan, generation gate, preload, draft/install IPC and disk. Model file writes are controlled fixtures; no actual model, external authorization or macOS execution.',
    policy: 'HTML previews are allowed while authoring. A successful authoring completion must provide an installable plugin; both inferred and explicit final HTML outputs are gated.' };
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await shot('failure').catch(() => {});
  fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(error), processLog, checks, cases }));
  throw error;
} finally {
  page?.close(); cache.close();
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else child.kill();
  }
  await delay(400);
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unexpected fixture cleanup path');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
