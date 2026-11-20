// Real plugin authorization and Electron installation UI with deterministic file generation.
// No real model, external authorization or production account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { CdpPage, waitForPage, delay } from './lib/cdp.mjs';
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = process.argv[2];
assert(evidence && path.isAbsolute(evidence), 'An absolute evidence directory is required');

const require = createRequire(path.join(client, 'package.json'));
const gate = require('./main/pi-session/plugin-generation-gate.cjs');
const pluginTurn = require('./main/pi-session/plugin-turn');
const pluginContext = require('./main/pi-session/plugin-context');
const outputs = require('./main/pi-session/outputs');
const personal = require('./main/personal-plugins');
const cache = require('./main/app-resource-cache.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-authoring-intent-'));
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
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
const child = spawn(require('electron'),
  [path.join(client, 'e2e/fixtures/plugin-authoring-window.cjs'), profile, controlFile, '--remote-debugging-port=' + port],
  { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
let processLog = '', page;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { processLog = (processLog + data).slice(-12000); });
const checks = [];
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
  assert.equal(await page.run(() => document.querySelectorAll('[data-install-plugin-draft]').length), 0);
  const app = { getPath: () => profile }, cwd = control.cwd;
  const prompt = '我给你区域范围，时间，几人，年龄，喜欢的旅行种类，或者是随机你来推荐。要输出一个有预算、路线、精华景点的旅行计划。呈现出的 html 效果需要精美精致，要有旅行地照片。';
  const options = { readOnly: false, capabilityIds: [], resolvePlugins: ids => personal.resolve(app, ids) };
  const prepared = await pluginTurn.prepare(options, { pluginIds: ['local:plugin-builder'] });
  assert.equal(prepared.ok, true, prepared.reason);
  const augmented = prepared.augment(prompt), start = '<soduwork-conversation-plugins>', end = '</soduwork-conversation-plugins>';
  const contract = JSON.parse(augmented.slice(augmented.indexOf(start) + start.length, augmented.lastIndexOf(end)));
  assert.equal(contract.authoring.intent, 'plugin-authoring');
  assert.match(contract.authoring.instructions, /specification/);
  assert.match(contract.authoring.instructions, /future invocation inputs/);
  assert.match(contract.authoring.instructions, /Check and install/);
  assert.equal(pluginContext.parse(augmented).text, prompt);
  assert.equal(pluginContext.parse(augmented).plugins[0].pluginId, 'local:plugin-builder');
  prepared.cleanup();
  checks.push('The selected authorized builder treats an unprefixed travel description as reusable plugin requirements, while visible history retains the original message');
  const ordinary = await pluginTurn.prepare(options, { pluginIds: [] });
  assert.equal(ordinary.augment(prompt), prompt); ordinary.cleanup();
  const skill = await pluginTurn.prepare(options, { pluginIds: ['local:skill-studio'] });
  assert.equal(skill.ok, true, skill.reason); assert.doesNotMatch(skill.augment(prompt), /"authoring":/); skill.cleanup();
  const denied = await pluginTurn.prepare({ ...options, resolvePlugins: () => { throw Error('Fixture access denied'); } }, { pluginIds: ['local:plugin-builder'] });
  assert.equal(denied.ok, false);
  checks.push('Ordinary chat and Skill Studio do not inherit plugin authoring, and failed authorization stops submission');
  await page.run(text => { document.querySelector('.nmsg p').textContent = text; }, prompt);
  const handle = { cwd, sessionId: 'authoring', inFlight: () => true,
    outputSnapshot: () => outputs.scan(cwd, 0, 0) };
  let repairs = 0;
  const turn = await gate.begin({ handle, app, selectedPluginIds: ['local:plugin-builder'], repair: async () => { repairs++; return { ok: false }; } });
  // Deterministic generation verifies transport and install UI, not model reasoning.
  fs.mkdirSync(path.join(cwd, 'templates'));
  fs.writeFileSync(path.join(cwd, 'templates/itinerary.html'), '<!doctype html><meta charset="utf-8"><title>Travel plan template</title><h1>Travel plan</h1>');
  fs.writeFileSync(path.join(cwd, 'soduwork-plugin-draft.json'), JSON.stringify({
    template: 'method', key: 'travel-plan', name: 'Travel planner', version: '1.0.0', description: 'Build a reusable itinerary from invocation preferences.',
    instructions: 'Ask for destination, dates, travelers and budget when invoked. Research destinations and render the itinerary template.',
    inputs: [{ key: 'destination', label: 'Destination', type: 'text' }, { key: 'dates', label: 'Travel dates', type: 'text' },
      { key: 'travelers', label: 'Travelers', type: 'number' }, { key: 'budget', label: 'Budget', type: 'number' }],
    setup: { preferences: [] }, resources: [{ path: 'templates/itinerary.html', kind: 'template' }],
  }));
  fs.mkdirSync(path.join(cwd, '.soduwork'));
  fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), JSON.stringify({ schemaVersion: 1,
    deliverables: [{ path: 'soduwork-plugin-draft.json', primary: true }] }));
  assert.equal((await turn.finish({ ok: true })).ok, true); assert.equal(repairs, 0);
  let rendered = await page.run(() => window.conversationRenderCount);
  await click('#reopen');
  await page.waitFor(previous => window.conversationRenderCount > previous, rendered);
  assert.equal(await page.run(() => document.querySelectorAll('[data-install-plugin-draft]').length), 1);
  assert.equal(personal.catalog(app).filter(row => !row.builtIn).length, 0);
  await shot('generated-install-card');
  await click('[data-install-plugin-draft]'); await page.waitFor(() => document.querySelector('#capLocalOnly'), null);
  assert.match(await page.run(() => document.querySelector('#capLocalOnly').closest('[role="dialog"]')?.textContent || document.body.textContent), /Travel planner/);
  assert.equal(personal.catalog(app).filter(row => !row.builtIn).length, 0);
  await shot('installation-confirmation');
  await click('#capModalClose');
  assert.equal(personal.catalog(app).filter(row => !row.builtIn).length, 0);
  checks.push('The generated draft produces Check and install; opening and cancelling the confirmation does not install anything');
  await click('[data-install-plugin-draft]'); await page.waitFor(() => document.querySelector('#capLocalOnly'), null);
  await click('#capLocalOnly'); await page.waitFor(() => document.querySelector('#capLocalTry'), null);
  const installed = personal.catalog(app).filter(row => !row.builtIn);
  assert.equal(installed.length, 1); assert.equal(installed[0].key, 'travel-plan');
  assert.equal(personal.exportDraft(app, installed[0].pluginId).inputs.length, 4);
  await shot('confirmed-installation');
  checks.push('Only the explicit install button saves the reusable plugin with future invocation inputs');
  assert.deepEqual(page.takeRuntimeErrors(), []);
  const report = { ok: true, checks, platform: process.platform, scope: 'Real Electron, production plugin authorization/context, output scan, generation gate, preload and install IPC. Plugin file writes are deterministic fixtures; no real model.' };
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await shot('failure').catch(() => {});
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ ok: false, error: String(error.stack || error), processLog, checks }));
  throw error;
} finally {
  page?.close(); cache.close();
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else child.kill();
  }
  await delay(400);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
