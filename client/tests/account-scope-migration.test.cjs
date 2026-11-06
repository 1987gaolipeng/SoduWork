'use strict';
// Recognize legacy environment-bound fingerprints during same-account migration.
// Converge local data to account scope while retaining cross-account isolation.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const memory = require('../main/conversation/session-memory');
const localMemory = require('../main/conversation/local-memory');
const requirement = require('../main/conversation/requirement-context');
const runtime = require('../main/platform-connections/runtime.cjs');
const deviceAuth = require('../main/device-auth');
const { sessions, identity } = require('./helpers/platform-session-fixture.cjs');

const OLD = { hub: 'http://192.0.2.149:8989', clientId: 'soduwork-olddddd0000000000000' };
const legacyOwner = identityArg => runtime.legacyScope(OLD.hub, OLD.clientId, identityArg);
const previousAccountOwner = uid => crypto.createHash('sha256').update('sodo-account\0' + uid).digest('hex').slice(0, 32);

test('pre-rename account ownership requires the same valid account and never changes new writes', () => {
  const stored = previousAccountOwner('one');
  assert.equal(runtime.scopeMatches(stored, migratedIdentity(), []), true);
  assert.equal(runtime.scopeMatches(stored, identity('two'), [OLD]), false);
  for (const session of [sessions().expired, sessions().future, sessions().wrongType, sessions().missingUid, 'invalid']) {
    assert.equal(runtime.scopeMatches(stored, { ...identity(), session }, [OLD]), false);
  }
  assert.notEqual(runtime.scope(identity()), stored);
  assert.notEqual(runtime.connectionScope(identity()), stored);
});

test('pre-rename memory ownership converges without enrollment history', t => {
  const f = bindingFixture(t), id = 'pre-rename-memory', oldOwner = previousAccountOwner('one');
  const dir = path.join(f.root, 'session-memory-bindings');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, crypto.createHash('sha256').update(id).digest('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify({ owner: oldOwner, ids: [] }));
  withProfiles([], () => assert.deepEqual(memory.binding(f.app, id, migratedIdentity()), []));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, runtime.scope(migratedIdentity()));
});

function migratedIdentity() {
  // Keep account UID constant while changing Hub address and device registration.
  return { hub: 'http://127.0.0.1:18989', clientId: 'device-two', session: sessions().otherDevice };
}

test('scope binds the account only: same uid across hubs/devices keeps one fingerprint', () => {
  const base = runtime.scope({ ...identity('one'), hub: 'https://fixture.invalid', clientId: 'device' });
  assert.equal(base, runtime.scope(migratedIdentity()));
  assert.notEqual(base, runtime.scope(identity('two')));
  assert.match(base, /^[a-f0-9]{32}$/);
  assert.notEqual(base, legacyOwner(identity('one')), '新公式与旧公式必须不同');
});

test('scopeMatches recognizes legacy fingerprints from local device profiles', () => {
  const stored = legacyOwner(identity('one'));
  assert.equal(runtime.scopeMatches(stored, identity('one'), [OLD]), true);
  assert.equal(runtime.scopeMatches(stored, identity('one'), []), false, '没有旧档案时不能凭空认领');
  assert.equal(runtime.scopeMatches(stored, identity('two'), [OLD]), false, '跨账号依旧拒绝');
  assert.equal(runtime.scopeMatches(stored, { ...identity('one'), session: sessions().expired }, [OLD]), false,
    '会话过期时不得放行');
  assert.equal(runtime.scopeMatches('not-a-hash', identity('one'), [OLD]), false);
});

function bindingFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-scope-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  // requirement-context canonicalizes Windows paths to lower case.  Keep the
  // fixture in that same representation so the test exercises migration,
  // rather than platform-specific path casing.
  const cwd = process.platform === 'win32' ? fs.realpathSync(root).toLowerCase() : fs.realpathSync(root);
  return { app, root, cwd };
}

function withProfiles(list, run) {
  const original = deviceAuth.profiles;
  deviceAuth.profiles = () => list;
  try { return run(); } finally { deviceAuth.profiles = original; }
}

test('binding opens and converges a legacy-owned conversation after an account migration', t => {
  const f = bindingFixture(t);
  const oldOwner = legacyOwner(identity('one'));
  memory.bind(f.app, 'chat-migrate', identity('one'), ['memory-one']);
  const file = path.join(f.root, 'session-memory-bindings',
    crypto.createHash('sha256').update('chat-migrate').digest('hex') + '.json');
  // Construct a legacy Hub, device, and account fingerprint.
  fs.writeFileSync(file, JSON.stringify({ owner: oldOwner, ids: ['memory-one'] }), { mode: 0o600 });
  // Memory entry from the previous ownership scope.
  const imports = path.join(f.root, 'memory', 'accounts', oldOwner, 'imports');
  fs.mkdirSync(imports, { recursive: true });
  fs.writeFileSync(path.join(imports, 'memory-one.json'), JSON.stringify({ id: 'memory-one' }), { mode: 0o600 });
  const targetImports = path.join(f.root, 'memory', 'accounts', runtime.scope(migratedIdentity()), 'imports');
  fs.mkdirSync(targetImports, { recursive: true });
  fs.writeFileSync(path.join(targetImports, 'memory-existing.json'), JSON.stringify({ id: 'memory-existing' }), { mode: 0o600 });

  withProfiles([OLD], () => {
    assert.deepEqual(memory.binding(f.app, 'chat-migrate', migratedIdentity()), ['memory-one'],
      '同账号换环境必须放行');
  });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.owner, runtime.scope(migratedIdentity()), '绑定文件已收敛为新指纹');
  assert.equal(stored.ids.join(','), 'memory-one');
  assert.ok(fs.existsSync(path.join(f.root, 'memory', 'accounts', runtime.scope(migratedIdentity()),
    'imports', 'memory-one.json')), '记忆条目随指纹迁移');
  assert.ok(fs.existsSync(path.join(targetImports, 'memory-existing.json')), 'existing destination memory is preserved');
  assert.equal(fs.existsSync(path.join(f.root, 'memory', 'accounts', oldOwner)), false,
    '旧目录收敛后应清空移除');
  // After migration, open directly without legacy enrollment candidates.
  withProfiles([], () => assert.deepEqual(memory.binding(f.app, 'chat-migrate', migratedIdentity()), ['memory-one']));
});

test('cross-account bindings stay blocked even when environments change', t => {
  const f = bindingFixture(t);
  const foreign = { hub: 'https://other.invalid', clientId: 'device', session: sessions().two };
  memory.bind(f.app, 'chat-other', foreign, ['memory-two']);
  withProfiles([OLD, { hub: 'https://other.invalid', clientId: 'device' }], () => {
    assert.throws(() => memory.binding(f.app, 'chat-other', identity('one')), /另一个账号或服务/);
    assert.throws(() => memory.binding(f.app, 'chat-other', migratedIdentity()), /另一个账号或服务/);
  });
});

test('requirement ownership converges legacy records for the same account', t => {
  const f = bindingFixture(t);
  const oldOwner = legacyOwner(identity('one'));
  const dir = path.join(f.root, 'requirement-session-context');
  fs.mkdirSync(dir, { recursive: true });
  const record = { version: 1, owner: oldOwner, cwd: f.cwd, projectId: 'p1', repoId: '', adapterId: 'pi' };
  const file = path.join(dir, crypto.createHash('sha256').update('req-1').digest('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  const handle = { sessionId: 'req-1', cwd: f.cwd, adapterId: 'pi',
    usageIdentity: { hub: OLD.hub, clientId: OLD.clientId } };
  withProfiles([OLD], () => {
    const result = requirement.assertOwner(f.app, handle, migratedIdentity());
    assert.equal(result.owner, runtime.scope(migratedIdentity()));
    assert.deepEqual(handle.requirementContext, { projectId: 'p1', repoId: '' });
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, runtime.scope(migratedIdentity()),
    '需求记录已收敛为新指纹');
  withProfiles([OLD], () => {
    assert.throws(() => requirement.assertOwner(f.app,
      { ...handle, cwd: path.join(f.root, 'elsewhere') }, migratedIdentity()), /工作目录/);
  });
});
