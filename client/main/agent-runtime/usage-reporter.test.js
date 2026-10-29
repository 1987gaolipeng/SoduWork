'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createUsageReporter } = require('./usage-reporter');

test('quota crossing notifies the client immediately after durable usage upload', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-usage-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));

  let requests = 0;
  let notified = null;
  let activeDevice = null;
  const quota = { enabled: true, limit: 100, used: 106, remaining: 0, exceeded: true };
  const reporter = createUsageReporter({
    app: { getPath: (name) => {
      assert.equal(name, 'userData');
      return userData;
    } },
    identityOf: async (_app, hub = 'https://hub.example', clientId = activeDevice) => {
      assert.equal(hub, 'https://hub.example');
      assert.equal(clientId, 'soduwork-device');
      activeDevice = clientId;
      return { hub, clientId, session: 'short-session' };
    },
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url, 'https://hub.example/api/v1/usage/events');
      assert.equal(options.headers.Authorization, 'Device short-session');
      const payload = JSON.parse(options.body);
      assert.equal(payload.usage.total, 10);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, quota }),
      };
    },
    onQuotaExceeded: (detail) => { notified = detail; },
  });

  reporter.observe({
    usageIdentity: { hub: 'https://hub.example', clientId: 'soduwork-device' },
    sessionId: 'chat-1',
    adapterId: 'pi',
    model: 'model-1',
  }, {
    messages: [{ role: 'assistant', done: true, usage: {
      input: 4, output: 6, totalTokens: 10,
    } }],
  });

  reporter.observe({
    usageIdentity: { hub: 'https://hub.example', clientId: 'soduwork-device' },
    sessionId: 'chat-1',
    adapterId: 'pi',
    model: 'model-1',
  }, {
    messages: [{ role: 'assistant', done: true, usage: {
      input: 4, output: 6, totalTokens: 10,
    } }],
  });

  await reporter.flush();
  assert.equal(requests, 1);
  assert.deepEqual(notified, {
    hub: 'https://hub.example',
    clientId: 'soduwork-device',
    quota,
  });

  await reporter.flush();
  assert.equal(requests, 1, 'a successful upload must leave no retry row');
});

test('late quota receipts preserve settled accounting across account changes and token renewal', async (t) => {
  const { scope } = require('../conversation/runtime-segments');
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const identity = (uid, hub = 'https://hub.example', lifetime = 3600) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { typ: 'device', uid, cid: 'quota-device', iat: now - 10, exp: now + lifetime };
    return { hub, clientId: claims.cid,
      session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64) };
  };
  for (const example of [
    { name: 'different account', next: identity('another'), notify: false },
    { name: 'different Hub', next: identity('owner', 'https://another.example'), notify: false },
    { name: 'renewed same account', next: identity('owner', undefined, 7200), notify: true },
    { name: 'current identity unavailable', next: null, notify: false },
  ]) {
    const userData = fs.mkdtempSync(path.join(temporaryRoot, 'soduwork-quota-notify-'));
    t.after(() => {
      assert.equal(path.dirname(fs.realpathSync(userData)), temporaryRoot);
      fs.rmSync(userData, { recursive: true, force: true });
    });
    const original = identity('owner');
    let active = original, requests = 0, notifications = 0;
    const reporter = createUsageReporter({ app: { getPath: () => userData },
      identityOf: async (_app, hub) => hub ? original : active,
      fetchImpl: async () => {
        requests++;
        active = example.next;
        return { ok: true, text: async () => JSON.stringify({ ok: true,
          quota: { enabled: true, exceeded: true, remaining: 0 } }) };
      },
      onQuotaExceeded: () => notifications++,
    });
    reporter.observe({ usageIdentity: { ...original, accountScope: scope(original) },
      sessionId: 'settled-quota', adapterId: 'pi' },
    { messages: [{ role: 'assistant', done: true, usage: { totalTokens: 10 } }] });
    await reporter.flush();
    assert.equal(notifications, Number(example.notify), example.name);
    await reporter.flush();
    assert.equal(requests, 1, example.name + ': accepted accounting must not retry');
  }
});

test('chat usage reports the conversation title (renamed first, else auto title)', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-usage-title-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));

  const payloads = [];
  const reporter = createUsageReporter({
    app: { getPath: (name) => userData },
    identityOf: async (_app, hub, clientId) => ({ hub, clientId, session: 'session' }),
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    },
    onQuotaExceeded: () => {},
  });
  const snapshot = { messages: [{ role: 'assistant', done: true, usage: { totalTokens: 10 } }] };
  /* A renamed second conversation overrides its stale history title. */
  const crypto = require('node:crypto');
  const titlesDir = path.join(userData, 'conversation-titles');
  fs.mkdirSync(titlesDir, { recursive: true });
  const hashed = crypto.createHash('sha256').update('chat-2').digest('hex');
  fs.writeFileSync(path.join(titlesDir, hashed + '.json'), JSON.stringify({
    id: 'chat-2', title: '用户改过的名字', titleUpdatedAt: 1,
  }));
  reporter.observe({
    usageIdentity: { hub: 'https://hub.example', clientId: 'soduwork-device' },
    sessionId: 'chat-2',
    adapterId: 'pi',
    historyRow: () => ({ title: '首句自动标题' }),
  }, snapshot);
  /* The first conversation falls back to its history-derived title when no rename exists. */
  reporter.observe({
    usageIdentity: { hub: 'https://hub.example', clientId: 'soduwork-device' },
    sessionId: 'chat-3',
    adapterId: 'pi',
    historyRow: () => ({ title: '  首句自动   标题  ' }),
  }, snapshot);
  await reporter.flush();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].sourceTitle, '用户改过的名字');
  assert.equal(payloads[1].sourceTitle, '首句自动 标题');
});
