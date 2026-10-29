'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const resources = require('../main/pi-session/session-resources');

test('invalid Skill YAML identifies the files and gives a bounded repair instruction', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-error-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, 'work'), agent = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agent);
  const dirs = ['debug-radar', 'issue-gardener'].map(name => {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Diagnose failures: ${'private task content '.repeat(80)}\n---\nInstructions.\n`);
    return dir;
  });
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  await assert.rejects(resources.sessionResources(sdk, cwd, agent, dirs, [], { noExtensions: true }), error => {
    assert.match(error.message, /debug-radar/);
    assert.match(error.message, /issue-gardener/);
    assert.match(error.message, /YAML/);
    assert.match(error.message, /第 2 行/);
    assert.match(error.message, /修正.*重新导入/);
    assert.doesNotMatch(error.message, /private task content|\n/);
    assert.ok(error.message.length < 550);
    return true;
  });
});

test('non-YAML diagnostics retain their actionable cause', () => {
  assert.throws(() => resources.verifySkills(['/skills/missing'], { skills: [], diagnostics: [
    { type: 'warning', path: '/skills/missing/SKILL.md', message: 'description is required' },
  ] }), /description is required/);
});
