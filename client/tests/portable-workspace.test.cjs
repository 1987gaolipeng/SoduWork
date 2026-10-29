'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const workspace = require('../main/conversation/portable-workspace');
const { createZip } = require('../main/conversation/zip-archive');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
function entries(bytes) {
  const result = new Map(); let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const method = bytes.readUInt16LE(at + 8), size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26), extraLength = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    at += 30 + nameLength + extraLength; const data = bytes.subarray(at, at + size); at += size;
    result.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
  }
  return result;
}
test('portable handoff preserves Unicode files, binary artifacts and visible conversation facts only', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, '报告'));
  const data = crypto.randomBytes(2048); await fs.writeFile(path.join(root, '报告', '示例.png'), data);
  await fs.writeFile(path.join(root, 'README.md'), '# Continue here\n');
  await fs.writeFile(path.join(root, '.env'), 'DO_NOT_COPY'); await fs.writeFile(path.join(root, '.git'), 'gitdir: elsewhere');
  await fs.mkdir(path.join(root, 'node_modules')); await fs.writeFile(path.join(root, 'node_modules', 'cache'), 'ignored');
  const input = { sessionId: 'chat-123', adapterId: 'pi', modelName: 'company-model', goal: '交付报告',
    secret: 'private-model-key', cwd: 'private-local-path', messages: [{ role: 'user', text: '继续' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: '正在完成' }] },
      { role: 'tool', text: 'private raw tool output' }] };
  const result = await workspace.create(root, input);
  const unpacked = entries(result.bytes);
  assert.deepEqual(unpacked.get('workspace/报告/示例.png'), data);
  assert.equal(unpacked.get('workspace/README.md').toString(), '# Continue here\n');
  assert.equal(unpacked.size, 3);
  assert.equal(result.manifest.files.length, 2);
  assert.deepEqual(result.manifest.excluded.map(x => x.path).sort(), ['.env', '.git', 'node_modules']);
  assert.deepEqual(result.manifest.source.messages.map(x => x.text), ['继续', '正在完成']);
  assert.doesNotMatch(unpacked.get('manifest.json').toString(), /private-model-key|private-local-path|private reasoning|private raw tool/);
  assert.equal(result.sha256, crypto.createHash('sha256').update(result.bytes).digest('hex'));
  assert.equal((await workspace.create(root, input)).sha256, result.sha256, 'the same snapshot has a stable digest');
});
test('file and byte limits fail completely rather than silently dropping files', async t => {
  const root = await fixture(t); await fs.writeFile(path.join(root, 'a.txt'), 'first'); await fs.writeFile(path.join(root, 'b.txt'), 'second');
  await assert.rejects(workspace.create(root, { sessionId: 's' }, { maxFiles: 1 }), /超过/);
  await assert.rejects(workspace.create(root, { sessionId: 's' }, { maxBytes: 4 }), /超过/);
  assert.throws(() => workspace.safeMetadata({ sessionId: 's', messages: [{ role: 'user', text: 'x'.repeat(workspace.MAX_TRANSCRIPT) }] }), /超过/);
  assert.throws(() => workspace.safeMetadata({ sessionId: 's', goal: 'x'.repeat(16001) }), /超过/);
});
test('all adapters carry visible blocks without exporting their thinking blocks', () => {
  const catalog = require('../main/agent-runtime/runtime-catalog');
  for (const adapter of catalog.runtimes()) {
    const result = workspace.safeMetadata({ sessionId: 's', adapterId: adapter.id,
      messages: [{ role: 'assistant', text: '', completedAt: 123, blocks: [
        { kind: 'thinking', text: 'private' }, { kind: 'text', text: 'Delivered' }] }] });
    assert.equal(result.messages[0].text, 'Delivered');
    assert.equal(result.messages[0].at, 123);
  }
});
test('late additions are detected and worker produces the same complete archive', async t => {
  const root = await fixture(t); await fs.writeFile(path.join(root, 'a.txt'), 'original');
  await assert.rejects(workspace.create(root, { sessionId: 's' }, { onProgress: () => {
    require('node:fs').writeFileSync(path.join(root, 'new.txt'), 'late');
  } }), /变化/);
  const worker = require('../main/conversation/portable-workspace-worker');
  const threaded = await worker.create(root, { sessionId: 's' });
  assert.equal(threaded.sha256, (await workspace.create(root, { sessionId: 's' })).sha256);
  assert.equal((await worker.scan(root)).files.length, 2);
  await assert.rejects(worker.scan(root, { signal: AbortSignal.abort() }), /取消/);
});
test('links are excluded and files changing during snapshot creation fail explicitly', async t => {
  const root = await fixture(t), outside = await fixture(t);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'a.txt'), 'first'); await fs.writeFile(path.join(root, 'b.txt'), 'second');
  assert.equal((await workspace.scan(root)).excluded.find(x => x.path === 'linked').reason, 'link');
  await assert.rejects(workspace.create(root, { sessionId: 's' }, { onProgress: ({ files }) => {
    if (files === 1) require('node:fs').writeFileSync(path.join(root, 'b.txt'), 'changed and longer');
  } }), /变化/);
});
test('cross-platform traversal, reserved names and ambiguous paths are rejected', () => {
  for (const name of ['../a', '/a', 'a\\b', 'C:/a', 'a//b', 'a/./b', 'nul.txt', 'a/con', 'a.', 'a ', 'a:stream', 'a\0b']) {
    assert.throws(() => workspace.portablePath(name), undefined, name);
  }
  assert.equal(workspace.portablePath('报告/2026-10.md'), '报告/2026-10.md');
});
test('existing folder export still returns a readable archive after sharing the ZIP encoder', async t => {
  const root = await fixture(t); await fs.writeFile(path.join(root, 'report.txt'), 'Existing export\n');
  const result = createZip(root);
  assert.equal(result.files, 1); assert.equal(entries(result.data).get('report.txt').toString(), 'Existing export\n');
});
