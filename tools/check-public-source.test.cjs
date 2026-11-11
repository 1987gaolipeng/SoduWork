'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check } = require('./check-public-source.cjs');
const productionPolicy = require('./distribution/PUBLIC-SOURCE.json');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-public-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
  };
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  write('tools/distribution/PUBLIC-SOURCE.json', JSON.stringify({ ...productionPolicy, skills: [] }));
  write('LICENSE', 'Copyright (c) 2026 MDiRi');
  return { root, write };
}

test('the policy may name exclusions while ordinary source remains distributable', t => {
  const f = fixture(t); f.write('client/example.cjs', 'module.exports = { name: "Example library" };');
  assert.equal(check(f.root).ok, true);
});

test('public coding-agent guidance is distributable while private project context stays excluded', t => {
  const f = fixture(t);
  f.write('AGENTS.md', '# Contributor guidance\nRead CONTRIBUTING.md and run component checks.\n');
  assert.equal(check(f.root).ok, true);
  f.write('PROJECT_CONTEXT.md', 'Private project context');
  assert.ok(check(f.root).errors.includes('Excluded first-release material: PROJECT_CONTEXT.md'));
});

test('renamed private source, fixtures and embedded assets cannot evade content checks', t => {
  const f = fixture(t);
  for (const identifier of productionPolicy.excludedIdentifiers) {
    f.write('client/renamed.cjs', identifier.toUpperCase());
    assert.equal(check(f.root).ok, false, identifier);
  }
  fs.unlinkSync(path.join(f.root, 'client/renamed.cjs'));
  f.write('assets/fixture.bin', Buffer.from('\0' + productionPolicy.excludedIdentifiers[0]));
  assert.equal(check(f.root).ok, false);
});

test('excluded filenames are rejected even with neutral contents', t => {
  const f = fixture(t);
  for (const name of productionPolicy.excludedFiles) {
    f.write(name, '{}');
    assert.equal(check(f.root).ok, false, name);
    fs.unlinkSync(path.join(f.root, name));
  }
});

test('mixed-case restricted paths and invalid policy entries fail closed', t => {
  const f = fixture(t);
  f.write('fixtures/' + productionPolicy.excludedIdentifiers[1].toUpperCase() + '.json', '{}');
  assert.equal(check(f.root).ok, false);
  f.write('tools/distribution/PUBLIC-SOURCE.json', JSON.stringify({ ...productionPolicy, excludedIdentifiers: [''] }));
  assert.throws(() => check(f.root), /Invalid excluded identifiers/);
});
