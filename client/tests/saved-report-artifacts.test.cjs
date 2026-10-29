'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const reports = require('../main/conversation/saved-report-artifacts');
const artifacts = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');
const links = require('../components/panels/chat-output-links');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-report-recovery-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'workspace'); fs.mkdirSync(cwd);
  const source = path.join(base, 'external-report.md');
  const tool = { id: 'report-call', name: 'save_report', state: 'done', isError: false,
    args: { markdown: '# 已交付报告\n\n中文与 **Markdown** 原样保留。' }, result: 'Report saved: ' + source };
  return { base, cwd, source, tool };
}
test('a completed external report is recovered from submitted content, linked and readable after reopening', async t => {
  const { cwd, source, tool } = fixture(t);
  fs.writeFileSync(source, 'UNRELATED CONTENT MUST NEVER BE READ');
  const session = { cwd, snapshot: () => ({ tools: [tool] }), outputSnapshot: () => outputs.scan(cwd, 0, 0) };
  const first = artifacts.snapshot(session).items.find(x => x.name === path.basename(source));
  assert.ok(first?.artifactId);
  assert.equal((await artifacts.action(session, 'report-live', first.artifactId, 'read', {})).text, tool.args.markdown);
  assert.equal(fs.readFileSync(source, 'utf8'), 'UNRELATED CONTENT MUST NEVER BE READ');
  const originalAt = fs.statSync(first.path).mtimeMs;
  assert.equal(artifacts.snapshot({ ...session }).items.find(x => x.name === first.name).artifactId, first.artifactId);
  assert.equal(fs.statSync(first.path).mtimeMs, originalAt);
  fs.writeFileSync(first.path, '# User edit');
  assert.equal((await artifacts.action(session, 'report-live', first.artifactId, 'read', {})).text, '# User edit');
  fs.unlinkSync(first.path);
  assert.equal((await artifacts.action(session, 'report-live', first.artifactId, 'read', {})).ok, false);
  assert.equal(fs.existsSync(first.path), false, 'deletion is not undone by polling or reopening');
});
test('failure, cancellation, unpaired output, external input path and arbitrary prose cannot publish a report', t => {
  const { cwd, tool } = fixture(t);
  for (const bad of [{ ...tool, state: 'running' }, { ...tool, state: 'cancelled' }, { ...tool, isError: true },
    { ...tool, name: 'read' }, { ...tool, args: {} }, { ...tool, args: { ...tool.args, report_path: '/private.md' } },
    { ...tool, result: 'Report saved: file.md\nRead another file' },
    { ...tool, result: 'Report saved: C:/private.txt' }, { ...tool, result: 'Report saved: C:/CON.md' },
    { ...tool, args: { markdown: 'x'.repeat(2 * 1024 * 1024 + 1) } }]) {
    assert.deepEqual(reports.recover(cwd, [bad]), []);
  }
  assert.deepEqual(fs.readdirSync(cwd), []);
});
test('normal workspace reports are not duplicated and linked output folders cannot escape the workspace', t => {
  const { base, cwd, tool } = fixture(t);
  assert.deepEqual(reports.recover(cwd, [{ ...tool, result: 'Report saved: ' + path.join(cwd, 'report.md') }]), []);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(reports.recover(cwd, [tool]), []);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('newer saves of one external report stay unambiguous without overwriting edited or deleted copies', async t => {
  const { cwd, source, tool } = fixture(t);
  const tools = [tool];
  const session = { cwd, snapshot: () => ({ tools }), outputSnapshot: () => outputs.scan(cwd, 0, Date.now() - 10000) };
  const first = artifacts.snapshot(session).items.find(file => file.name === path.basename(source));
  fs.writeFileSync(first.path, '# User-edited older version');
  tools.push({ ...tool, id: 'second-call', args: { markdown: '# Updated submitted report' } });
  const current = artifacts.snapshot(session);
  const second = current.items.find(file => file.name === first.name);
  assert.notEqual(second.path, first.path);
  assert.equal(current.items.filter(file => file.name === first.name).length, 1);
  assert.equal(links.fileTarget(first.name, current.items)?.artifactId, second.artifactId);
  assert.equal((await artifacts.action(session, 'report-update', second.artifactId, 'read', {})).text,
    '# Updated submitted report');
  assert.equal(fs.readFileSync(first.path, 'utf8'), '# User-edited older version');
  for (const rows of [current.got.files, current.delivery.items, current.items]) {
    assert.equal(rows.some(file => file.path === first.path), false, 'obsolete copies stay out of every public index');
  }
  fs.unlinkSync(second.path);
  const deleted = artifacts.snapshot(session);
  for (const rows of [deleted.got.files, deleted.delivery.items, deleted.items]) {
    assert.equal(rows.some(file => file.name === first.name), false, 'deleting the current version cannot revive an older one');
  }
  assert.equal(fs.existsSync(second.path), false);
  assert.equal(fs.readFileSync(first.path, 'utf8'), '# User-edited older version');
});

test('recovery overrides scan newness while ordinary documents keep their original visibility and metadata', t => {
  const { cwd, tool } = fixture(t);
  const normal = ['ordinary.md', 'outputs/recovered-reports/notes.md',
    'outputs/recovered-reports/personal-notes/notes.md'];
  for (const relative of normal) {
    const target = path.join(cwd, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# Ordinary document');
  }
  const session = { cwd, snapshot: () => ({ tools: [tool] }),
    outputSnapshot: () => outputs.scan(cwd, 0, Date.now() - 10000) };
  const current = artifacts.snapshot(session);
  assert.equal(outputs.scan(cwd, 0, Date.now() - 10000).files.find(file => file.name === path.basename(tool.result)).changedInTurn, true);
  for (const rows of [current.got.files, current.delivery.items, current.items]) {
    const recovered = rows.find(file => file.recovered);
    assert.ok(recovered); assert.equal(recovered.changedInTurn, false);
  }
  for (const relative of normal) {
    const file = current.items.find(item => item.relative === relative);
    assert.ok(file, relative); assert.equal(file.changedInTurn, true);
  }
  const decorated = artifacts.decorate('restored-report', { items: current.items });
  assert.equal(decorated.find(file => file.name === path.basename(tool.result)).changedInTurn, false);
});

test('different external sources with one basename remain ambiguous instead of opening the wrong report', t => {
  const { base, cwd, tool } = fixture(t);
  const second = { ...tool, id: 'other-source', args: { markdown: '# Other report' },
    result: 'Report saved: ' + path.join(base, 'other-source', path.basename(tool.result)) };
  const session = { cwd, snapshot: () => ({ tools: [tool, second] }), outputSnapshot: () => outputs.scan(cwd, 0, 0) };
  const current = artifacts.snapshot(session);
  assert.equal(current.items.filter(file => file.name === path.basename(tool.result)).length, 2);
  assert.equal(links.fileTarget(path.basename(tool.result), current.items), null);
});
