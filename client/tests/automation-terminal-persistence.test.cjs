'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWorker, diskJournal, keyOf } = require('../main/automation-conversations');

const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-terminal-persistence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const token = user => Buffer.from(JSON.stringify({ typ: 'device', cid: 'device', uid: user, ver: 1 })).toString('base64url') + '.test';
  const identity = { hub: 'https://example.invalid', clientId: 'device', session: token('alice') };
  const otherIdentity = { ...identity, session: token('bob') };
  const journal = diskJournal(directory), key = keyOf(identity, 'run');
  const input = { runId: 'run', adapterId: 'pi', text: 'Create a short report.' };
  const acknowledgements = [], calls = [], warnings = [], workers = [];
  let finish, current = identity, claimResult, claimWait, offline = false, switchDuringInbox = false, claims = 0;
  const completion = new Promise(resolve => { finish = resolve; });
  const deps = {
    identityOf: async () => current, journal, catalog: async () => [], instanceId: 'original',
    onError: value => warnings.push(value),
    request: async (owner, route, body) => {
      if (route.endsWith('/inbox')) {
        if (switchDuringInbox) { switchDuringInbox = false; current = otherIdentity; }
        return { items: [{ id: 'run' }] };
      }
      if (route.endsWith('/claim')) { claims++; if (claimWait) await claimWait; return claimResult || { ok: true, input }; }
      if (route.endsWith('/state')) {
        if (['succeeded', 'failed'].includes(body.state)) {
          assert.equal(diskJournal(directory).read(key).state, body.state, 'terminal acknowledgements require the durable outcome');
          if (offline) throw Error('Synthetic receipt connection failure');
        }
        acknowledgements.push({ owner, ...body }); return { ok: true };
      }
      throw Error('Unexpected route');
    },
    conversation: {
      open: async () => { calls.push('open'); return { ok: true, sessionId: 'chat', ref: 'ref' }; },
      send: async () => { calls.push('send'); return { ok: true, completion }; },
    },
  };
  function worker(instanceId = 'original') {
    const value = createWorker({ ...deps, instanceId }); workers.push(value); return value;
  }
  t.after(() => workers.forEach(value => value.stop()));
  function failTerminalWrites(count) {
    const original = fs.writeFileSync;
    let failures = 0;
    t.mock.method(fs, 'writeFileSync', function(file, contents, ...args) {
      if (typeof file === 'number' && typeof contents === 'string' &&
          ['succeeded', 'failed'].includes(JSON.parse(contents).state) && failures < count) {
        failures++;
        original.call(fs, file, contents.slice(0, 19), ...args);
        throw Object.assign(Error('Synthetic transient journal write failure'), { code: 'ENOSPC' });
      }
      return original.call(fs, file, contents, ...args);
    });
    return () => failures;
  }
  return { directory, journal, key, identity, otherIdentity, acknowledgements, calls, warnings,
    finish, worker, failTerminalWrites, get record() { return diskJournal(directory).read(key); },
    get claims() { return claims; }, setClaim: value => { claimResult = value; },
    blockClaim: value => { claimWait = value; },
    setOffline: value => { offline = value; }, setCurrent: value => { current = value; },
    switchDuringInbox: () => { switchDuringInbox = true; } };
}

for (const [result, state] of [[{ ok: true }, 'succeeded'], [{ ok: false }, 'failed']]) {
  test('a transient journal write preserves the completed ' + state + ' outcome for the next poll', async t => {
    const f = fixture(t), worker = f.worker();
    await worker.tick();
    const failures = f.failTerminalWrites(1);
    f.finish(result); await turn();
    assert.equal(failures(), 1);
    assert.equal(fs.statSync(path.join(f.directory, f.key + '.json.tmp')).size, 19);
    assert.equal(f.record.state, 'running');
    assert.deepEqual(f.acknowledgements.map(row => row.state), ['starting', 'running']);
    await worker.tick();
    assert.equal(f.record.state, state);
    assert.equal(f.acknowledgements.at(-1).state, state);
    if (state === 'failed') assert.match(f.record.error, /本轮执行未完成/);
    assert.deepEqual(f.calls, ['open', 'send']);
  });
}

test('consecutive persistence failures retain the same outcome without heartbeat overwrites or resubmission', async t => {
  const f = fixture(t), worker = f.worker();
  await worker.tick();
  const failures = f.failTerminalWrites(3);
  f.finish({ ok: true }); await turn();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await worker.tick()).state, 'error');
    assert.equal(f.record.state, 'running');
    assert.deepEqual(f.acknowledgements.map(row => row.state), ['starting', 'running']);
  }
  assert.equal(failures(), 3);
  await worker.tick();
  assert.equal(f.record.state, 'succeeded');
  assert.equal(f.acknowledgements.at(-1).state, 'succeeded');
  assert.deepEqual(f.calls, ['open', 'send']);
});

test('completion while a claim is in flight cannot become a new running acknowledgement', async t => {
  const f = fixture(t), worker = f.worker();
  await worker.tick();
  f.failTerminalWrites(1);
  let release;
  f.blockClaim(new Promise(resolve => { release = resolve; }));
  const polling = worker.tick();
  await turn();
  f.finish({ ok: true }); await turn();
  release(); await polling;
  assert.equal(f.record.state, 'succeeded');
  assert.deepEqual(f.acknowledgements.map(row => row.state), ['starting', 'running', 'succeeded']);
  assert.deepEqual(f.calls, ['open', 'send']);
});

test('a recovered durable receipt survives restart and retries only its original-owner acknowledgement', async t => {
  const f = fixture(t), worker = f.worker();
  await worker.tick();
  f.failTerminalWrites(1);
  f.finish({ ok: true }); await turn();
  f.setOffline(true);
  await worker.tick();
  assert.equal(f.record.state, 'succeeded');
  assert.equal(f.acknowledgements.at(-1).state, 'running');
  worker.stop(); f.setOffline(false);
  f.setClaim({ ok: true, observeOnly: true, state: 'running', conversationId: 'chat' });
  await f.worker('replacement').tick();
  assert.equal(f.acknowledgements.at(-1).state, 'succeeded');
  assert.equal(f.acknowledgements.at(-1).instanceId, 'original');
  assert.deepEqual(f.calls, ['open', 'send']);
});

test('restart before successful persistence remains ambiguous and never invents success or resends', async t => {
  const f = fixture(t), worker = f.worker();
  await worker.tick();
  f.failTerminalWrites(1);
  f.finish({ ok: true }); await turn();
  worker.stop();
  await f.worker('replacement').tick();
  assert.equal(f.record.state, 'failed');
  assert.match(f.record.error, /客户端执行被中断/);
  assert.equal(f.acknowledgements.at(-1).state, 'failed');
  assert.deepEqual(f.calls, ['open', 'send']);
});

test('pending completion does not overwrite a journal now owned by another worker', async t => {
  const f = fixture(t), worker = f.worker();
  await worker.tick();
  f.failTerminalWrites(1);
  f.finish({ ok: true }); await turn();
  const replaced = { ...f.record, workerId: 'replacement' };
  f.journal.write(f.key, replaced);
  const claims = f.claims, acks = f.acknowledgements.length;
  await worker.tick();
  assert.deepEqual(f.record, replaced);
  assert.equal(f.claims, claims);
  assert.equal(f.acknowledgements.length, acks);
  assert.deepEqual(f.calls, ['open', 'send']);
});

test('a worker replacement during claim retains its journal after the old completion write fails', async t => {
  const f = fixture(t), worker = f.worker();
  await worker.tick();
  f.failTerminalWrites(1);
  let release;
  f.blockClaim(new Promise(resolve => { release = resolve; }));
  const polling = worker.tick();
  await turn();
  f.finish({ ok: true }); await turn();
  const replacement = { phase: 'sending', state: 'running', workerId: 'replacement',
    conversationId: 'replacement-chat', error: 'replacement-owned marker' };
  f.journal.write(f.key, replacement);
  release(); await polling;
  assert.deepEqual(f.record, replacement);
  assert.deepEqual(f.calls, ['open', 'send']);
});

test('persisting a pending completion retains the original account check before acknowledgement', async t => {
  const f = fixture(t), worker = f.worker();
  await worker.tick();
  f.failTerminalWrites(1);
  f.finish({ ok: true }); await turn();
  f.switchDuringInbox();
  await worker.tick();
  assert.equal(f.record.state, 'succeeded');
  assert.deepEqual(f.acknowledgements.map(row => row.state), ['starting', 'running']);
  f.setCurrent(f.identity);
  await worker.tick();
  assert.equal(f.acknowledgements.at(-1).state, 'succeeded');
  assert.ok(f.acknowledgements.every(row => row.owner === f.identity));
  assert.deepEqual(f.calls, ['open', 'send']);
});
