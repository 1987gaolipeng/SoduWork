'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const rules = require('../main/access-control/policy');
const relay = require('../main/personal-plugin-access-relay.cjs');
function setup(t, options = {}) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-relay-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let parent = rules.create(options.mode || 'standard', cwd), child = parent;
  let listener = () => {}, stopped = 0, checks = 0, owner = true;
  const changes = [], committed = [];
  const subject = relay.create({
    handle: { on(cb) { listener = cb; return () => { listener = () => {}; }; } },
    readPolicy: () => parent, initialPolicy: options.resume ? null : child,
    readChild: async () => ({ accessPolicy: options.wrongChildRoot ? { ...child, workspaceRoot: path.dirname(cwd) } : child, status: 'running' }),
    apply: async (policy, revision) => {
      changes.push({ policy, revision });
      assert.equal(policy.revision, child.revision + 1);
      assert.equal(revision, child.revision);
      assert.equal(policy.workspaceRoot, cwd);
      if (options.apply) return options.apply(policy, revision);
      child = policy; return { ok: true, effective: 'current-turn', accessPolicy: child };
    },
    checkOwner: async () => { checks++; if (!owner) throw Error('private account changed'); },
    stop: async () => { stopped++; if (options.stopFail) throw Error('private network detail'); },
    committed: (policy, revision) => committed.push({ policy, revision }),
  });
  return { subject, changes, committed, cwd, checks: () => checks, stops: () => stopped,
    set(mode, skip = 0) { parent = { ...rules.next(mode, cwd, parent, parent.revision), revision: parent.revision + skip + 1 }; },
    emit: () => listener({ kind: 'permission' }), ownerChanged: () => { owner = false; },
    child: () => child, corruptParentRoot: () => { parent = { ...parent, workspaceRoot: path.dirname(cwd) }; } };
}
test('a running node inherits standard/full/readonly changes with child-scoped monotonic revisions', async t => {
  const f = setup(t);
  await f.subject.sync();
  assert.equal(f.changes.length, 0);
  for (const mode of ['full', 'readonly', 'standard']) { f.set(mode); await f.subject.sync(); }
  assert.deepEqual(f.changes.map(x => x.policy.mode), ['full', 'readonly', 'standard']);
  assert.deepEqual(f.changes.map(x => x.policy.revision), [2, 3, 4]);
  assert.deepEqual(f.committed.map(x => x.revision), [2, 3, 4]);
  assert.equal(f.stops(), 0);
  await f.subject.close();
  f.set('full'); f.emit(); await f.subject.sync();
  assert.equal(f.changes.length, 3, 'settled nodes cannot be changed by a later parent event');
});
test('rapid selections coalesce to the latest mode without replaying an obsolete full grant', async t => {
  const f = setup(t);
  f.set('full'); f.emit(); f.set('readonly'); f.emit();
  await f.subject.sync();
  assert.deepEqual(f.changes.map(x => x.policy.mode), ['readonly']);
  assert.equal(f.changes[0].policy.revision, 2);
  assert.equal(f.committed[0].revision, 3, 'keep the corresponding parent revision separately');
  await f.subject.close();
});
test('resuming under the same mode checks actual child state without rewriting revisions', async t => {
  const f = setup(t, { resume: true, mode: 'full' });
  await f.subject.sync();
  assert.equal(f.changes.length, 0);
  assert.equal(f.checks(), 3);
  assert.equal(f.committed[0].policy.revision, 1);
  await f.subject.close();
});
test('a changed account stops the child without applying another account permission', async t => {
  const f = setup(t); f.ownerChanged(); f.set('full');
  await assert.rejects(f.subject.sync(), /未能同步会话访问权限/);
  assert.equal(f.changes.length, 0);
  assert.equal(f.stops(), 1);
  assert.doesNotMatch(f.subject.error().message, /private/);
  await f.subject.close();
});
test('rejected, deferred or mismatched permission ACKs stop rather than continue with old access', async t => {
  for (const variant of ['denied', 'next-turn', 'wrong-mode', 'wrong-revision', 'wrong-root']) {
    await t.test(variant, async t => {
      const f = setup(t, { mode: 'full', apply: async policy => {
        if (variant === 'denied') return { ok: false, reason: 'private token' };
        return { ok: true, effective: variant === 'next-turn' ? 'next-turn' : 'current-turn',
          accessPolicy: { ...policy, ...(variant === 'wrong-mode' ? { mode: 'full' } : {}),
            ...(variant === 'wrong-revision' ? { revision: policy.revision + 1 } : {}),
            ...(variant === 'wrong-root' ? { workspaceRoot: path.dirname(policy.workspaceRoot) } : {}) } };
      } });
      f.set('readonly'); await assert.rejects(f.subject.sync(), /已请求停止/);
      assert.equal(f.stops(), 1); assert.equal(f.committed.length, 0);
      await assert.rejects(f.subject.sync(), /已请求停止/);
      assert.equal(f.changes.length, 1, 'failure cannot silently retry or redispatch a tool');
      await f.subject.close();
    });
  }
});
test('unconfirmed stop remains explicitly unresolved without leaking transport details', async t => {
  const f = setup(t, { stopFail: true, apply: async () => { throw Error('private network body'); } });
  f.set('full'); await assert.rejects(f.subject.sync(), /尚未确认停止/);
  assert.doesNotMatch(f.subject.error().message, /private/);
  await f.subject.close();
});

test('restored child and later parent snapshots cannot move the node permission workspace', async t => {
  for (const changed of ['child', 'parent']) {
    await t.test(changed, async t => {
      const f = setup(t, { resume: changed === 'child', wrongChildRoot: changed === 'child' });
      if (changed === 'parent') { f.set('full'); f.corruptParentRoot(); }
      await assert.rejects(f.subject.sync(), /未能同步会话访问权限/);
      assert.equal(f.changes.length, 0);
      assert.equal(f.stops(), 1);
      await f.subject.close();
    });
  }
});
