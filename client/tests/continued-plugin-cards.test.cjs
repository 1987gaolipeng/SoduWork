'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const project = require('../main/conversation/device-history-artifacts.cjs');
const versions = require('../main/conversation/runtime-artifacts.cjs');
const runtime = require('../main/conversation/artifact-runtime');
const drafts = require('../main/pi-session/plugin-draft');
const generated = require('../e2e/fixtures/created-plugin-history.cjs');

function replace(file) {
  const next = file + '.replacement';
  fs.copyFileSync(file, next);
  fs.renameSync(next, file);
}

function journal(cwd, turnId, paths) {
  return { cwd, turnId, files: paths.map(name => {
    const bytes = fs.readFileSync(path.join(cwd, name));
    return { path: name, action: 'modified', after: { exists: true, path: name, size: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex') } };
  }) };
}

for (const id of generated.chats) {
  test('continuing ' + id + ' preserves the recorded install scope across segments', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continued-plugin-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.after(() => require('../main/app-resource-cache.cjs').close());
    const cwd = path.join(root, 'workspace'), app = { getPath: () => path.join(root, 'profile') };
    fs.mkdirSync(cwd);
    const row = { cwd, id, adapterId: 'pi' }, paths = await generated.write(root, row);
    const captured = await project.capture({ row, journal: journal(cwd, 'original', paths) });
    const preview = project.view(cwd, captured, () => {});
    const old = (await preview.snapshotAsync()).items.find(item => item.pluginDraft);
    assert.ok(old);
    const scanned = { files: [], since: Date.now() + 60000 };
    const handle = { cwd, sessionId: 'resumed', artifactHistory: versions.forContinuation(cwd, captured),
      outputSnapshot: () => scanned };
    const card = async () => (await runtime.snapshotAsync(handle)).items.find(item => item.artifactId === old.artifactId && item.pluginDraft);
    if (id === 'history-unrecorded') {
      assert.equal((await card())?.pluginValidation.state, 'invalid');
      assert.equal((await drafts.readSessionAsync(handle, old.artifactId, app)).ok, false);
      return;
    }
    assert.equal((await card())?.pluginValidation.state, 'ready');
    const read = await drafts.readSessionAsync(handle, old.artifactId, app);
    assert.equal(read.ok, true, read.reason);
    assert.equal(read.body.key, id);
    const indexed = await runtime.snapshotAsync(handle);
    handle.artifactHistory = versions.capture(cwd, indexed, { sessionId: 'next' }, versions.continuedPlugins(handle).receipt);
    assert.equal((await card())?.pluginValidation.state, 'ready');
    const selected = id === 'history-app' ? 'delivery/ui/app.js'
      : id === 'history-method' ? 'delivery/templates/review.md' : old.relative;
    const file = path.join(cwd, selected);
    replace(file);
    // Include the old manifest in the active scan to exercise both discovery paths.
    scanned.since = 0;
    scanned.files.push({ path: path.join(cwd, paths[0]) });
    assert.notEqual((await card())?.pluginValidation.state, 'ready');
    assert.equal((await drafts.readSessionAsync(handle, old.artifactId, app)).ok, false);
    assert.equal(drafts.readSession(handle, path.join(cwd, paths[0])).ok, false);
    assert.equal((await drafts.readRecentAsync([handle], app)).ok, false);
    scanned.fileChanges = journal(cwd, 'regenerated', [selected]);
    assert.equal((await card())?.pluginValidation.state, 'ready');
    assert.equal((await drafts.readSessionAsync(handle, old.artifactId, app)).ok, true);
    replace(file);
    scanned.fileChanges = structuredClone(scanned.fileChanges);
    assert.notEqual((await card())?.pluginValidation.state, 'ready', 'a repeated turn receipt cannot authorize a later replacement');
    if (id === 'history-app') {
      const second = 'delivery/ui/soduwork-app.js';
      const other = path.join(cwd, second);
      replace(other);
      const continued = versions.continuedPlugins(handle);
      await Promise.all([continued.refresh(journal(cwd, 'first-repair', [selected])),
        continued.refresh(journal(cwd, 'second-repair', [second]))]);
      assert.equal((await card())?.pluginValidation.state, 'ready', 'concurrent journals for distinct resources must both survive');
      const retained = versions.capture(cwd, await runtime.snapshotAsync(handle), { sessionId: 'another' }, continued.receipt);
      handle.artifactHistory = versions.forContinuation(cwd, captured, retained);
      assert.equal((await card())?.pluginValidation.state, 'ready', 'an older index cannot override newer verified resource versions');
    }
  });
}
