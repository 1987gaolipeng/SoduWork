const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const attachments = require('../main/pi-session/attachments');

test('attachment transport accepts Electron/JSON-cloned byte representations', async () => {
  assert.deepEqual([...attachments.bytesFromTransport(new Uint8Array([1, 2, 3]))], [1, 2, 3]);
  assert.deepEqual([...attachments.bytesFromTransport({ type: 'Buffer', data: [4, 5] })], [4, 5]);
  assert.deepEqual([...attachments.bytesFromTransport({ 0: 6, 1: 7 })], [6, 7]);
  assert.equal(attachments.bytesFromTransport({ 0: 1, extra: 2 }), null);
  assert.equal(attachments.bytesFromTransport({ type: 'Buffer', data: [256] }), null);
});

test('staging a cloned image/file payload keeps bytes for non-Pi runtimes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-attachments-'));
  try {
    const staged = await attachments.stage(root, [
      { name: 'clipboard.png', type: 'image/png', data: { 0: 137, 1: 80, 2: 78, 3: 71 } },
      { name: 'note.txt', contentType: 'text/plain', data: { type: 'Buffer', data: [104, 105] } },
    ], { stagingDir: path.join(root, 'inputs') });
    assert.equal(staged.warnings.length, 0);
    assert.equal(staged.files.length, 2);
    assert.equal(staged.files[1].mimeType, 'text/plain');
    assert.deepEqual([...await fs.readFile(staged.files[0].path)], [137, 80, 78, 71]);
    assert.deepEqual([...await fs.readFile(staged.files[1].path)], [104, 105]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
