'use strict';
// Actual desktop coordinator -> authenticated HTTP -> isolated Hub + Runner.
// Vendor model processes are deterministic fixtures; no business DB is used.
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const { create } = require('../main/conversation/cloud-handoff');
const catalog = require('../main/agent-runtime/runtime-catalog');
const repo = path.resolve(__dirname, '../..'), output = path.resolve(process.argv[2] || path.join(repo, 'outputs/cloud-start-20261004'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { ok: false, modelBoundary: 'synthetic-vendor-process', checks: [] };
let root, backend, log, view;
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await pause(100); }
  throw Error('Timed out: ' + label);
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-start-http-'));
  log = sync.openSync(path.join(output, 'hub.log'), 'w');
  backend = spawn(path.join(repo, 'hub-backend/.venv/Scripts/python.exe'), [path.join(repo, 'hub-backend/tests/handoff_http_fixture.py'), root],
    { cwd: path.join(repo, 'hub-backend'), windowsHide: true, stdio: ['ignore', log, log] });
  await until(() => sync.existsSync(path.join(root, 'ready.json')), 'isolated Hub', 45000);
  const identity = JSON.parse(await fs.readFile(path.join(root, 'ready.json'), 'utf8'));
  const app = { getPath: () => path.join(root, 'profile') };
  const api = async route => {
    const response = await fetch(identity.hub + '/api/v1' + route, { headers: { Authorization: 'Device ' + identity.session } });
    assert.ok(response.ok, route + ': ' + await response.clone().text()); return response.json();
  };
  for (const agent of catalog.runtimes()) {
    const cloud = create({ app, identityOf: async () => identity, interval: 100 });
    const input = { requestId: crypto.randomUUID(), agentId: agent.id, text: 'CLOUD_NEW_TEST Create delivery.md in the cloud and verify the result.',
      attachments: [{ name: 'input.txt', data: Buffer.from('cloud start input') }] };
    const first = await cloud.start(input);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.handoff.target.agentId, agent.id);
    const duplicate = await cloud.start(input); assert.equal(duplicate.handoff.taskId, first.handoff.taskId);
    const restarted = create({ app, identityOf: async () => identity, interval: 100 });
    view = await restarted.reopen(first.sessionId, 'view-' + agent.id);
    await until(() => view.snapshot().messages.some(row => row.role === 'assistant'), agent.id + ' cloud output');
    let files;
    await until(async () => { files = await api('/tasks/' + first.handoff.taskId + '/attachments');
      return files.some(row => row.role === 'output' && row.filename === 'delivery.md'); }, agent.id + ' output collected');
    assert.equal(files.some(row => row.role === 'handoff'), false, 'no migrated workspace archive');
    assert.equal(view.snapshot().messages.filter(row => row.role === 'user').length, 1);
    assert.equal(view.snapshot().messages[0].attachments[0].name, 'input.txt');
    const file = files.find(row => row.filename === 'delivery.md');
    const downloaded = await fetch(identity.hub + file.url, { headers: { Authorization: 'Device ' + identity.session } });
    assert.equal(downloaded.ok, true); const text = await downloaded.text();
    assert.match(text, /Delivered from independent cloud workspace/);
    await fs.writeFile(path.join(output, agent.id + '-delivery.md'), text);
    const continued = await restarted.send(view, 'Verify delivery again.', [], { submissionId: 'followup-' + agent.id });
    assert.equal(continued.ok, true);
    await until(() => view.snapshot().messages.some(row => row.role === 'user' && row.text?.includes('Verify delivery again.')), 'followup');
    report.checks.push({ agent: agent.id, directCloudStart: true, duplicateSafe: true, restart: true,
      userAttachment: true, outputDownloaded: true, followup: true, noWorkspaceTransfer: true });
    view.close(); view = null;
  }
  report.ok = true;
})().catch(error => { report.failure = error.stack; process.exitCode = 1; }).finally(async () => {
  view?.close();
  if (root) await fs.writeFile(path.join(root, 'stop'), '');
  if (backend) await until(() => backend.exitCode !== null, 'fixture stop', 20000).catch(() => backend.kill());
  if (log !== undefined) sync.closeSync(log);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});
