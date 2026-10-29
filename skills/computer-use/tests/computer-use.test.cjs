const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'screen.ps1');

function run(args, input) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
  ], { cwd: root, input, encoding: 'utf8', timeout: 15_000 });
}

test('invalid screenshot dimensions fail with a non-zero exit code', () => {
  const result = run(['shot', path.join(root, 'invalid.png'), '0', '0', '0', '0']);
  assert.notEqual(result.status, 0);
});

test('unsupported batch actions fail with a non-zero exit code', () => {
  const result = run(['batch', 'stdin'], '[{"cmd":"not-a-real-action"}]');
  assert.notEqual(result.status, 0);
});

test('a bounded no-op batch remains fast and succeeds', () => {
  const result = run(['batch', 'stdin'], '[{"cmd":"wait","ms":0}]');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /batch complete/i);
});
