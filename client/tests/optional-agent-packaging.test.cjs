'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const runtime = require('../main/runner-runtime');
const { auditPackaging } = require('../../tools/check-repository-layout.cjs');

test('Runner ignores retired bundled OpenCode even when an old resource directory exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-optional-agent-'));
  try {
    fs.mkdirSync(path.join(root, 'opencode'));
    fs.writeFileSync(path.join(root, 'opencode', 'opencode.exe'), 'retired');
    for (const isPackaged of [true, false]) {
      const env = runtime._runnerEnv({ SODUWORK_BUNDLED_OPENCODE: 'stale', PATH: 'user-cli-path' },
        'device-secret', { isPackaged }, root);
      assert.equal(Object.hasOwn(env, 'SODUWORK_BUNDLED_OPENCODE'), false);
      assert.equal(env.PATH, 'user-cli-path', 'locally installed agents stay discoverable');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every package uses one lightweight recipe and rejects optional OpenCode resources', () => {
  const original = require('../package.json');
  assert.deepEqual(auditPackaging(original), []);
  for (const resource of [
    { from: '.runtime/opencode', to: 'opencode', filter: ['**/*'] },
    { from: '/cache/opencode.exe', to: 'agents/tool.exe' },
  ]) {
    const pkg = structuredClone(original);
    pkg.build.extraResources.push(resource);
    assert.ok(auditPackaging(pkg).some(error => error.includes('OpenCode')));
  }
  const pkg = structuredClone(original);
  pkg.scripts.prebuild += ' && npm run prepare:opencode-runtime';
  assert.ok(auditPackaging(pkg).some(error => error.includes('lightweight')));
  for (const change of ['missing', 'duplicate-source']) {
    const pkg = structuredClone(original);
    if (change === 'missing') pkg.build.extraResources = pkg.build.extraResources.filter(row => row.to !== 'agent_catalog.json');
    else pkg.build.extraResources.find(row => row.to === 'agent_catalog.json').from = 'copied-catalog.json';
    assert.ok(auditPackaging(pkg).some(error => error.includes('authoritative')));
  }
});

test('Runner retains the bundled shell for a clean machine without Git or Bash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-required-shell-'));
  try {
    fs.mkdirSync(path.join(root, 'shell', 'bin'), { recursive: true });
    const shell = path.join(root, 'shell', 'bin', 'bash.exe');
    fs.writeFileSync(shell, 'fixture');
    const base = { SODUWORK_BUNDLED_SHELL: 'stale' };
    assert.equal(runtime._runnerEnv(base, '', { isPackaged: true }, root).SODUWORK_BUNDLED_SHELL,
      path.join(root, 'shell'));
    assert.equal(Object.hasOwn(runtime._runnerEnv(base, '', { isPackaged: false }, root),
      'SODUWORK_BUNDLED_SHELL'), false);
    fs.mkdirSync(path.join(root, '.runtime', 'git', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.runtime', 'git', 'bin', 'bash.exe'), 'fixture');
    assert.equal(runtime._runnerEnv(base, '', { isPackaged: false, getAppPath: () => root }, root).SODUWORK_BUNDLED_SHELL,
      path.join(root, '.runtime', 'git'));
    fs.unlinkSync(shell);
    assert.equal(Object.hasOwn(runtime._runnerEnv(base, '', { isPackaged: true }, root),
      'SODUWORK_BUNDLED_SHELL'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
