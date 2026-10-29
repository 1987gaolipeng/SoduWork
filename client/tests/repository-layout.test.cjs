'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditFiles, auditPackaging, check } = require('../../tools/check-repository-layout.cjs');

test('repository contains maintained source and reproducible build boundaries', () => {
  const result = check();
  assert.deepEqual(result.errors, []);
  assert.ok(result.sourceFiles > 1000);
});

test('generated binaries, runtime identities and retired routes cannot return as source', () => {
  const bad = ['client/runner/_internal/skills/browser-use/SKILL.md', 'client/runner/soduwork-runner.exe',
    'client/pi-chat/assets/main.js', 'skin-server/data/users/person/profile.json', 'skin-server/server.js', 'mobile/lib/main.dart', 'mobile-web-dist/.gitkeep',
    'hub-backend/uploads/report.md', 'client/components/panels/panels-ms-agent.js',
    '.github/private.env', '.github/workflows/company-deploy.yml'];
  for (const name of bad) assert.ok(auditFiles([name]).length > 0, name);
  assert.deepEqual(auditFiles(['client/runner/README.md', 'hub-backend/runner.spec',
    'hub-backend/migrations/versions/0053_unified_requirements.py', 'skills/browser-use/SKILL.md',
    '.github/workflows/ci.yml', '.github/ISSUE_TEMPLATE/bug_report.yml']), []);
});

test('all distribution formats reject stale Runner reuse and broad resource copying', () => {
  const original = require('../package.json');
  for (const hook of ['prebuild', 'prebuild-portable', 'build:mac', 'prebuild:linux']) {
    const pkg = structuredClone(original);
    pkg.scripts[hook] = 'electron-builder';
    assert.ok(auditPackaging(pkg).some(error => error.includes(hook)));
  }
  let pkg = structuredClone(original);
  pkg.build.win.extraResources.find(row => row.from === 'runner').filter.push('**/*');
  assert.ok(auditPackaging(pkg).some(error => error.includes('single-file')));
  pkg = structuredClone(original);
  pkg.build.win.extraResources.find(row => row.from === 'runner').filter = [];
  assert.ok(auditPackaging(pkg).some(error => error.includes('single-file')));
  pkg = structuredClone(original);
  pkg.build.mac.extraResources.find(row => row.from === 'runner').filter.push('soduwork-runner.exe');
  assert.ok(auditPackaging(pkg).some(error => error.includes('macOS Runner resources must select')));
  pkg = structuredClone(original);
  pkg.build.linux.extraResources.find(row => row.from === 'runner').filter.push('soduwork-runner.exe');
  assert.ok(auditPackaging(pkg).some(error => error.includes('Linux Runner resources must select')));
  pkg = structuredClone(original);
  pkg.build.extraResources.push({ from: 'runner', to: 'runner', filter: ['soduwork-runner.exe'] });
  assert.ok(auditPackaging(pkg).some(error => error.includes('platform sections')));
});
