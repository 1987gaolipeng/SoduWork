'use strict';
// Real Pi SDK, production session.open/send and on-disk history. Only the
// model/auth endpoint is an isolated HTTP fixture; no accounts or paid models.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { sessionResources } = require('../main/pi-session/session-resources');
const rules = require('../main/access-control/policy');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-optional-skills-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const documents = {
    'personal-notes': '---\nname: personal-notes\n---\nPRIVATE_MISSING_DESCRIPTION_BODY\n',
    'debug-radar': '---\nname: debug-radar\ndescription: Diagnose failures: preserve evidence\n---\nPRIVATE_DEBUG_BODY\n',
    'issue-gardener': '---\nname: issue-gardener\ndescription: Fix issues: keep original evidence\n---\nPRIVATE_ISSUE_BODY\n',
    'healthy-skill': '---\nname: healthy-skill\ndescription: Healthy isolated skill.\n---\nHEALTHY_SKILL_CONTENT\n',
  };
  const originals = new Map(), dirs = Object.keys(documents).map(name => {
    const dir = path.join(root, '.codex', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, documents[name]);
    originals.set(file, fs.readFileSync(file));
    return dir;
  });
  const bad = dirs.slice(0, 3), good = dirs[3];
  const options = { skillDirs: dirs, optionalSkillDirs: dirs, accessPolicy: rules.create('standard', f.cwd) };
  return { ...f, runtime: f, root, dirs, bad, good, options,
    unchanged() { for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes, file); } };
}

function warnings(handle) {
  assert.ok(Object.isFrozen(handle.skillWarnings), 'the public warning list is immutable');
  const text = handle.skillWarnings.join('\n');
  for (const name of ['personal-notes', 'debug-radar', 'issue-gardener']) assert.match(text, new RegExp(name));
  assert.match(text, /description/);
  assert.match(text, /YAML/);
  assert.doesNotMatch(text, /PRIVATE_|Diagnose failures: preserve evidence|Fix issues: keep original evidence/);
  assert.deepEqual(handle.skills, ['healthy-skill']);
}

test('invalid discovered Skills do not block real opening, two turns or saved history recovery', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  f.runtime.reply((_body, count) => ({ text: 'OPTIONAL_SKILL_REPLY_' + count }));
  const handle = await f.runtime.open({ ...f.options, resumePath: undefined });
  warnings(handle);
  const resources = await sessionResources(f.sdk, f.cwd, f.agentDir, f.dirs, [], {
    noExtensions: true, optionalSkillDirs: f.dirs,
  });
  for (const dir of f.bad) assert.equal(rules.operation(f.options.accessPolicy, 'read',
    { path: path.join(dir, 'SKILL.md') }, f.cwd, resources.skillReadScope).verdict, 'ask');
  assert.equal(rules.operation(f.options.accessPolicy, 'read',
    { path: path.join(f.good, 'SKILL.md') }, f.cwd, resources.skillReadScope).verdict, 'allow');
  for (const prompt of ['Ordinary initial prompt', 'Ordinary follow-up without skill selection']) {
    const result = await handle.submit(prompt, []).completion;
    assert.equal(result.ok, true, result.reason);
  }
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    const system = JSON.stringify(request.messages.filter(row => row.role === 'system'));
    assert.match(system, /<name>healthy-skill<\/name>/);
    assert.doesNotMatch(system, /<name>(?:personal-notes|debug-radar|issue-gardener)<\/name>|PRIVATE_/);
  }
  const archivePath = handle.resumeLocation();
  assert.ok(archivePath && fs.existsSync(archivePath));
  const before = fs.readFileSync(archivePath, 'utf8'), sessionId = handle.sessionId;
  handle.close();
  const resumed = await f.runtime.open({ ...f.options, resumePath: archivePath });
  warnings(resumed);
  assert.equal(resumed.sessionId, sessionId);
  assert.match(JSON.stringify(resumed.snapshot().messages), /OPTIONAL_SKILL_REPLY_1/);
  assert.match(JSON.stringify(resumed.snapshot().messages), /OPTIONAL_SKILL_REPLY_2/);
  assert.equal((await resumed.submit('Follow-up after history recovery', []).completion).ok, true);
  assert.equal(f.requests.length, 3);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /OPTIONAL_SKILL_REPLY_1/);
  assert.ok(fs.readFileSync(archivePath, 'utf8').startsWith(before), 'saved turns are not rewritten');
  f.unchanged();
});

test('actual tool execution reads only a healthy loaded Skill without approval', { timeout: 45000 }, async t => {
  const f = await fixture(t), prompts = [];
  const handle = await f.runtime.open(f.options);
  const unsubscribe = handle.on(() => {
    for (const request of handle.snapshot().pendingPermissions || []) {
      if (prompts.some(row => row.requestId === request.requestId)) continue;
      prompts.push(request);
      assert.equal(handle.answerUi({ ...request, decision: 'deny' }).ok, true);
    }
  });
  t.after(unsubscribe);
  let target = path.join(f.good, 'SKILL.md');
  f.runtime.reply(body => body.messages.at(-1).role === 'user'
    ? { tool: 'read', args: { path: target } } : { text: 'Read attempt completed.' });
  assert.equal((await handle.submit('Read the healthy selected resource', []).completion).ok, true);
  assert.equal(prompts.length, 0);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /HEALTHY_SKILL_CONTENT/);
  for (const dir of f.bad) {
    target = path.join(dir, 'SKILL.md');
    assert.equal((await handle.submit('Attempt an unselected external resource', []).completion).ok, true);
  }
  assert.equal(prompts.length, 3, 'bad defaults do not grant ambient file-read authority');
  assert.doesNotMatch(JSON.stringify(f.requests), /PRIVATE_MISSING_DESCRIPTION_BODY|PRIVATE_DEBUG_BODY|PRIVATE_ISSUE_BODY/);
  f.unchanged();
});

test('explicit bad Skills remain strict at opening and at per-turn selection', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  for (const dir of f.bad) {
    await assert.rejects(f.runtime.open({
      ...f.options, skillDirs: [dir, f.good], optionalSkillDirs: [f.good],
    }), new RegExp(path.basename(dir)));
  }
  assert.equal(f.requests.length, 0, 'failed preparation must never contact the model');
  const handle = await f.runtime.open({
    ...f.options,
    resolveSkills: async names => ({ items: names.map(name => ({ name,
      path: f.dirs.find(dir => path.basename(dir) === name), installed: true })) }),
  });
  for (const dir of f.bad) {
    const name = path.basename(dir);
    const result = await handle.submit('Explicit #' + name, [], { skills: [name] }).completion;
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'skill-selection');
    assert.match(result.reason, new RegExp(name));
    assert.equal(f.requests.length, 0);
  }
  assert.equal((await handle.submit('Ordinary conversation still works', []).completion).ok, true);
  assert.equal(f.requests.length, 1);
  f.unchanged();
});
