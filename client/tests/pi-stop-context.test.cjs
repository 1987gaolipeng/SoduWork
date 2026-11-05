'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { create } = require('../e2e/fixtures/resumed-pi.cjs');

async function stopBeforeUsage(fixture, handle, prompt, signal) {
  const partial = 'Waiting for usage';
  fixture.reply(() => ({ respond(response) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'held', object: 'chat.completion.chunk', model: 'fixture-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: partial }, finish_reason: null }] }) + '\n\n');
    // Keep the stream open without sending a provider usage receipt.
  } }));
  const turn = handle.submit(prompt, []);
  while (!handle.snapshot().messages.at(-1)?.blocks.some(block => block.text === partial)) {
    await delay(10, undefined, { signal });
  }
  assert.equal((await handle.cancel()).stopped, true);
  await turn.completion;
  const last = handle.snapshot().messages.at(-1);
  assert.equal(last.stopReason, 'aborted');
  assert.equal(last.usage.input, 0, 'the SDK archived an empty receipt for the interrupted request');
}

test('stopping a real Pi stream preserves the latest measured context across reopen', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stop-context-'));
  const fixture = await create(root, { signal: t.signal });
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });

  // Start a separately scoped, empty on-disk session within the fixture workspace.
  const manager = fixture.sdk.SessionManager.create(fixture.cwd, root);
  const resumePath = manager.getSessionFile();
  fs.writeFileSync(resumePath, JSON.stringify(manager.getHeader()) + '\n', { flag: 'wx' });
  const reopen = () => fixture.open({ resumePath, resumeCwd: fixture.cwd });

  let handle = await reopen();
  await stopBeforeUsage(fixture, handle, 'First request', t.signal);
  assert.equal(handle.snapshot().contextUsage, null);
  handle.close();

  handle = await reopen();
  assert.equal(handle.snapshot().contextUsage, null);
  fixture.reply(() => ({ text: 'Received.' }));
  assert.equal((await handle.submit('Complete this request', []).completion).ok, true);
  const measured = handle.snapshot().contextUsage;
  assert.equal(measured.input, 20);
  await stopBeforeUsage(fixture, handle, 'Interrupt this request', t.signal);
  assert.deepEqual(handle.snapshot().contextUsage, measured);
  handle.close();

  handle = await reopen();
  assert.deepEqual(handle.snapshot().contextUsage, measured);
});
