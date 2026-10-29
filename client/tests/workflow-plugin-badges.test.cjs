'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const stream = require('../main/pi-session/event-stream');
const personal = require('../main/personal-plugins');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=';
const badge = { pluginId: 'local:workflow', name: 'Page workshop', version: '1.2.3', scopeLabel: '仅自己', icon: png };

function temp(t, cleanup = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-workflow-badges-'));
  t.after(async () => { try { await cleanup(); } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } });
  return root;
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('workflow did not reach its expected boundary');
}

test('explicit workflow badge survives Pi reply and native archive replay without selecting ordinary follow-ups', async t => {
  let cancel = async () => {};
  const root = temp(t, () => cancel()), app = { getPath: () => root, isPackaged: false };
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const manager = sdk.SessionManager.create(root, path.join(root, 'sessions'));
  const acc = stream.create(), queued = [], methods = new Map();
  const ctx = { ref: 'workflow-parent', effectiveCwd: root, goal: {}, taskBinding: { taskIds: [], taskBindings: [] },
    shared: { stream, attachmentContract: require('../main/pi-session/attachment-contract'),
      messageTime: require('../main/conversation/message-time') },
    turnQueue: { active: () => queued[0] },
    prep: { model: { id: 'parent-model', api: 'openai-completions', provider: 'test' } },
    piSession: { sessionId: manager.getSessionId(), sessionManager: manager, agent: { state: { messages: [] } } },
    acc, _snapshot: () => acc.snapshot(), _emit() {}, persistPluginSelection() {},
  };
  const handle = require('../main/pi-session/session-handle').create(ctx);
  handle.attachedWindow = { isDestroyed: () => false, webContents: { id: 7 } };
  handle.submit = (text, files, options) => { queued.push({ text, files, options }); return { accepted: true, completion: new Promise(() => {}) }; };
  handle.pluginDebugChanged = () => {};
  const plugin = personal.create(app, { template: 'workflow', key: 'badge-workshop', name: 'Page workshop',
    version: '1.2.3', icon: png, description: 'Build a page', instructions: 'Follow the workflow.' }).plugin;
  const expected = [{ ...badge, pluginId: plugin.pluginId }];
  const iat = Math.floor(Date.now() / 1000);
  const identity = { hub: 'https://example.invalid', clientId: 'device', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'alice', cid: 'device', iat, exp: iat + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  const ipc = require('../main/personal-plugin-debug-ipc').install({ app,
    ipcMain: { handle: (name, fn) => methods.set(name, fn) }, session: { get: () => handle },
    identityOf: async () => identity, skillDirs: () => [], deviceGrants: () => [], managedInputsRoot: () => root,
    createExecutor: () => ({ preflight: async () => ({ ok: false, issues: [{ message: 'Fixture holds the workflow' }] }), stopNode: async () => {} }),
  });
  const selected = [{ pluginId: plugin.pluginId, name: 'Untrusted renderer name', icon: 'https://invalid/icon.png' }];
  const submitted = await ipc.submitConversation(handle, 'Build a snake game', [], { submissionId: 'workflow-badge-request-0001' }, selected);
  assert.equal(submitted.accepted, true);
  personal.create(app, { ...plugin.localDraft, name: 'Later catalog name', version: '1.2.4', icon: '' });
  const executing = queued[0].options.controlled.execute();
  const journal = require('../main/personal-plugin-debug').store(path.join(root, 'plugin-debug-runs'), handle.sessionId);
  await until(() => journal.read()?.status === 'blocked');
  cancel = async () => {
    const record = journal.read();
    await methods.get('personal-plugin-debug')({ sender: { id: 7 } }, handle.ref,
      { command: 'cancel', runId: record.id, revision: record.revision });
    await executing;
  };
  assert.deepEqual(handle.snapshot().messages[0].plugins, expected);
  assert.deepEqual(journal.read().plugins, expected, 'the accepted record freezes trusted presentation data');
  fs.unlinkSync(path.join(root, 'personal-plugins.json'));
  handle.appendTaskMessage('assistant', 'Pi is designing the game', [], '', 'node-reply');
  assert.deepEqual(handle.snapshot().messages[0].plugins, expected);
  handle.appendTaskMessage('user', 'Ordinary follow-up', [], '', 'next-user');
  assert.deepEqual(handle.snapshot().messages.at(-1).plugins, []);
  const restored = stream.create();
  require('../main/pi-session/history-seed').seed(restored, {
    state: {}, sessionManager: sdk.SessionManager.open(manager.getSessionFile()),
  });
  assert.deepEqual(restored.snapshot().messages[0].plugins, expected);
  assert.deepEqual(restored.snapshot().messages.at(-1).plugins, []);
  assert.equal(restored.snapshot().messages[0].text, 'Build a snake game');
  assert.doesNotMatch(restored.snapshot().messages[0].text, /Untrusted|Follow the workflow/);
  assert.equal(await ipc.submitConversation(handle, 'Page workshop', [], { submissionId: 'ordinary-no-selection' }, []), null);
});

test('structured user metadata is display-only, bounded and authoritative while legacy plugin prompts still replay', () => {
  const metadata = [{ ...badge, context: 'Private instructions', grant: { token: 'PRIVATE' } },
    badge, { ...badge, pluginId: 'second', icon: 'https://invalid/logo.png' },
    { ...badge, pluginId: 'third', icon: 'javascript:bad' }, { ...badge, pluginId: 'fourth' }];
  const acc = stream.create();
  acc.push({ type: 'message_end', message: { role: 'user', content: 'Workflow request', plugins: metadata } });
  const badges = acc.snapshot().messages[0].plugins;
  assert.deepEqual(badges.map(item => item.pluginId), ['local:workflow', 'second', 'third']);
  assert.deepEqual(badges[0], badge);
  assert.equal(badges[1].icon, undefined); assert.equal(badges[2].icon, undefined);
  assert.doesNotMatch(JSON.stringify(badges), /Private|PRIVATE|grant|context|https:|javascript:/);
  const legacy = require('../main/pi-session/plugin-context').augment('Legacy request', [{
    pluginId: 'legacy', name: 'Legacy method', version: '1.0', scopeLabel: '', context: 'Legacy instructions',
  }]);
  acc.push({ type: 'message_end', message: { role: 'user', content: legacy } });
  assert.deepEqual(acc.snapshot().messages[1].plugins, [{ pluginId: 'legacy', name: 'Legacy method', version: '1.0', scopeLabel: '' }]);
  acc.push({ type: 'message_end', message: { role: 'user', content: legacy, plugins: [] } });
  assert.deepEqual(acc.snapshot().messages[2].plugins, []);
});

test('Runner controlled user badge survives its journal and keeps per-message ownership', async t => {
  let session;
  const root = temp(t, () => session?.dispose());
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
  const adapter = createRunnerRuntimeAdapter({ app: { getPath: () => root },
    runnerRuntime: { async rpc(op) { assert.equal(op, 'runtime.detect'); return { ok: true, data: {} }; } },
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'parent', name: 'parent', key: '', baseUrl: '' } }) },
  });
  const request = { identity: { clientId: 'fixture' }, native: { runner: { openOptions: { ref: 'badge-fixture', cwd: root } } } };
  session = await adapter.createSession(request);
  let handle = getRunnerSessionDetails(session).handle;
  await require('../main/conversation/task-output-batch.cjs').apply(handle, [{ method: 'appendTaskMessage', args:
    ['user', 'Run workshop', [], '', 'workflow-start', undefined, undefined,
      [{ ...badge, context: 'Private execution instructions', runtimeGuide: 'Private grant' }]] }]);
  handle.appendTaskMessage('user', 'Run workshop', [], '', 'workflow-start', undefined, undefined, [badge]);
  assert.equal(handle.snapshot().messages.length, 1, 'duplicate publication keeps one user turn');
  assert.deepEqual(handle.snapshot().activePlugins, [], 'presentation does not authorize a later turn');
  handle.appendTaskMessage('assistant', 'Designing', [], '', 'workflow-reply');
  handle.appendTaskMessage('user', 'Ordinary follow-up', [], '', 'ordinary');
  assert.deepEqual(handle.snapshot().messages[0].plugins, [badge]);
  assert.deepEqual(handle.snapshot().messages.at(-1).plugins, []);
  await session.dispose();
  session = await adapter.createSession(request);
  handle = getRunnerSessionDetails(session).handle;
  assert.deepEqual(handle.snapshot().messages[0].plugins, [badge]);
  assert.deepEqual(handle.snapshot().messages.at(-1).plugins, []);
  handle.appendTaskMessage('user', 'Run workshop', [], '', 'workflow-start', undefined, undefined, [badge]);
  assert.equal(handle.snapshot().messages.length, 3, 'a replayed workflow start cannot duplicate its user turn');
});
