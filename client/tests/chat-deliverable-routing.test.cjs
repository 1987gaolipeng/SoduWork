'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const links = require('../components/panels/chat-output-links');
const fs = require('node:fs'), path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('local conversation deliverables pair with workspace files by name and size', async () => {
  const html = '<!doctype html><title>五子棋</title>';
  const local = { artifactId: 'website:index.html', name: 'index.html', relative: 'index.html',
    kind: 'website', path: 'C:/work/ws/index.html', size: Buffer.byteLength(html), primary: true };
  const hub = { listAttachments: async taskId => [
    { id: 'b18a0911', taskId, filename: 'index.html', role: 'output',
      size: Buffer.byteLength(html), url: '/api/v1/attachments/b18a0911?ticket=short-lived',
      sourceRef: 'conversation:c-1', evidenceMeta: { sha256: 'a'.repeat(64), round: 1, category: 'primary' } }] };
  const rows = await links.load({ outputs: async () => ({ ok: true, artifacts: [local] }) }, 'ref', ['t1'], [], hub);
  // Merge paired remote identity into local rows and route opens through local bytes.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, local.path);
  assert.equal(rows[0].artifactId, 'website:index.html');
  assert.equal(rows[0].taskId, 't1');
  assert.equal(rows[0].attachmentId, 'b18a0911');
  assert.equal(rows[0].remoteMaterialized, true);
  assert.equal(rows[0].primary, true);
  assert(!JSON.stringify(rows).includes('short-lived'), 'rendered rows never carry hub URLs');
});

test('size or ambiguity mismatches keep the remote row instead of guessing', async () => {
  const local = { artifactId: 'local:page', name: 'page.html', relative: 'page.html',
    kind: 'website', path: 'C:/work/ws/page.html', size: 100 };
  const hub = { listAttachments: async taskId => [
    { id: 'x1', taskId, filename: 'page.html', role: 'output', size: 222, url: '/attachments/x1?ticket=t' }] };
  // A size mismatch means local content changed after upload; the attachment remains authoritative.
  const mismatched = await links.load({ outputs: async () => ({ ok: true, artifacts: [local] }) }, 'ref', ['t'], [], hub);
  assert.equal(mismatched.length, 2);
  assert.ok(mismatched.some(row => row.attachmentId === 'x1' && !row.path));

  // Do not pair ambiguous local rows sharing a name and size.
  const twin = { ...local, artifactId: 'local:page2', path: 'C:/work/ws/copy/page.html' };
  const ambiguous = await links.load({ outputs: async () => ({ ok: true, artifacts: [local, twin] }) }, 'ref', ['t'], [], hub);
  assert.equal(ambiguous.length, 3);
  assert.equal(ambiguous.filter(row => row.attachmentId === 'x1').length, 1);
});

test('stale rounds never resurface through pairing', async () => {
  const local = { artifactId: 'website:index.html', name: 'index.html', relative: 'index.html',
    kind: 'website', path: 'C:/work/ws/index.html', size: 500, primary: true };
  const hub = { listAttachments: async taskId => [
    { id: 'old', taskId, filename: 'index.html', role: 'output', size: 480, url: '/attachments/old?ticket=t' },
    { id: 'new', taskId, filename: 'index.html', role: 'output', size: 500, url: '/attachments/new?ticket=t',
      evidenceMeta: { sha256: 'b'.repeat(64), round: 1, category: 'primary' } }] };
  const rows = await links.load({ outputs: async () => ({ ok: true, artifacts: [local] }) }, 'ref', ['t'], [], hub);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attachmentId, 'new');
  assert.equal(rows[0].round, 1);
});

test('pairs found only in the full workspace list stay visible after pairing', async () => {
  const entry = { artifactId: 'website:index.html', name: 'index.html', relative: 'index.html',
    kind: 'website', path: 'C:/work/ws/index.html', size: 500, primary: true };
  const asset = { artifactId: 'local:style.css', name: 'style.css', relative: 'style.css',
    path: 'C:/work/ws/style.css', size: 300 };
  const hub = { listAttachments: async taskId => [
    { id: 'a-entry', taskId, filename: 'index.html', role: 'output', size: 500, url: '/attachments/a-entry?ticket=t' },
    { id: 'a-asset', taskId, filename: 'style.css', role: 'supporting', size: 300, url: '/attachments/a-asset?ticket=t' }] };
  // Find supporting files in the full workspace index when absent from the compact entry list.
  // Restore successfully paired rows to the result set instead of losing the deliverable.
  const rows = await links.load({ outputs: async () => ({ ok: true, artifacts: [entry], files: [entry, asset] }) },
    'ref', ['t'], [], hub);
  assert.equal(rows.length, 2);
  const assetRow = rows.find(row => row.relative === 'style.css');
  assert.ok(assetRow, 'the fallback-paired local row must remain in the result');
  assert.equal(assetRow.path, 'C:/work/ws/style.css');
  assert.equal(assetRow.attachmentId, 'a-asset');
  assert.equal(assetRow.remoteMaterialized, true);
  assert.equal(rows.filter(row => row.attachmentId === 'a-entry').length, 1);
  assert(!rows.some(row => row.relative === 'style.css' && !row.path), 'no remote duplicate may survive pairing');
});

test('unsupported deliverables open through the explicit save dialog, never the browser', async () => {
  const requests = [], saved = [];
  const file = { taskId: 't', attachmentId: 'a', name: 'tool.zip' };
  const hub = { listAttachments: async id => { requests.push(id);
      return [{ id: 'a', role: 'output', filename: 'tool.zip', url: '/api/v1/attachments/a?ticket=fresh' }]; },
    attachmentUrl: row => 'https://hub.test' + row.url };
  const bridge = { downloadAttachment: async payload => { saved.push(payload); return { ok: true }; } };
  assert.equal(await links.openTaskFile(file, hub, bridge), true);
  assert.deepEqual(requests, ['t']);
  assert.deepEqual(saved, [{ url: 'https://hub.test/api/v1/attachments/a?ticket=fresh', filename: 'tool.zip' }]);
  await assert.rejects(links.openTaskFile({ ...file, attachmentId: 'missing' }, hub, bridge), /暂时不可用/);
  await assert.rejects(links.openTaskFile(file, { ...hub, listAttachments: async () =>
    [{ id: 'a', role: 'output', url: 'javascript:alert(1)' }] }, bridge), /地址无效/);
});

test('office and packaged task outputs use the native system-app handoff when available', async () => {
  const requests = [], opened = [];
  const file = { taskId: 't', attachmentId: 'a', name: '\u9884\u7b97.xlsx' };
  const hub = { listAttachments: async id => { requests.push(id);
      return [{ id: 'a', role: 'output', filename: '\u9884\u7b97.xlsx', url: '/api/v1/attachments/a?ticket=fresh' }]; },
    attachmentUrl: row => 'https://hub.test' + row.url };
  const bridge = { previewAttachment: async payload => { opened.push(payload); return { ok: true, external: true }; } };
  assert.equal(await links.openTaskFile(file, hub, bridge), true);
  assert.deepEqual(requests, ['t']);
  assert.deepEqual(opened, [{ url: 'https://hub.test/api/v1/attachments/a?ticket=fresh', filename: '\u9884\u7b97.xlsx' }]);
});

test('materializeTask swaps a hub attachment row for the verified local copy', async () => {
  const globalKeys = Object.keys(global);
  global.soduWorkAPI = { attachmentMaterialize: async payload => {
    assert.equal(payload.ref, 'ref-1');
    assert.equal(payload.taskId, 't1');
    assert.equal(payload.attachmentId, 'a1');
    return { ok: true, cwd: 'C:/work/ws', taskId: 't1', artifacts: [
      { path: 'C:/work/ws/.soduwork-attachments/t1/index.html', relative: 'index.html', name: 'index.html',
        kind: 'website', size: 500, at: 1234, primary: true, role: 'output',
        attachmentId: 'a1', remoteMaterialized: true }] };
  } };
  try {
    const file = { artifactId: 'task-output:t1:a1', taskId: 't1', attachmentId: 'a1', name: 'index.html' };
    const local = await links.materializeTask(file, {}, 'ref-1');
    assert.equal(local.artifactId, '', 'stale remote artifact ids must not survive');
    assert.equal(local.path, 'C:/work/ws/.soduwork-attachments/t1/index.html');
    assert.equal(local.kind, 'website');
    assert.equal(local.taskId, 't1');
    assert.equal(local.attachmentId, 'a1');
  } finally {
    for (const key of Object.keys(global).filter(key => !globalKeys.includes(key))) delete global[key];
  }
});

test('cloud conversations still require main-process proofs, not name+size pairing', async () => {
  const hub = { listAttachments: async taskId => [
    { id: 'x1', taskId, filename: 'report.md', role: 'output', size: 4, url: '/attachments/x1?ticket=t' }] };
  const local = { artifactId: 'local', path: 'C:/fixture/report.md', relative: 'report.md', size: 4 };
  // When cloud cache state exists, keep remote rows on the cloud-materialization path.
  const cached = await links.load({ outputs: async () => ({ ok: true, artifacts: [local], cloudOutputs: [] }) }, 'ref', ['task'], [], hub);
  assert.equal(cached.length, 2);
  assert.equal(cached.find(row => row.artifactId === 'local').taskId, undefined);
  // Merge only rows explicitly identified by proof.
  const proven = await links.load({ outputs: async () => ({ ok: true, artifacts: [local],
    cloudOutputs: [{ taskId: 'task', attachmentId: 'x1', relative: 'report.md', size: 4, artifactId: 'local' }] }) }, 'ref', ['task'], [], hub);
  assert.equal(proven.length, 1);
  assert.equal(proven[0].cloudTaskId, 'task');
});

test('contract: attachment URLs never enter navigable render surfaces', () => {
  const workspace = read('components', 'panels', 'panels-chat-workspace.js');
  assert(!workspace.includes('mode=preview'), 'browser tabs must not load hub attachment URLs');
  assert.match(workspace, /if \(file\.path\) return false;/, 'local bytes win over the hub route');
  assert.match(workspace, /links\?\.materializeTask/, 'web deliverables materialize before preview');
  assert.match(workspace, /downloadBlocked/, 'blocked passive downloads surface a readable notice');
  const outputLinks = read('components', 'panels', 'chat-output-links.js');
  assert(!outputLinks.includes('openExternal'), 'ticketed hub URLs must not reach the system browser');
  const sessions = read('main', 'work-preview-sessions.cjs');
  assert.match(sessions, /will-download/);
  assert.match(sessions, /preventDefault/);
  const preview = read('main', 'work-preview.js');
  assert.match(preview, /guardWorkbenchDownload/);
  assert.match(preview, /\/api\/v1\/attachments\//);
});
