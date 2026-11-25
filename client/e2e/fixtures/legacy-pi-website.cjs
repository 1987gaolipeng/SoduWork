'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const native = require('../../main/conversation/device-history-native.cjs');
const segments = require('../../main/conversation/runtime-segments');

async function create(app, root, sessions) {
  const identity = require('../../tests/helpers/platform-session-fixture.cjs').identity();
  const session = { historyEntry: require('../../main/pi-session/session').historyEntry, findBySessionId: () => null };
  const store = require('../../main/conversation/replica-store.cjs').create(path.join(root, 'legacy.sqlite'));
  const history = require('../../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => identity, workRoot: () => root });
  const oldHeading = '旧版 Pi 生成的网站', newHeading = '新临时目录生成的网站';
  const html = heading => '<!doctype html><meta charset="utf-8"><h1>' + heading + '</h1>';
  const fileRoot = path.join(root, 'pi-agent', 'sessions', 'legacy-project');
  fs.mkdirSync(fileRoot, { recursive: true });
  const owner = segments.scope(identity), creator = { account: 'one', hub: identity.hub };
  const sendAt = Date.now() - 3600000;
  function websiteArchive(id, cwd, heading, sentAt) {
    const content = html(heading);
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'index.html'), content);
    const entries = [{ type: 'session', id, cwd, timestamp: new Date(sentAt - 100).toISOString() },
      { type: 'custom', customType: 'soduwork.access.policy', data: require('../../main/access-control/policy').create('full', cwd) }, ...[
      { role: 'user', content: '创建' + heading, submissionId: 'user-' + id },
      { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'write1', name: 'write', arguments: { path: 'index.html', content } }] },
      { role: 'toolResult', toolCallId: 'write1', toolName: 'write', isError: false, content: [] },
      { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: heading + '，已创建 `index.html`。' }] },
    ].map((message, index) => ({ type: 'message', message: { ...message, timestamp: sentAt + index * 20 } }))];
    const file = path.join(fileRoot, id + '.jsonl');
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
    return { id, cwd, adapterId: 'pi', path: file, count: entries.length - 2, workOwner: owner, creator };
  }
  async function saveLegacy(row) {
    const [registered] = await history.register([row]);
    const { snapshot, coverage } = await native.read({ app, session, row, guard() {} });
    for (const source of coverage.sources) delete source.artifactEvidenceVersion;
    const guard = { expectedRevision: registered.replicaRevision, expectedCatalogRevision: registered.revision };
    await store.saveDeviceHistory(row.id, { snapshot, coverage }, guard);
    await store.saveConversationTranscript(row.id, snapshot.messages, guard);
    return snapshot;
  }
  const row = websiteArchive(randomUUID(), path.join(root, 'temp', 'chat-abcdef-1111'), oldHeading, sendAt);
  await saveLegacy(row);
  const currentDir = path.join(root, 'temp', 'chat-abcdef-2222');
  fs.mkdirSync(currentDir, { recursive: true });
  let serial = 0;
  async function continued(collision) {
    // The application binds the original receipt to the new runtime only after
    // resolving the authorized logical chat. The test replaces model execution.
    const recovered = await history.prepareContinuation(row.id, { refresh: true });
    const ref = 'continued-' + ++serial;
    const at = sendAt + 1800000;
    let current;
    if (collision) {
      current = websiteArchive(randomUUID(), currentDir, newHeading, at);
    } else {
      assert.deepEqual(fs.readdirSync(currentDir), []);
      const id = randomUUID(), file = path.join(fileRoot, id + '.jsonl');
      const entries = [{ type: 'session', id, cwd: currentDir, timestamp: new Date(at - 100).toISOString() },
        { type: 'message', message: { role: 'user', content: '继续会话', timestamp: at } },
        { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已恢复对话。' }], timestamp: at + 100 } }];
      fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
      current = { id, cwd: currentDir, adapterId: 'pi', path: file, count: 2, workOwner: owner, creator };
    }
    const appended = await native.read({ app, session, row: current, guard() {} });
    const raw = { ref, cwd: currentDir, adapterId: 'pi', sessionId: current.id,
      snapshot: () => ({ ...appended.snapshot, status: 'idle', adapterId: 'pi' }),
      historyRow: () => current, close: async () => true,
      outputSnapshot: () => require('../../main/pi-session/outputs').scan(currentDir, 0, 0) };
    const previous = segments.read(app, row.id);
    const restored = { version: 1, id: row.id, owner, cwd: currentDir, originAdapter: 'pi', at: Date.now(),
      prefix: recovered.prefix, deviceHistoryComplete: true, historyRecovery: recovered.historyRecovery,
      segments: previous ? [...previous.segments, previous.active] : [],
      active: { sessionId: current.id, adapterId: 'pi', path: current.path } };
    await segments.save(app, restored);
    const handle = require('../../main/agent-runtime/switchable-conversation').create({
      raw, options: { app, identity, ref }, restored,
    });
    history.bindContinuationArtifacts(handle, recovered, () => assert.equal(sessions.get(ref), handle));
    history.observe(handle, identity);
    return handle;
  }
  const retired = websiteArchive(randomUUID(), path.join(root, 'temp', 'chat-abcdef-3333'), oldHeading, sendAt);
  const logicalId = randomUUID();
  const prefix = (await native.read({ app, session, row: retired, guard() {} })).snapshot;
  const active = websiteArchive(randomUUID(), path.join(root, 'temp', 'chat-abcdef-4444'), newHeading, sendAt + 1800000);
  const part = row => ({ sessionId: row.id, adapterId: 'pi', path: row.path });
  await segments.save(app, { version: 1, id: logicalId, owner, originAdapter: 'pi', cwd: active.cwd,
    deviceHistoryComplete: true, segments: [part(retired)], active: part(active), prefix, at: Date.now() });
  await saveLegacy({ ...active, id: logicalId, runtimeConversationId: logicalId });
  return { id: row.id, retiredId: logicalId, oldHeading, newHeading, continued,
    preview: id => history.open(id, { historyPreview: true, allowContinuation: true }), close: () => history.close() };
}
module.exports = { create };
