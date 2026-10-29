'use strict';
// Inspect the actual NSIS extraction through the delivered Electron runtime.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  const candidateFile = path.resolve(process.argv[2]);
  const candidate = JSON.parse(fs.readFileSync(candidateFile));
  assert.equal(candidate.payloadVerified, true);
  const work = path.dirname(candidateFile);
  const root = JSON.parse(fs.readFileSync(path.join(work, 'payload-result.json'))).extracted;
  if (process.argv[3] !== '--delivered-runtime') {
    const result = spawnSync(path.join(root, 'SoduWork.exe'), [__filename, candidateFile, '--delivered-runtime'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    assert.equal(result.status, 0, result.error?.message || 'Packaged catalog verification failed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'agent-catalog-report.json'))).ok, true);
    return;
  }
  const source = path.resolve(candidate.source, '..'), resources = path.join(root, 'resources');
  const app = path.join(resources, 'app.asar'), catalogPath = path.join(resources, 'agent_catalog.json');
  assert.equal(process.resourcesPath, resources);
  assert.equal(sha(catalogPath), sha(path.join(source, 'hub-backend/app/agent_catalog.json')));
  assert.equal(sha(path.join(resources, 'runner/soduwork-runner.exe')), sha(path.join(source, 'client/runner/soduwork-runner.exe')));
  const catalog = require(path.join(app, 'main/agent-runtime/runtime-catalog.js'));
  const expected = JSON.parse(fs.readFileSync(catalogPath)).agents;
  assert.deepEqual(catalog.runtimes().map(row => row.id), expected.map(row => row.id));
  const inventory = JSON.parse(fs.readFileSync(path.join(root, '.soduwork-payload.json'))).files;
  assert.ok(!inventory.some(row => /(?:^|\/)opencode(?:\/|\.exe$)/i.test(row.path)));
  assert.equal(fs.existsSync(path.join(resources, 'opencode')), false);
  for (const name of ['shell/bin/bash.exe', 'pi/@earendil-works/pi-coding-agent/package.json']) {
    assert.ok(inventory.some(row => row.path === 'resources/' + name), name);
  }
  assert.ok(!inventory.some(row => /^resources\/skills\/.+(?:__pycache__|\.py[co]$|node_modules|\.venv)/.test(row.path)));
  assert.equal(sha(path.join(resources, 'LICENSE.txt')), sha(path.join(source, 'LICENSE')));
  for (const name of ['SKILL.md', 'LICENSE.txt', 'scripts/inspect_deck.py']) {
    assert.equal(sha(path.join(resources, 'skills/pptx', name)), sha(path.join(source, 'skills/pptx', name)));
  }
  const { createRunnerRuntimeAdapter } = require(path.join(app, 'main/agent-runtime/runner-adapter.js'));
  const limited = createRunnerRuntimeAdapter({ runtimeSpec: { ...catalog.runtime('qwen'), id: 'sample-acp', goalMode: 'none' } });
  assert.ok(!limited.capabilities.some(row => row.id === 'goal.control'));
  for (const name of ['cloud-handoff.js', 'cloud-conversation-view.js', 'portable-workspace.js',
    'imported-memory.js', 'session-memory.js', 'local-memory.js', 'personal-learning.js']) {
    assert.equal(sha(path.join(app, 'main/conversation', name)), sha(path.join(source, 'client/main/conversation', name)));
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-packaged-worker-'));
  try {
    fs.writeFileSync(path.join(workspace, 'report.md'), '# Original output');
    const worker = require(path.join(app, 'main/conversation/portable-workspace-worker.js'));
    const snapshot = await worker.create(workspace, { sessionId: 'packaged', adapterId: 'pi', messages: [] });
    assert.equal(snapshot.manifest.files.length, 1);
    assert.ok(Buffer.isBuffer(snapshot.bytes));
  } finally {
    assert.equal(path.dirname(workspace), os.tmpdir());
    assert.ok(path.basename(workspace).startsWith('soduwork-packaged-worker-'));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  const report = { ok: true, agents: catalog.runtimes().map(row => row.id), bundledOpenCode: false,
    sourceMatches: true, workerFromActualAsar: true, skillCachesExcluded: true,
    files: inventory.length, unpackedBytes: inventory.reduce((sum, row) => sum + row.size, 0) };
  fs.writeFileSync(path.join(work, 'agent-catalog-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
