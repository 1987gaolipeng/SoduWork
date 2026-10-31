'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const skills = require('../main/pi-session/skill-turn');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const rules = require('../main/access-control/policy');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 500; i++) { if (check()) return; await delay(10); } throw Error('fixture timeout'); }
function skill(root, name, directory = name) {
  const dir = path.join(root, directory); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  Trusted fixture ${name}\n  with multiline description\n---\nSELECTED_${name}_CONTENT\n`);
  return { name, path: dir, installed: true };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function identity(uid = 'owner', hub = 'https://fixture.invalid') {
  const now = Math.floor(Date.now() / 1000);
  return { hub, clientId: 'fixture-device', session: Buffer.from(JSON.stringify({
    typ: 'device', uid, cid: 'fixture-device', iat: now, exp: now + 3600,
  })).toString('base64url') + '.' + '0'.repeat(64) };
}

test('turn skill names are copied independently and renderer paths/objects are rejected', () => {
  const input = ['alpha', 'alpha', 'beta'];
  assert.deepEqual(skills.names(input), ['alpha', 'beta']);
  for (const value of ['alpha', [{ name: 'alpha', path: 'C:/secret' }], ['../alpha'], ['C:/alpha'], ['alpha\nexecute'], Array(21).fill('alpha')])
    assert.throws(() => skills.names(value));
  const queue = createTurnQueue(), item = queue.add({ text: '#alpha', options: { skills: input } });
  input.splice(0, 3, 'other'); assert.deepEqual(item.options.skills, ['alpha', 'alpha', 'beta']);
});

test('trusted resolver freshly checks policy and synchronizes only selected, permitted skills', async () => {
  const owner = identity(), calls = [];
  const resolve = skills.resolver({ identity: owner, identityOf: async () => owner, skillDirs: () => ['local'],
    fetchPolicy: async (...args) => { calls.push(args); return { ok: true, skills: [{ name: 'alpha' }, { name: 'beta' }], enabled: ['beta'] }; },
    ensure: async args => { calls.push(args); return { ok: true, contracts: [{ name: 'alpha', path: '/trusted/alpha', installed: true }] }; },
  });
  assert.equal((await resolve(['alpha'])).items[0].name, 'alpha');
  assert.equal(calls[0][3], true, 'authorization cache is bypassed at execution');
  assert.equal(calls[0][1], undefined, 'skill execution uses the shared policy deadline');
  assert.deepEqual(calls[1].policy.enabled, []); assert.deepEqual(calls[1].names, ['alpha']);
  assert.deepEqual(calls[1].localDirs, ['local']);
  await resolve(['alpha']); assert.equal(calls.length, 4, 'each queued turn rechecks');
});

test('unknown/revoked/uninstalled skills, failed sync and account/server switches fail before execution', async () => {
  for (const mode of ['unknown', 'revoked', 'uninstalled', 'sync-failed', 'policy-failed', 'account', 'server', 'during-sync']) {
    const owner = identity(); let current = owner, synced = 0;
    const resolve = skills.resolver({ identity: owner, identityOf: async () => current, skillDirs: () => [],
      fetchPolicy: async () => ({ ok: mode !== 'policy-failed', skills: mode === 'unknown' ? [] : [{ name: 'alpha' }], revoked: mode === 'revoked' ? ['alpha'] : [] }),
      ensure: async () => { synced++; if (mode === 'during-sync') current = identity('other');
        return { ok: mode !== 'sync-failed', contracts: [{ name: 'alpha', installed: mode !== 'uninstalled', path: '/trusted/alpha' }] }; },
    });
    if (mode === 'account') current = identity('other');
    if (mode === 'server') current = identity('owner', 'https://other.invalid');
    await assert.rejects(resolve(['alpha']), undefined, mode);
    if (['unknown', 'revoked', 'policy-failed', 'account', 'server'].includes(mode)) assert.equal(synced, 0, mode);
  }
});

test('SDK loading validates exact names and scopes only trusted package resources', async t => {
  const root = temporary(t), alpha = skill(root, 'alpha');
  fs.writeFileSync(path.join(alpha.path, '.env'), 'SYNTHETIC_PRIVATE');
  const prepared = await skills.prepare({ cwd: root, resolveSkills: async () => ({ items: [alpha] }) }, { skills: ['alpha'] });
  assert.equal(prepared.ok, true, prepared.reason); assert.match(prepared.skills[0].description, /with multiline/);
  const policy = rules.create('standard', path.join(root, 'workspace'));
  const op = (tool, file) => rules.operation(policy, tool, { path: file }, policy.cwd, prepared.readScope);
  assert.equal(op('read', path.join(alpha.path, 'SKILL.md')).verdict, 'allow');
  assert.equal(op('read', path.join(alpha.path, '.env')).verdict, 'ask');
  assert.equal(op('write', path.join(alpha.path, 'SKILL.md')).verdict, 'ask');
  fs.writeFileSync(path.join(alpha.path, 'SKILL.md'), '---\nname: other\ndescription: Other\n---\n');
  const mismatch = await skills.prepare({ cwd: root, resolveSkills: async () => ({ items: [alpha] }) }, { skills: ['alpha'] });
  assert.equal(mismatch.failureKind, 'skill-selection'); assert.equal(mismatch.retrySafe, true);
  fs.unlinkSync(path.join(alpha.path, 'SKILL.md'));
  assert.equal((await skills.prepare({ cwd: root, resolveSkills: async () => ({ items: [alpha] }) }, { skills: ['alpha'] })).ok, false);
});

test('non-Pi preparation authorizes in main and sends only trusted skill metadata to the worker', async () => {
  const app = {}, cwd = path.resolve('/isolated-workspace'), calls = [];
  const selected = ['alpha'];
  const result = { ok: true, names: ['alpha'], dirs: ['/trusted/alpha'], skills: [{ name: 'alpha', baseDir: '/trusted/alpha' }], prompt: 'guide' };
  const runtime = { async prepareSkills(...args) { calls.push(args); return result; } };
  const prepared = await skills.prepareRunner({ app, cwd,
    resolveSkills: async names => { assert.deepEqual(names, ['alpha']); return { items: [{ name: 'alpha', path: '/trusted/alpha', ignored: 'private' }] }; } },
  { skills: selected, skillDirs: ['/untrusted'], instructions: 'untrusted' }, runtime);
  assert.equal(prepared, result);
  assert.equal(calls[0][0], app);
  assert.deepEqual(calls[0][1], { cwd, names: ['alpha'], items: [{ name: 'alpha', path: path.resolve('/trusted/alpha') }] });
  const missing = await skills.prepareRunner({ app, cwd, resolveSkills: async () => ({ items: [] }) }, { skills: ['alpha'] }, runtime);
  assert.equal(missing.failureKind, 'skill-selection');
  const revoked = await skills.prepareRunner({ app, cwd, resolveSkills: async () => { throw Error('revoked'); } }, { skills: ['alpha'] }, runtime);
  assert.equal(revoked.retrySafe, true);
  assert.equal(calls.length, 1, 'failed authorization must never enter the worker');
  assert.deepEqual(await skills.prepareRunner({}, {}, runtime), { ok: true, names: [], dirs: [], skills: [], prompt: '' });
});

test('production IPC captures only valid names and publishes a recoverable skill failure with preserved queue', async t => {
  const root = temporary(t), ipcPath = require.resolve('../main/pi-session/ipc');
  const source = fs.readFileSync(ipcPath, 'utf8'), sent = [], events = [];
  const snapshot = { execution: { queue: [{ id: 'later', text: 'retained later request' }] } };
  const handle = { cwd: root, sessionId: 'fixture', snapshot: () => snapshot,
    submit(text, files, options) { sent.push({ text, files, options }); return { accepted: true, completion: Promise.resolve(skills.failure(Error('revoked'))) }; } };
  const context = { require: createRequire(ipcPath), path, app: { getPath: () => root }, BrowserWindow: {},
    _uiWindow: require('../main/pi-session/ui-window').create(),
    _cloudHandoff: { guard: () => null },
    updateWorkloads: { guard: () => ({ ok: true }) }, session: { get: () => handle },
    sendIdentityOf: async () => ({}), memories: { assertOwner() {} }, pluginDebug: { guard: () => null },
    attachments: { stage: async () => ({ files: [], warnings: [] }) }, workDir: () => root,
    _contextSnapshot: (value, current) => require('../main/conversation/requirement-context')
      .decorate({ getPath: () => root }, current || value.snapshot()),
    _publish: (_windows, _handle, event, current) => events.push({ event, current }), _scheduleRelease() {} };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function sendConversation('), source.indexOf("  ipcMain.handle('pi-session-send'")) + '\nglobalThis.send = sendConversation;', context);
  const input = ['alpha'];
  assert.equal((await context.send('ref', '#alpha', [], { skills: input, skillDirs: ['C:/malicious'], context: 'untrusted', submissionId: 'one' })).ok, true);
  input[0] = 'beta'; await delay(0);
  assert.deepEqual(Array.from(sent[0].options.skills), ['alpha']);
  assert.equal(sent[0].options.skillDirs, undefined); assert.equal(sent[0].options.context, undefined);
  assert.equal(events[0].event.failureKind, 'skill-selection'); assert.equal(events[0].event.retrySafe, true);
  assert.equal(events[0].event.submissionId, 'one'); assert.equal(events[0].current, snapshot);
  assert.equal((await context.send('ref', '#bad', [], { skills: [{ name: 'alpha', path: '/bad' }] })).failureKind, 'skill-selection');
  assert.equal(sent.length, 1);
});

test('real Pi turn loads new skills without altering base skills, tool policy, model or subsequent turns', { timeout: 30000 }, async t => {
  const root = temporary(t), base = skill(root, 'base'), added = skill(root, 'added');
  const fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(() => fixture.close());
  let calls = 0, release;
  const handle = await fixture.open({ skillDirs: [base.path], accessPolicy: rules.create('standard', fixture.cwd),
    resolveSkills: async names => { calls++; assert.deepEqual(names, ['added']); return { items: [added] }; } });
  const policy = handle.snapshot().accessPolicy, firstModel = handle.snapshot().model;
  fixture.reply((_body, n) => n === 1 ? new Promise(resolve => { release = () => resolve({ text: 'First complete.' }); })
    : _body.messages.at(-1).role === 'tool' ? { text: 'Selected guide read successfully.' }
      : { tool: 'read', args: { path: path.join(added.path, 'SKILL.md') } });
  const first = handle.submit('Plain first turn', []); await until(() => release);
  const selected = ['added'], second = handle.submit('#added Read its guide', [], { skills: selected });
  selected[0] = 'bad'; assert.equal(second.queued, true); assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(fixture.requests[0].messages[0]), /<name>added<\/name>/);
  release(); assert.equal((await first.completion).ok, true);
  assert.equal((await second.completion).ok, true); assert.equal(calls, 1);
  assert.deepEqual(handle.snapshot().messages.filter(row => row.role === 'user').map(row => row.text),
    ['Create an isolated report', 'Plain first turn', '#added Read its guide']);
  const request = fixture.requests[1];
  assert.match(JSON.stringify(request.messages[0]), /<name>base<\/name>/);
  assert.match(JSON.stringify(request.messages[0]), /<name>added<\/name>/);
  assert.match(JSON.stringify(fixture.requests.at(-1).messages), /SELECTED_added_CONTENT/);
  assert.deepEqual(handle.snapshot().accessPolicy, policy); assert.deepEqual(handle.snapshot().model, firstModel);
  assert.deepEqual(request.tools.map(row => row.function.name), fixture.requests[0].tools.map(row => row.function.name));
  assert.equal(fs.existsSync(fixture.loaded), false, 'standard mode never loads the fixture extension');
  assert.equal(handle.snapshot().pendingRequests?.length || 0, 0);
  fixture.reply(() => ({ text: 'Plain follow-up complete.' }));
  assert.equal((await handle.submit('Plain following turn', []).completion).ok, true);
  assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1).messages[0]), /<name>added<\/name>/);
  assert.match(JSON.stringify(fixture.requests.at(-1).messages[0]), /<name>base<\/name>/);
  assert.equal(calls, 1);
});

test('real Pi revoked queued skill sends no model request and preserves later input and attachments', { timeout: 30000 }, async t => {
  const root = temporary(t), fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(() => fixture.close());
  let release, resolutions = 0, revoked = true;
  const selected = skill(root, 'revoked');
  const handle = await fixture.open({ resolveSkills: async () => { resolutions++; if (revoked) throw Error('技能已撤回'); return { items: [selected] }; } });
  fixture.reply(() => new Promise(resolve => { release = () => resolve({ text: 'First complete.' }); }));
  const first = handle.submit('First', []); await until(() => release);
  const denied = handle.submit('#revoked Do not silently omit', [], { skills: ['revoked'] });
  const file = path.join(fixture.cwd, 'retained.txt'); fs.writeFileSync(file, 'retain');
  const later = handle.submit('Later original input', [{ path: file, name: 'retained.txt' }]);
  assert.equal(resolutions, 0); release(); await first.completion;
  const result = await denied.completion;
  assert.equal(result.failureKind, 'skill-selection'); assert.equal(result.retrySafe, true);
  assert.equal(fixture.requests.length, 1);
  const snap = handle.snapshot();
  assert.equal(snap.execution.turnQueue.paused, true);
  assert.equal(snap.status, 'unreachable'); assert.match(snap.statusText, /技能已撤回/);
  await delay(20); assert.equal(handle.uiSnapshot().statusText, snap.statusText, 'later projection preserves the specific preparation error');
  assert.deepEqual(snap.execution.queue.map(row => ({ id: row.id, text: row.text, files: row.attachments })),
    [{ id: later.queueId, text: 'Later original input', files: ['retained.txt'] }]);
  revoked = false; fixture.reply(() => ({ text: 'Recovered work complete.' }));
  const retry = handle.submit('#revoked Do not silently omit', [], { skills: ['revoked'] });
  assert.equal(retry.queued, false, 'explicit resend starts without a separate resume-queue action');
  assert.equal((await retry.completion).ok, true); assert.equal((await later.completion).ok, true);
  assert.equal(fixture.requests.length, 3); assert.equal(handle.snapshot().status, 'idle');
  assert.match(JSON.stringify(fixture.requests.at(-1).messages), /soduwork-material-context/);
  assert.match(JSON.stringify(fixture.requests.at(-1).messages), /retain/);
  assert.deepEqual(handle.snapshot().messages.filter(row => row.role === 'user').map(row => row.text),
    ['Create an isolated report', 'First', '#revoked Do not silently omit', 'Later original input']);
});
