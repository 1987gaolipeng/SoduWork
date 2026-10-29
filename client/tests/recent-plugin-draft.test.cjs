const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const draftReader = require('../main/pi-session/plugin-draft');

function session(root, file, at, id) {
  return {
    cwd: root,
    sessionId: id,
    startedAt: at - 1,
    outputSnapshot() { return { files: [file] }; },
  };
}

test('reads only the newest active SoduWork plugin draft', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-draft-'));
  const oldPath = path.join(root, 'old', draftReader.DRAFT_NAME);
  const newPath = path.join(root, 'new', draftReader.DRAFT_NAME);
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(oldPath, JSON.stringify({ name: 'old' }));
  fs.writeFileSync(newPath, JSON.stringify({ name: 'new' }));
  const result = draftReader.readRecent([
    session(root, { path: oldPath, relative: 'old/' + draftReader.DRAFT_NAME, at: 10 }, 10, 'old'),
    session(root, { path: newPath, relative: 'new/' + draftReader.DRAFT_NAME, at: 20 }, 20, 'new'),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.body.name, 'new');
  assert.equal(result.source.sessionId, 'new');
});

test('ignores matching names outside the active session work directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-root-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-other-'));
  const outside = path.join(other, draftReader.DRAFT_NAME);
  fs.writeFileSync(outside, JSON.stringify({ name: 'outside' }));
  const result = draftReader.readRecent([
    session(root, { path: outside, relative: draftReader.DRAFT_NAME, at: 30 }, 30, 'outside'),
  ]);
  assert.equal(result.ok, false);
});

test('does not treat arbitrary JSON outputs as installable plugin drafts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-name-'));
  const file = path.join(root, 'other.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'not-a-plugin' }));
  const result = draftReader.readRecent([
    session(root, { path: file, relative: 'other.json', at: 40 }, 40, 'other'),
  ]);
  assert.equal(result.ok, false);
});
