'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../main/conversation/personal-relay');

test('native relay reads a local fixture in the same real Pi session and syncs its reply once',
  { timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-native-relay-'));
    const runtime = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
    t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const file = path.join(runtime.cwd, 'relay-proof.txt');
    fs.writeFileSync(file, 'PERSONAL_PC_FILE_OK');
    runtime.reply(body => body.messages.at(-1).role === 'tool'
      ? { text: 'PERSONAL_PC_FILE_OK' } : { tool: 'read', args: { path: file } });
    const handle = await runtime.open({ ref: 'native-relay-runtime' });
    const original = handle.sessionId;
    let phase = 'prepared', completion, sends = 0;
    const synced = [], queued = new Map(), saved = new Map();
    const identity = { hub: 'http://isolated-hub', clientId: 'pc', session:
      Buffer.from(JSON.stringify({ typ: 'device', cid: 'pc', uid: 'test' })).toString('base64url') + '.fixture' };
    const sync = require('../main/conversation/account-sync').create({ app: {}, identityOf: async () => identity,
      store: { session: key => saved.get(key), setSession: (key, value) => saved.set(key, value),
        enqueue: job => queued.set(job.id, job), jobs: () => [...queued.values()], ack: id => queued.delete(id), fail() {} },
      fetch: async (_identity, _url, request) => {
        const body = JSON.parse(request.body); synced.push(body);
        if (!['idle', 'responding', 'completed', 'interrupted', 'stopped', 'failed'].includes(body.state)) {
          return { ok: false, status: 422, json: async () => ({ detail: 'Unsupported conversation state' }) };
        }
        return { ok: true, json: async () => ({ ok: true, conversationId: 'account-native', sourceRevision: body.sourceRevision }) };
      } });
    t.after(() => sync.close());
    sync.bind(handle, identity);
    const relay = create({ app: { getPath: () => root }, identityOf: async () => identity,
      find: id => id === original ? handle : null, open: async () => { throw Error('must retain native session'); },
      autoStart: false, sync: () => sync.flush(),
      send: async (_ref, instruction, files, options) => {
        await options.nativeRelayGuard();
        sends++;
        const submitted = await handle.submit(instruction, files, options);
        completion = submitted.completion;
        return { ok: true, accepted: submitted.accepted };
      },
      fetch: async (_identity, url, options) => {
        if (url.endsWith('/poll')) return { ok: true, json: async () => ({ requests: phase === 'prepared' ? [{
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', targetClientId: 'pc', conversationId: 'account-native',
          sourceSessionId: original, phase, instruction: 'Read relay-proof.txt and report its contents. Do not modify it.',
        }] : [] }) };
        if (url.includes('/claims/')) phase = 'claimed';
        if (url.includes('/acks/')) phase = JSON.parse(options.body).phase;
        return { ok: true, json: async () => ({ ok: true }) };
      } });
    t.after(() => relay.close());
    await relay.tick();
    assert.equal(phase, 'accepted');
    const result = await completion;
    assert.equal(result.ok, true, result.reason);
    await sync.flush();
    await relay.tick();
    assert.equal(sends, 1);
    assert.equal(handle.sessionId, original);
    assert.equal(handle.cwd, runtime.cwd);
    const messages = synced.at(-1).messages;
    assert.ok(messages.some(item => item.text?.includes('Previous report is preserved.')));
    assert.ok(messages.some(item => item.role === 'assistant' && item.text?.includes('PERSONAL_PC_FILE_OK')));
    assert.ok(runtime.requests.some(body => body.messages.some(item => item.role === 'tool' &&
      JSON.stringify(item.content).includes('PERSONAL_PC_FILE_OK'))));
    assert.equal(fs.readFileSync(file, 'utf8'), 'PERSONAL_PC_FILE_OK');
    assert.ok(synced.length >= 2);
  });
