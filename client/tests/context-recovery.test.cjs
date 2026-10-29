const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const recovery = require('../main/pi-session/context-recovery');
const sdkPromise = import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');

test('conversation prompt disables SDK slash expansion while retaining the full text and preflight hook', async () => {
  const original = '/skill:company-research /login #1 都是用户原文';
  let submitted, confirmed = 0;
  const session = { prompt: async (value, options) => {
    submitted = { value, options };
    options.preflightResult(true);
  } };
  await recovery.prompt(session, { state: {} }, original, {
    expandPromptTemplates: true, preflightResult: success => { if (success) confirmed++; },
  });
  assert.equal(submitted.value, original);
  assert.equal(submitted.options.expandPromptTemplates, false);
  assert.equal(confirmed, 1);
});

test('SDK settings override enables automatic compaction without rewriting user settings', async () => {
  const sdk = await sdkPromise;
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
  recovery.configure(settings, 4096);
  assert.equal(settings.getCompactionEnabled(), true);
  const cfg = settings.getCompactionSettings();
  assert.ok(cfg.reserveTokens + cfg.keepRecentTokens < 4096);
});

test('real SDK archive keeps all originals and reloads the bounded checkpoint', async t => {
  const sdk = await sdkPromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = sdk.SessionManager.create(root, root);
  const original = '只读分析，不修改文件';
  manager.appendMessage({ role: 'user', content: original, timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '分析完成' + '材料'.repeat(100000) }], timestamp: Date.now(), stopReason: 'stop' });
  const session = { sessionManager: manager, model: { contextWindow: 8192 }, agent: { state: { messages: [] } } };
  const request = 'FIRST ' + '本轮材料'.repeat(40000) + ' LAST';
  const item = recovery.checkpoint(session, request, { images: [] });
  assert.ok(item.text.includes('FIRST') && item.text.includes('LAST'));
  const active = JSON.stringify(session.agent.state.messages);
  assert.ok(active.length < 6000 && active.includes(original));
  const file = manager.getSessionFile();
  const saved = sdk.SessionManager.open(file);
  assert.equal(saved.getSessionId(), manager.getSessionId());
  assert.ok(saved.getBranch().some(e => e.customType === recovery.TYPE && e.data.prompt === request));
  assert.deepEqual(saved.buildSessionContext().messages, session.agent.state.messages);
  assert.ok(fs.readFileSync(file, 'utf8').length > 200000);
});

test('bounded recovery uses hidden continuation and leaves other errors/cancellation alone', async () => {
  const sdk = await sdkPromise;
  for (const cancelled of [false, true]) {
    const state = { aborted: cancelled, lastStopReason: 'error', lastAssistantError: 'context length exceeded' };
    let retried = 0;
    const session = { model: { contextWindow: 8192 }, sessionManager: sdk.SessionManager.inMemory(),
      agent: { state: { messages: [] } }, prompt: async () => {},
      sendCustomMessage: async (m, opts) => { retried++; assert.equal(m.display, false); assert.equal(opts.triggerTurn, true); } };
    await recovery.prompt(session, { state }, '本轮要求', {});
    assert.equal(retried, cancelled ? 0 : 1);
  }
  await assert.rejects(recovery.prompt({ prompt: async () => { throw Error('401 unauthorized'); } }, { state: {} }, 'test', {}), /401/);
});

test('common gateway context errors remain distinguishable from ordinary capacity descriptions', () => {
  for (const message of ['Range of input length should be [1, 129024]',
    'The input token count (9000) exceeds the maximum number of tokens allowed (8192)',
    'ContextOverflowError', 'prompt is too long']) assert.ok(recovery.OVERFLOW.test(message), message);
  assert.equal(recovery.OVERFLOW.test('Context window is 128000 tokens'), false);
  assert.equal(recovery.errorWindow('maximum context length is 8,192 tokens'), 8192);
});
