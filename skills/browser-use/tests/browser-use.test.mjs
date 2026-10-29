import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'scripts', 'browser.mjs');

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SODUWORK_BROWSER_SESSION: 'skill-test-' + process.pid },
    timeout: 10_000,
  });
}

test('prints help without starting a browser', () => {
  const result = run('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shot\|text\|eval\|errors\|do\|status\|close/);
});

test('status is read-only and returns a stable JSON shape', () => {
  const result = run('status', '--session', 'skill-status-' + process.pid);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(typeof value.id, 'string');
  assert.equal(value.running, false);
  assert.equal(value.pid, 0);
});

test('rejects malformed multi-step action lists before connecting', () => {
  const result = run('do', 'current', '{"click":"#never"}', '--session', 'skill-invalid-' + process.pid);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /数组|array|动作|action/i);
});

test('rejects a silent no-op action before connecting', () => {
  const result = run('do', 'current', '[{"text":false}]', '--session', 'skill-invalid-text-' + process.pid);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /text.*true/i);
});
