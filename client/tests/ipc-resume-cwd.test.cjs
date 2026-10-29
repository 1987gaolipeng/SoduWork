const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const _resumeCwd = require('../main/pi-session/resume-cwd');

test('history resume falls back when the archived cwd was removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-cwd-'));
  const app = { getPath(name) { return name === 'userData' ? root : path.join(root, 'Documents'); } };
  const fallback = path.join(root, 'Documents', 'SoduWork');
  assert.equal(_resumeCwd(app, { cwd: path.join(root, 'removed-project') }, () => { fs.mkdirSync(fallback, { recursive: true }); return fallback; }), fallback);
  assert.equal(fs.existsSync(fallback), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('history resume preserves a valid archived cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-cwd-'));
  const work = path.join(root, 'project'); fs.mkdirSync(work);
  const app = { getPath() { return root; } };
  assert.equal(_resumeCwd(app, { cwd: work }, () => path.join(root, 'unused')), path.resolve(work));
  fs.rmSync(root, { recursive: true, force: true });
});

