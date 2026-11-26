'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const segments = require('../main/conversation/runtime-segments');

test('listing runtime identities does not retain every historical transcript', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-runtime-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = { getPath: () => directory };
  const prefix = { messages: [{ role: 'assistant', text: 'history '.repeat(128 * 1024) }] };
  for (let index = 0; index < 64; index++) {
    await segments.save(app, { version: 1, id: `history-${index}`, owner: 'owner-a', prefix,
      segments: [{ sessionId: `native-${index}`, adapterId: 'pi' }],
      active: { sessionId: `native-${index}`, adapterId: 'pi' } });
  }

  // Fixture creation and the test runner live outside the measured process.
  // Keep one full record alive to check that active readers still share it.
  const script = `
    const segments = require(process.argv[1]);
    const app = { getPath: () => process.argv[2] };
    (async () => {
      global.gc(); const before = process.memoryUsage().heapUsed;
      const held = segments.read(app, 'history-0');
      const identities = segments.identities(app);
      for (let turn = 0; turn < 3; turn++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
      }
      const retained = process.memoryUsage().heapUsed - before;
      const reused = segments.read(app, 'history-0') === held;
      const reloaded = segments.read(app, 'history-1');
      process.stdout.write(JSON.stringify({ retained, reused,
        heldText: held.prefix.messages[0].text.length,
        reloadedText: reloaded.prefix.messages[0].text.length,
        identities: identities.sort((a, b) => a.id.localeCompare(b.id)) }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '-e', script,
    require.resolve('../main/conversation/runtime-segments'), directory], { encoding: 'utf8' }));
  t.diagnostic(`${result.retained} retained heap bytes after listing 64 one-MiB prefixes`);
  assert.equal(result.reused, true, 'a manifest held by a caller remains a warm cache hit');
  assert.equal(result.heldText, 1024 * 1024);
  assert.equal(result.reloadedText, 1024 * 1024, 'released records remain readable from disk');
  assert.deepEqual(result.identities, Array.from({ length: 64 }, (_, index) => ({
    version: 1, id: `history-${index}`, owner: 'owner-a',
    segments: [{ sessionId: `native-${index}` }], active: { sessionId: `native-${index}` },
  })).sort((a, b) => a.id.localeCompare(b.id)));
  assert.ok(result.retained < 8 * 1024 * 1024,
    `identity listing retained ${result.retained} heap bytes after its full records were released`);
});
