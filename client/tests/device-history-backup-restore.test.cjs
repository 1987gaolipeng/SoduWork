'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite = require('../main/conversation/replica-store.cjs');
const shared = require('../main/conversation/shared-history.cjs');
const artifacts = require('../main/conversation/artifact-runtime');
const { identity } = require('./helpers/platform-session-fixture.cjs');

const warmRepairs = ['repair a nested file while open', 'repair an edited file while open', 'repair a linked file while open'];
for (const mode of ['open without native history', 'native backfill', 'background upgrade', 'repair one missing file',
  ...warmRepairs, 'rebuild a missing generation', 'preserve unavailable originals']) {
  test('a copied SQLite profile restores authenticated private outputs through ' + mode, { timeout: 10000 }, async t => {
    const nativeMissing = mode !== 'native backfill';
    const warm = warmRepairs.includes(mode);
    const repair = warm || ['repair one missing file', 'rebuild a missing generation', 'preserve unavailable originals'].includes(mode);
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-profile-restore-')));
    const cwd = path.join(base, 'workspace'), original = path.join(base, 'original'), backup = path.join(base, 'backup');
    const id = 'sample', user = identity(), account = require('../main/platform-connections/runtime.cjs').scope(user);
    const nativeFile = profile => path.join(profile, 'pi-agent', 'sessions', id + '.jsonl');
    const row = profile => ({ id, adapterId: 'pi', path: nativeFile(profile), cwd, count: 2,
      workOwner: account, creator: { account: 'one', hub: user.hub } });
    function open(profile) {
      const app = { getPath: () => profile };
      const session = { historyEntry: async () => fs.existsSync(nativeFile(profile)) ?
        { ok: true, entry: row(profile) } : { ok: false, notFound: true },
      archivedConversation: async () => null, findBySessionId: () => null };
      const store = sqlite.createWorker(path.join(profile, 'conversation-replicas', 'history.sqlite'));
      return shared.create({ app, session, store, identityOf: () => user });
    }
    fs.mkdirSync(path.dirname(nativeFile(original)), { recursive: true });
    fs.writeFileSync(nativeFile(original), [
      { type: 'session', id, cwd }, { type: 'message', message: { role: 'user', content: 'Synthetic input' } },
      { type: 'message', message: { role: 'assistant', content: 'Synthetic reply' } },
    ].map(value => JSON.stringify(value)).join('\n'));
    let service = open(original);
    t.after(async () => { await service.close(); fs.rmSync(base, { recursive: true, force: true }); });
    await service.register([row(original)]);
    const names = repair ? ['result.md', 'nested/backup.md'] : nativeMissing ?
      ['result.md', 'empty.txt', 'modified.md', 'missing.md', 'hard.md', 'nested/link.md'] : ['result.md'];
    const files = names.map(name => {
      const content = name === 'empty.txt' ? '' : 'Synthetic document';
      const file = path.join(cwd, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return { path: name, action: 'created', after: { exists: true, path: name, size: Buffer.byteLength(content),
        hash: crypto.createHash('sha256').update(content).digest('hex') } };
    });
    await service.backfill(id, { journal: { turnId: 'synthetic-turn', cwd, files } });
    const before = (await service.store.deviceHistory(id)).localArtifactHistory;
    assert.equal(before.archive.files.length, names.length);
    await service.close();
    fs.cpSync(original, backup, { recursive: true, preserveTimestamps: true });
    fs.rmSync(original, { recursive: true });
    if (!repair) fs.rmSync(cwd, { recursive: true });
    if (nativeMissing) fs.unlinkSync(nativeFile(backup));
    const generation = path.join(backup, 'conversation-artifacts', crypto.createHash('sha256').update(id).digest('hex'),
      before.archive.generation);
    if (mode === 'rebuild a missing generation') {
      fs.rmSync(generation, { recursive: true });
    } else if (repair) {
      if (!warm) fs.unlinkSync(path.join(generation, 'nested', 'backup.md'));
      // The previously saved result is the only authorized version of this path.
      fs.writeFileSync(path.join(cwd, 'result.md'), 'replacement');
      if (mode === 'preserve unavailable originals') fs.writeFileSync(path.join(cwd, 'nested', 'backup.md'), 'replacement');
    } else if (nativeMissing) {
      const external = path.join(base, 'outside');
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, 'link.md'), 'Synthetic document');
      fs.rmSync(path.join(generation, 'nested'), { recursive: true });
      fs.symlinkSync(external, path.join(generation, 'nested'), 'junction');
      fs.unlinkSync(path.join(generation, 'hard.md'));
      fs.linkSync(path.join(external, 'link.md'), path.join(generation, 'hard.md'));
      fs.writeFileSync(path.join(generation, 'modified.md'), 'Synthetic documenX');
      fs.unlinkSync(path.join(generation, 'missing.md'));
      fs.writeFileSync(path.join(generation, 'unrecorded.md'), 'Synthetic document');
    }
    if (mode === 'background upgrade') {
      // An older profile has no review index. The history sidebar starts its upgrade.
      const old = new (require('node:sqlite').DatabaseSync)(path.join(backup, 'conversation-replicas', 'history.sqlite'));
      try { old.exec('DROP TABLE artifact_archive_review'); } finally { old.close(); }
    }
    service = open(backup);
    if (warm) {
      for (let attempt = 0; attempt < 2; attempt++) await (await service.open(id, { historyPreview: true })).close();
      const file = path.join(generation, 'nested', 'backup.md');
      if (mode === 'repair an edited file while open') fs.writeFileSync(file, 'Synthetic documenX');
      else if (mode === 'repair a linked file while open') fs.linkSync(file, path.join(base, 'extra-link.md'));
      else fs.unlinkSync(file);
    }
    if (mode === 'background upgrade') {
      const committed = Promise.withResolvers(), write = service.store.saveDeviceHistory;
      service.store.saveDeviceHistory = async (...args) => {
        const result = await write(...args);
        if (args[0] === id) committed.resolve(result);
        return result;
      };
      await service.page({});
      assert.equal((await committed.promise).ok, true);
    }
    if (!nativeMissing) await service.backfill(id);
    const view = await service.open(id, { historyPreview: true });
    const output = await artifacts.snapshotAsync(view);
    const expected = repair ? (mode === 'preserve unavailable originals' ? ['result.md'] : [...names].sort()) :
      nativeMissing ? ['empty.txt', 'result.md'] : ['result.md'];
    assert.deepEqual(output.items.map(item => item.relative).sort(), expected);
    const report = output.items.find(item => item.relative === 'result.md');
    assert.equal((await artifacts.action(view, view.ref, report.artifactId, 'read', {})).text, 'Synthetic document');
    const saved = await service.store.deviceHistory(id);
    assert.equal(saved.snapshot.messages[1].text, 'Synthetic reply');
    const repaired = repair && mode !== 'preserve unavailable originals';
    assert.equal(saved.localArtifactHistory.archive.generation === before.archive.generation, !repaired);
    if (repaired) assert.equal(saved.localArtifactHistory.archivePending, false);
    if (mode === 'preserve unavailable originals') {
      assert.equal(saved.localArtifactHistory.archivePending, true);
      assert.deepEqual(saved.localArtifactHistory.archive.files.find(file => file.relative === 'nested/backup.md'),
        before.archive.files.find(file => file.relative === 'nested/backup.md'));
    }
    const record = history => history.archive.files.find(file => file.relative === 'result.md');
    assert.notDeepEqual(record(saved.localArtifactHistory).stamp, record(before).stamp);
    assert.deepEqual(record(saved.localArtifactHistory).sourceStamp, record(before).sourceStamp);
    await view.close();
    await service.close();
    if (repair) fs.rmSync(cwd, { recursive: true });
    service = open(backup);
    const reopened = await service.open(id, { historyPreview: true });
    assert.deepEqual((await artifacts.snapshotAsync(reopened)).items.map(item => item.relative).sort(),
      output.items.map(item => item.relative).sort());
    assert.equal((await service.store.deviceHistory(id)).digest, saved.digest);
    if (repaired) {
      const item = (await artifacts.snapshotAsync(reopened)).items.find(file => file.relative === 'nested/backup.md');
      assert.equal((await artifacts.action(reopened, reopened.ref, item.artifactId, 'read', {})).text, 'Synthetic document');
    }
    await reopened.close();
  });
}
