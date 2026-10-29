'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const rules = require('../main/access-control/policy');
const scopes = require('../main/access-control/resource-read-scope');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'workspace'); fs.mkdirSync(work);
  function skill(name) {
    const directory = path.join(root, '.agents', 'skills', name);
    fs.mkdirSync(path.join(directory, 'references'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\nRead references/guide.md.\n`);
    fs.writeFileSync(path.join(directory, 'references', 'guide.md'), 'LOADED_SKILL_REFERENCE');
    fs.writeFileSync(path.join(directory, 'scripts', 'check.cjs'), 'throw Error("must not execute");');
    fs.writeFileSync(path.join(directory, '.env'), 'PRIVATE_CREDENTIAL');
    fs.writeFileSync(path.join(directory, 'auth.json'), '{"fixture":"PRIVATE_AUTH"}');
    return directory;
  }
  const active = skill('active'), inactive = skill('inactive');
  const scope = scopes.fromSkills([{ filePath: path.join(active, 'SKILL.md') }]);
  const policy = rules.create('standard', work);
  const operation = (name, args, mode = 'standard', readScope = scope) =>
    rules.operation({ ...policy, mode }, name, args, work, readScope);
  return { root, work, active, inactive, scope, policy, operation };
}

test('only loaded skill packages are readable outside the workspace; execution and writes still require consent', t => {
  const f = fixture(t);
  for (const mode of ['standard', 'readonly']) {
    for (const file of ['SKILL.md', 'references/guide.md', 'scripts/check.cjs']) {
      assert.equal(f.operation('read', { path: path.join(f.active, file) }, mode).verdict, 'allow');
    }
    for (const file of [path.join(f.inactive, 'SKILL.md'), path.join(f.active, '.env'), path.join(f.active, 'auth.json'),
      path.join(f.active, '..', '..', 'auth.json'), path.join(f.active, 'references', '..', '..', 'inactive', 'SKILL.md')]) {
      assert.equal(f.operation('read', { path: file }, mode).verdict, 'ask', file);
    }
    assert.equal(f.operation('edit', { path: path.join(f.active, 'references/guide.md') }, mode).verdict,
      mode === 'readonly' ? 'deny' : 'ask');
  }
  assert.equal(f.operation('bash', { command: 'node "' + path.join(f.active, 'scripts/check.cjs') + '"' }).verdict, 'ask');
  const injected = rules.normalize({ ...f.policy, readRoots: [f.inactive], skillDirs: [f.inactive] });
  assert.equal(rules.operation(injected, 'read', { path: path.join(f.inactive, 'SKILL.md') }).verdict, 'ask');
  assert.equal(f.operation('read', { path: path.join(f.inactive, 'SKILL.md') }, 'full').verdict, 'allow');
  const protectedRead = f.operation('read', { path: path.join(f.active, '.env') });
  assert.equal(rules.current(f.policy, protectedRead, f.work, f.scope), true,
    'an explicit approval may still authorize an unchanged protected path');
});

test('package links cannot escape or retarget a previously granted skill, and revocation takes effect', t => {
  const f = fixture(t), alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.inactive, path.join(f.active, 'escape'), 'junction');
  assert.equal(f.operation('read', { path: path.join(f.active, 'escape/SKILL.md') }).verdict, 'ask');
  fs.symlinkSync(f.active, alias, 'junction');
  const scope = scopes.fromSkills([{ filePath: path.join(alias, 'SKILL.md') }]);
  const operation = f.operation('read', { path: path.join(alias, 'SKILL.md') }, 'standard', scope);
  assert.equal(operation.verdict, 'allow');
  fs.unlinkSync(alias); fs.symlinkSync(f.inactive, alias, 'junction');
  assert.equal(f.operation('read', { path: path.join(alias, 'SKILL.md') }, 'standard', scope).verdict, 'ask');
  assert.equal(rules.current(f.policy, operation, f.work, scope), false);
  const original = f.operation('read', { path: path.join(f.active, 'SKILL.md') });
  assert.equal(rules.current(f.policy, original, f.work, scopes.create()), false);
});

test('safe literal queries may read the exact package without authorizing scripts, secrets or mixed escapes', t => {
  const f = fixture(t), quote = p => '"' + p.replaceAll('\\', '/') + '"';
  const command = 'cat ' + quote(path.join(f.active, 'SKILL.md'));
  const operation = f.operation('bash', { command });
  assert.equal(operation.verdict, 'allow');
  assert.equal(rules.current(f.policy, operation, f.work, scopes.create()), false);
  for (const cmd of [command + ' ' + quote(path.join(f.inactive, 'SKILL.md')),
    'cat ' + quote(path.join(f.active, '.env')), command + ' && echo injected',
    'python ' + quote(path.join(f.active, 'scripts/check.cjs'))]) {
    assert.equal(f.operation('bash', { command: cmd }).verdict, 'ask', cmd);
  }
  assert.equal(f.operation('grep', { path: f.active, pattern: 'PRIVATE' }).verdict, 'ask');
});

test('a selected package inside the workspace remains read-only under standard permissions', t => {
  const f = fixture(t), scope = scopes.create([f.work]);
  fs.writeFileSync(path.join(f.work, 'template.md'), 'Template');
  fs.writeFileSync(path.join(f.work, 'auth.json'), 'private');
  assert.equal(f.operation('read', { path: 'template.md' }, 'standard', scope).verdict, 'allow');
  assert.equal(f.operation('write', { path: 'template.md' }, 'standard', scope).verdict, 'ask');
  assert.equal(f.operation('read', { path: 'auth.json' }, 'standard', scope).verdict, 'ask');
  assert.equal(f.operation('bash', { command: 'cat auth.json' }, 'standard', scope).verdict, 'ask');
});

test('real Pi SDK reads a loaded external skill without a popup; unsafe calls and expired plugin resources still ask', { timeout: 30000 }, async t => {
  const f = fixture(t), requests = [];
  const sdk = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  let extraScope, runtime, decision = 'deny';
  runtime = await require('../e2e/fixtures/access-sdk.cjs').create(f.root, 'standard', () => {
    for (const request of runtime?.access.broker.pending() || []) {
      requests.push(request); runtime.access.broker.answer({ ...request, decision });
    }
  }, { skillDirs: [f.active], readScope: () => extraScope, customTools: [sdk.createBashTool(f.work)] });
  t.after(() => runtime.close());
  for (const file of ['SKILL.md', 'references/guide.md', 'scripts/check.cjs']) {
    await runtime.send('read', { path: path.join(f.active, file) });
    assert.equal(runtime.session.messages.filter(row => row.role === 'toolResult').at(-1).isError, false);
  }
  await runtime.send('bash', { command: 'cat "' + path.join(f.active, 'references/guide.md').replaceAll('\\', '/') + '"' });
  assert.match(JSON.stringify(runtime.session.messages.at(-2)), /LOADED_SKILL_REFERENCE/);
  assert.equal(requests.length, 0);
  for (const [tool, args] of [
    ['read', { path: path.join(f.inactive, 'SKILL.md') }],
    ['read', { path: path.join(f.active, '.env') }],
    ['write', { path: path.join(f.active, 'SKILL.md'), content: 'overwrite' }],
    ['bash', { command: 'node "' + path.join(f.active, 'scripts/check.cjs') + '"' }],
  ]) await runtime.send(tool, args);
  assert.equal(requests.length, 4);
  assert.match(fs.readFileSync(path.join(f.active, 'SKILL.md'), 'utf8'), /Test skill/);
  assert.doesNotMatch(JSON.stringify(runtime.session.messages), /PRIVATE_CREDENTIAL/);
  const bundle = require('../main/plugin-resources').materialize([
    { path: 'references/SKILL.md', kind: 'reference', encoding: 'utf8', content: 'CURRENT_PLUGIN_GUIDE' },
  ], f.work, 'active-plugin');
  extraScope = scopes.create([bundle.directory]);
  await runtime.send('read', { path: path.join(bundle.directory, 'references/SKILL.md') });
  assert.equal(requests.length, 4);
  assert.match(JSON.stringify(runtime.session.messages.at(-2)), /CURRENT_PLUGIN_GUIDE/);
  extraScope = undefined;
  await runtime.send('read', { path: path.join(bundle.directory, 'references/SKILL.md') });
  assert.equal(requests.length, 5);
  decision = 'once';
  await runtime.send('read', { path: path.join(f.active, 'auth.json') });
  assert.equal(requests.length, 6);
  assert.match(JSON.stringify(runtime.session.messages.at(-2)), /PRIVATE_AUTH/);
});

test('real SDK permission changes reload skill access without widening the stored policy', { timeout: 30000 }, async t => {
  const f = fixture(t), requests = [];
  const runtime = await require('../e2e/fixtures/access-sdk.cjs').create(f.root, 'full', () => {}, { skillDirs: [f.active] });
  let live = { session: runtime.session, access: runtime.access, policy: runtime.access.policy };
  const transition = require('../main/access-control/pi-transition').create({
    cwd: f.work, current: () => live,
    prepare: (policy, previous) => runtime.rebuild(policy, previous),
    readScope: () => live.resources?.skillReadScope,
    commit: next => { live = next; },
    changed: () => {
      for (const request of live.access.broker.pending()) {
        requests.push(request); live.access.broker.answer({ ...request, decision: 'deny' });
      }
    },
  });
  t.after(async () => { transition.close(); live.access.broker.close(); await live.session.abort(); live.session.dispose(); await runtime.close(); });
  const sessionId = live.session.sessionId;
  for (const mode of ['standard', 'readonly', 'standard']) {
    transition.schedule(rules.next(mode, f.work, live.policy, live.policy.revision), live.policy.revision);
    await transition.apply();
    await live.session.prompt(JSON.stringify({ tool: 'read', args: { path: path.join(f.active, 'references/guide.md') } }));
    assert.equal(requests.length, 0);
    assert.equal(live.session.messages.filter(row => row.role === 'toolResult').at(-1).isError, false);
    assert.equal(live.session.sessionId, sessionId);
    assert.equal(live.policy.workspaceRoot, rules.canonical(f.work));
    assert.equal(live.policy.readRoots, undefined);
  }
  await live.session.prompt(JSON.stringify({ tool: 'read', args: { path: path.join(f.inactive, 'SKILL.md') } }));
  assert.equal(requests.length, 1);
});
