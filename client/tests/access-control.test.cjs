const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../main/access-control/policy');
const { create } = require('../main/access-control/broker');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('versioned access does not upgrade historical full; strict modes and real workspace', () => {
  assert.equal(policy.normalize(undefined), null);
  assert.throws(() => policy.normalize({ mode: 'full' }));
  const root = os.tmpdir(), p = policy.create('standard', root);
  assert.equal(policy.operation(p, 'write', { path: 'report.txt' }).verdict, 'allow');
  assert.equal(policy.operation(p, 'write', { path: '../outside.txt' }).verdict, 'ask');
  assert.equal(policy.operation(p, 'write', { path: '.git/config' }).verdict, 'ask');
  assert.equal(policy.operation(p, 'bash', { command: 'echo ok' }).verdict, 'ask');
  assert.equal(policy.operation(policy.create('readonly', root), 'write', { path: 'report.txt' }).verdict, 'deny');
});
test('approval binds revision, exact arguments and session; rejects replay; cancellation denies', async () => {
  const p = policy.create('standard', os.tmpdir()), b = create({ policy: p });
  const operation = policy.operation(p, 'bash', { command: 'echo hello' });
  const waiting = b.authorize(operation); const r = b.pending()[0];
  assert.equal(b.answer({ ...r, policyRevision: 2, decision: 'once' }).ok, false);
  assert.equal(b.answer({ ...r, decision: 'session' }).ok, true);
  assert.equal(await waiting, true);
  assert.equal(b.answer({ ...r, decision: 'once' }).ok, false);
  assert.equal(await b.authorize(operation), true);
  const different = b.authorize(policy.operation(p, 'bash', { command: 'echo different' }));
  assert.equal(b.pending().length, 1); b.cancel(); assert.equal(await different, false);
  const other = create({ policy: p }); const pending = other.authorize(operation); other.close(); assert.equal(await pending, false);
  b.close();
});
test('aborted and timed out approvals cannot start work', async () => {
  const p = policy.create('standard', os.tmpdir()), b = create({ policy: p, timeoutMs: 20 });
  const op = policy.operation(p, 'bash', { command: 'echo hello' });
  const controller = new AbortController(), a = b.authorize(op, controller.signal); controller.abort(); assert.equal(await a, false);
  b.beginTurn();
  const expired = b.authorize(op); const req = b.pending()[0]; await delay(35); assert.equal(await expired, false);
  assert.equal(b.answer({ ...req, decision: 'once' }).ok, false); b.close();
});
test('real Pi SDK + local HTTP: ordinary write, denied escape, approved escape, next turn', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-sdk-'));
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root);
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await fixture.send('write', { path: 'inside.txt', content: 'ordinary' });
  assert.equal(fs.readFileSync(path.join(fixture.workspace, 'inside.txt'), 'utf8'), 'ordinary');
  const outside = path.join(root, 'outside.txt');
  let turn = fixture.send('write', { path: outside, content: 'denied' });
  for (let n = 0; !fixture.access.broker.pending().length && n < 200; n++) await delay(10);
  let req = fixture.access.broker.pending()[0]; assert.ok(req); assert.equal(fs.existsSync(outside), false);
  fixture.access.broker.answer({ ...req, decision: 'deny' }); await turn; assert.equal(fs.existsSync(outside), false);
  turn = fixture.send('write', { path: outside, content: 'approved' });
  for (let n = 0; !fixture.access.broker.pending().length && n < 200; n++) await delay(10);
  req = fixture.access.broker.pending()[0]; assert.ok(req); fixture.access.broker.answer({ ...req, decision: 'once' }); await turn;
  assert.equal(fs.readFileSync(outside, 'utf8'), 'approved');
  await fixture.send('write', { path: 'next.txt', content: 'continued' });
  assert.equal(fs.readFileSync(path.join(fixture.workspace, 'next.txt'), 'utf8'), 'continued');
});
test('real SDK enforces readonly, full access and unchanged legacy execution', { timeout: 30000 }, async () => {
  for (const mode of ['readonly', 'full', null]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-modes-'));
    const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root, mode);
    try {
      const target = path.join(root, 'outside.txt');
      await fixture.send('write', { path: target, content: 'mode-test' });
      assert.equal(fs.existsSync(target), mode !== 'readonly');
      assert.equal(fixture.access?.broker.pending().length || 0, 0);
      await fixture.send('read', { path: path.join(fixture.workspace, 'nonexistent.txt') });
      assert.equal(fixture.access?.broker.pending().length || 0, 0);
    } finally { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test('symlink target is rechecked after consent before the native tool can execute', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-access-links-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,'work'), a=path.join(root,'a'), b=path.join(root,'b'), link=path.join(workspace,'link');
  [workspace,a,b].forEach(p=>fs.mkdirSync(p));fs.symlinkSync(a,link,'junction');
  const session={agent:{beforeToolCall:async()=>undefined}};
  const access=require('../main/access-control/pi').install(session,policy.create('standard',workspace),workspace,()=>{});
  const promise=session.agent.beforeToolCall({toolCall:{name:'write'},args:{path:path.join(link,'x.txt'),content:'test'}});
  await delay(0);const request=access.broker.pending()[0];assert.ok(request);
  fs.unlinkSync(link);fs.symlinkSync(b,link,'junction');access.broker.answer({...request,decision:'once'});
  assert.equal((await promise).block,true);access.broker.close();
});
