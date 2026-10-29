'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const packages = require('../main/conversation/delivery-package');
const runtime = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');
async function fixture(t, files) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-delivery-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) { const target = path.join(cwd, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); }
  const session = { cwd, sessionId: 'stable-session', outputSnapshot: () => outputs.scan(cwd, 0, 1), snapshot: () => ({ status: 'idle' }) };
  return { cwd, session, ids: (...names) => runtime.snapshot(session).items.filter(f => names.includes(f.relative)).map(f => f.artifactId) };
}
test('CSS url matching does not mistake JavaScript method suffixes for resource references', () => {
  const source = `<script>canvas.toDataURL('image/png'); object.createObjectURL('image/webp');
    encodeURL('image/jpeg'); custom_url('image/avif'); $url('image/gif');</script>
    <style>body{background:url('hero.svg')}i{mask:URL("mask.svg")}</style>`;
  for (const extension of ['.html', '.htm', '.svg', '.css']) {
    assert.deepEqual(packages.references(source, extension), ['hero.svg', 'mask.svg'], extension);
  }
});

test('canvas website delivery preserves its original bytes without inventing a MIME type dependency', async t => {
  const html = `<title>千花镜 · 一镜千花</title><canvas id="view"></canvas>
    <script>function save(){const image=view.toDataURL('image/png');return image;}</script>`;
  const f = await fixture(t, { 'wanhua/index.html': html });
  const result = await packages.prepare(f.session, f.ids('wanhua/index.html'));
  assert.equal(result.bytes.toString(), html);
  assert.equal(result.manifest.kind, 'file');
  assert.deepEqual(result.manifest.files.map(file => file.path), ['wanhua/index.html']);
});

test('genuine CSS dependencies named image/png still require their actual bytes', async t => {
  const f = await fixture(t, { 'wanhua/index.html': `<style>body{background:url('image/png')}</style>` });
  await assert.rejects(packages.prepare(f.session, f.ids('wanhua/index.html')), /成果依赖缺失：wanhua\/image\/png/);
  await fs.mkdir(path.join(f.cwd, 'wanhua/image'));
  await fs.writeFile(path.join(f.cwd, 'wanhua/image/png'), 'actual image bytes');
  const result = await packages.prepare(f.session, f.ids('wanhua/index.html'));
  assert.deepEqual(result.manifest.files.map(file => file.path), ['wanhua/image/png', 'wanhua/index.html']);
});

test('single file is original bytes, stable content revision, no local paths; edits create another revision', async t => {
  const f = await fixture(t, { '报告.md': '# Final\n', '.env': 'secret' });
  const a = await packages.prepare(f.session, f.ids('报告.md'));
  const b = await packages.prepare(f.session, f.ids('报告.md'));
  assert.equal(a.filename, '报告.md'); assert.equal(a.manifest.kind, 'file');
  assert.equal(a.bytes.toString(), '# Final\n'); assert.equal(a.manifest.revision, b.manifest.revision);
  assert.equal(a.manifest.files.length, 1); assert(!JSON.stringify(a.manifest).includes(f.cwd));
  await fs.writeFile(path.join(f.cwd, '报告.md'), '# Edited');
  assert.notEqual((await packages.prepare(f.session, f.ids('报告.md'))).manifest.revision, a.manifest.revision);
});

test('conversation provenance carries the captured title without creating a new file revision on rename', async t => {
  const f = await fixture(t, { 'report.md': '# Final\n' });
  const ids = f.ids('report.md');
  const original = await packages.prepare(f.session, ids);
  assert.equal(Object.hasOwn(original.manifest, 'conversationTitle'), false, 'older sessions without titles remain supported');
  f.session.sessionTitle = '  生成简单的网站\n涉及三个页面\u0000 ';
  const named = await packages.prepare(f.session, ids);
  assert.equal(named.manifest.conversationTitle, '生成简单的网站 涉及三个页面');
  assert.equal(named.manifest.title, 'report.md', 'a conversation name is not a file name');
  assert.equal(named.manifest.revision, original.manifest.revision);
  assert.deepEqual(named.bytes, original.bytes);
  f.session.sessionTitle = '已改名的会话';
  const renamed = await packages.prepare(f.session, ids);
  assert.equal(renamed.manifest.conversationTitle, '已改名的会话');
  assert.equal(renamed.manifest.revision, original.manifest.revision, 'renaming must reuse the saved delivery identity');
  f.session.sessionTitle = '长'.repeat(300);
  assert.equal((await packages.prepare(f.session, ids)).manifest.conversationTitle, '长'.repeat(240));
  f.session.sessionTitle = '\n\u0000\t';
  assert.equal(Object.hasOwn((await packages.prepare(f.session, ids)).manifest, 'conversationTitle'), false);
});
test('website carries transitive CSS, JS, images and explicitly declared files; unrelated workspace material stays out', async t => {
  const f = await fixture(t, { 'site/index.html': '<link href="assets/theme.css"><script src="assets/main.js"></script>',
    'site/assets/theme.css': 'body{background:url("../images/hero.svg")}', 'site/assets/main.js': 'import "./widget.js";',
    'site/assets/widget.js': 'export const ready=true;', 'site/images/hero.svg': '<svg/>',
    'site/说明.txt': '双击 index.html', 'site/private.txt': 'not a deliverable',
    '.soduwork/delivery.json': JSON.stringify({ schemaVersion: 1, deliverables: [{ path: 'site/index.html', files: ['site/说明.txt'] }] }) });
  const got = await packages.prepare(f.session, f.ids('site/index.html'));
  assert.equal(got.manifest.kind, 'bundle'); assert.equal(got.manifest.files.length, 6);
  assert(got.manifest.files.some(f => f.path === 'site/images/hero.svg' && f.role === 'supporting'));
  assert(!got.manifest.files.some(f => f.path.endsWith('private.txt'))); assert.equal(got.bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(got.manifest.entryPath, 'site/index.html');
});

test('UTF-16 HTML includes dependencies and keeps the captured original bytes', async t => {
  const html = '<!doctype html><html><link href="assets/主题.css"><img src="https://example.test/hero.png"></html>';
  for (const bigEndian of [false, true]) {
    const bytes = Buffer.from('\ufeff' + html, 'utf16le');
    if (bigEndian) bytes.swap16();
    const css = Buffer.from('\ufeffbody{background:url("hero.svg")}', 'utf16le');
    if (bigEndian) css.swap16();
    const f = await fixture(t, { 'index.html': bytes, 'assets/主题.css': css, 'assets/hero.svg': '<svg/>' });
    const got = await packages.prepare(f.session, f.ids('index.html'));
    assert.deepEqual(got.manifest.files.map(file => file.path), ['assets/hero.svg', 'assets/主题.css', 'index.html']);
    assert.deepEqual(got.manifest.externalDependencies, ['https://example.test/hero.png']);
    assert.equal(got.manifest.files.find(file => file.path === 'index.html').sha256,
      require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await fs.readFile(path.join(f.cwd, 'index.html')), bytes);
  }
});

test('HTML export buttons do not turn object URL variables into file dependencies', async t => {
  const html = '<style>body{background:URL("assets/paper.svg")}</style><script>' +
    'const b = new Blob(["image"]); const a = document.createElement("a");' +
    'a.href = URL.createObjectURL(b); setTimeout(() => URL.revokeObjectURL(a.href), 4000);</script>';
  const f = await fixture(t, { 'index.html': html, 'assets/paper.svg': '<svg/>' });
  const got = await packages.prepare(f.session, f.ids('index.html'));
  assert.deepEqual(got.manifest.files.map(file => file.path), ['assets/paper.svg', 'index.html']);
  await fs.unlink(path.join(f.cwd, 'assets/paper.svg'));
  await assert.rejects(packages.prepare(f.session, f.ids('index.html')), /依赖缺失.*paper\.svg/);
});

test('UTF-16 HTML cannot silently omit missing or unsafe dependencies', async t => {
  const f = await fixture(t, { 'index.html': Buffer.from('\ufeff<html><img src="missing.png"></html>', 'utf16le'), '.env': 'secret' });
  await assert.rejects(packages.prepare(f.session, f.ids('index.html')), /依赖缺失/);
  await fs.writeFile(path.join(f.cwd, 'index.html'), Buffer.from('\ufeff<html><script src=".env"></script></html>', 'utf16le'));
  await assert.rejects(packages.prepare(f.session, f.ids('index.html')), /不适合交付/);
  await fs.writeFile(path.join(f.cwd, 'index.html'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html>!')]));
  await assert.rejects(packages.prepare(f.session, f.ids('index.html')), /文本编码无法解析/);
});
test('missing or unsafe dependencies cannot be marked complete; running work is not exported', async t => {
  const f = await fixture(t, { 'index.html': '<img src="missing.png">', '.env': 'secret' });
  await assert.rejects(packages.prepare(f.session, f.ids('index.html')), /依赖缺失/);
  await fs.writeFile(path.join(f.cwd, 'index.html'), '<script src=".env"></script>');
  await assert.rejects(packages.prepare(f.session, f.ids('index.html')), /不适合交付/);
  f.session.inFlight = () => true;
  await assert.rejects(packages.prepare(f.session, f.ids('index.html')), /仍在生成/);
  await assert.rejects(packages.prepare(f.session, ['unknown']), /仍在生成/);
});
test('two independent outputs keep relative directories and same-named files', async t => {
  const f = await fixture(t, { 'one/report.md': 'one', 'two/report.md': 'two' });
  const got = await packages.prepare(f.session, f.ids('one/report.md', 'two/report.md'));
  assert.equal(got.manifest.files.length, 2); assert.deepEqual(got.manifest.files.map(f => f.path), ['one/report.md', 'two/report.md']);
});
test('bundle title carries the task context so library entries are distinguishable', async t => {
  const f = await fixture(t, { 'site/index.html': '<link href="style.css">', 'site/style.css': 'body{color:red}', 'notes.md': '# 笔记' });
  const ids = f.ids('site/index.html');
  f.session.taskTitle = '赛车游戏';
  const a = await packages.prepare(f.session, ids);
  assert.equal(a.manifest.title, '赛车游戏 · 会话成果');
  assert.equal(a.filename, '赛车游戏 · 会话成果.zip');
  f.session.taskTitle = '';
  f.session.sessionTitle = '帮我做个小网页';
  assert.equal((await packages.prepare(f.session, ids)).manifest.title, '帮我做个小网页 · 会话成果');
  delete f.session.sessionTitle;
  assert.equal((await packages.prepare(f.session, ids)).manifest.title, 'index · 会话成果');
  f.session.taskTitle = '超'.repeat(300);
  const long = await packages.prepare(f.session, ids);
  assert.ok(long.manifest.title.length <= 120 && long.manifest.title.endsWith(' · 会话成果'));
  f.session.taskTitle = '报:告*名?';
  assert.equal((await packages.prepare(f.session, ids)).filename, '报_告_名_ · 会话成果.zip');
  const single = await packages.prepare(f.session, f.ids('notes.md'));
  assert.equal(single.manifest.title, 'notes.md', 'single files keep their own name');
});

test('path traversal, secrets, reserved names and case collisions fail closed', async t => {
  for (const value of ['../private.txt', 'D:/private.txt', '.git/config', '.env.local', 'node_modules/a.js', 'a/CON.txt']) assert.throws(() => packages.safeRelative(value));
  const f = await fixture(t, { 'report.md': 'report' });
  await assert.rejects(packages.prepare(f.session, ['untrusted-path']), /已经更新/);
});

test('nested website root resources and online API dependencies remain distinct', async t => {
  const manifest = { schemaVersion: 1, runtime: { networkPolicy: 'online', externalDependencies: ['/api', 'https://cdn.example.test'] }, deliverables: [{ path: 'site/index.html' }] };
  const f = await fixture(t, { 'site/index.html': '<script src="/assets/main.js"></script><a href="/account">Account</a>',
    'site/assets/main.js': 'fetch("/api/results"); import "./widget.js";', 'site/assets/widget.js': 'export const ok=true;',
    '.soduwork/delivery.json': JSON.stringify(manifest) });
  const got = await packages.prepare(f.session, f.ids('site/index.html'));
  assert.deepEqual(got.manifest.files.map(f => f.path), ['site/assets/main.js', 'site/assets/widget.js', 'site/index.html']);
  assert.deepEqual(got.manifest.externalDependencies, manifest.runtime.externalDependencies);
  manifest.runtime.externalDependencies = '/api';
  await fs.writeFile(path.join(f.cwd, '.soduwork/delivery.json'), JSON.stringify(manifest));
  await assert.rejects(packages.prepare(f.session, f.ids('site/index.html')), /在线依赖清单/);
});

test('IPC denies untrusted frames, returns original bytes and honors canceled save', async t => {
  const f = await fixture(t, { 'report.md': '# Deliver' }), handlers = new Map();
  f.session.historyRow = () => ({ title: '自动归档的会话' });
  const { pathToFileURL } = require('node:url');
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false, getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  let choice = { canceled: true }, saved = 0;
  require('../main/conversation/delivery-package-ipc').install({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { get: ref => ref === 'valid' ? f.session : null }, BrowserWindow: { fromWebContents: () => ({}) },
    dialog: { showSaveDialog: async () => { saved++; return choice; } } });
  const prepare = handlers.get('conversation-delivery-prepare'), save = handlers.get('conversation-delivery-save');
  assert.equal((await prepare({ ...event, senderFrame: {} }, 'valid', f.ids('report.md'))).ok, false);
  assert.equal((await prepare(event, 'invalid', f.ids('report.md'))).ok, false);
  const payload = await prepare(event, 'valid', f.ids('report.md'));
  assert.equal(Buffer.from(payload.data, 'base64').toString(), '# Deliver');
  assert.equal(payload.manifest.conversationTitle, '自动归档的会话', 'worker capture preserves the original session title');
  assert.equal((await save(event, 'valid', f.ids('report.md'))).canceled, true);
  choice = { filePath: path.join(f.cwd, 'downloaded.md') };
  assert.equal((await save(event, 'valid', f.ids('report.md'))).ok, true);
  assert.equal(await fs.readFile(choice.filePath, 'utf8'), '# Deliver'); assert.equal(saved, 2);
});

test('local save verifies the entire saved revision before showing a dialog or choosing remote fallback', async t => {
  const f = await fixture(t, { 'index.html': '<link href="style.css">', 'style.css': 'body{color:red}' });
  const ids = f.ids('index.html'), original = await packages.prepare(f.session, ids), handlers = new Map();
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  let dialogs = 0;
  require('../main/conversation/delivery-package-ipc').install({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { get: ref => ref === 'valid' ? f.session : null }, BrowserWindow: { fromWebContents: () => ({}) },
    dialog: { showSaveDialog: async () => { dialogs++; return { canceled: true }; } } });
  const save = handlers.get('conversation-delivery-save');
  const metadata = await handlers.get('conversation-delivery-inspect')(event, 'valid', ids);
  assert.equal(metadata.ok, true);
  assert.equal(metadata.manifest.kind, 'bundle');
  assert.equal(metadata.manifest.files.length, 2);
  assert.equal(metadata.contentType, 'application/zip');
  assert.equal(metadata.data, undefined, 'card inspection must not send complete file bytes to the renderer');
  assert.equal(dialogs, 0, 'card inspection cannot open a native download picker');
  assert.equal((await save(event, 'valid', ids, original.manifest.revision)).canceled, true);
  assert.equal(dialogs, 1);
  await fs.writeFile(path.join(f.cwd, 'style.css'), 'body{color:tan}');
  assert.equal((await save(event, 'valid', ids, original.manifest.revision)).code, 'DELIVERY_REVISION_CHANGED');
  assert.equal(dialogs, 1, 'an altered dependency cannot be saved as an older collection');
  f.session.inFlight = () => true;
  assert.equal((await save(event, 'valid', ids, original.manifest.revision)).code, undefined, 'busy is not a missing-version fallback');
  delete f.session.inFlight;
  await fs.unlink(path.join(f.cwd, 'style.css'));
  assert.equal((await save(event, 'valid', ids, original.manifest.revision)).code, 'DELIVERY_LOCAL_UNAVAILABLE');
  assert.equal((await save(event, 'missing', ids, original.manifest.revision)).code, 'DELIVERY_LOCAL_UNAVAILABLE');
  assert.equal((await save(event, 'valid', ids, 'invalid')).code, undefined);
  assert.equal(dialogs, 1);
});

test('external website resources are described without fetching them', async t => {
  const f = await fixture(t, { 'index.html': '<link href="https://cdn.example.test/style.css"><img src="https://example.test/hero.png">' });
  const got = await packages.prepare(f.session, f.ids('index.html'));
  assert.equal(got.manifest.files.length, 1);
  assert.deepEqual(got.manifest.externalDependencies, ['https://cdn.example.test/style.css', 'https://example.test/hero.png']);
});

test('multi-page websites include linked pages and their dependent resources', async t => {
  const f = await fixture(t, { 'index.html': '<a href="pages/about.html#team">关于我们</a>',
    'pages/about.html': '<img src="../assets/team.svg"><a href="../index.html">首页</a>', 'assets/team.svg': '<svg/>' });
  const got = await packages.prepare(f.session, f.ids('index.html'));
  assert.deepEqual(got.manifest.files.map(f => f.path), ['assets/team.svg', 'index.html', 'pages/about.html']);
});

test('cloud identity is revalidated after package work and after the native save dialog', async t => {
  const f = await fixture(t, { 'report.md': '# Private cloud bytes' });
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  const output = path.join(f.cwd, 'downloaded.md');
  let checks = 0, rejected = false, dialogs = 0;
  const handlers = new Map();
  require('../main/conversation/delivery-package-ipc').install({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { get: () => f.session }, BrowserWindow: { fromWebContents: () => ({}) },
    resolveSession: async () => {
      if (rejected || ++checks > 1) throw Error('cloud account changed');
      return { ...f.session, deliveryOwner: 'alice', cloudArtifactCache: true };
    }, dialog: { showSaveDialog: async () => { dialogs++; rejected = true; return { filePath: output }; } } });
  for (const action of ['inspect', 'prepare']) {
    checks = 0;
    const result = await handlers.get('conversation-delivery-' + action)(event, 'ref', f.ids('report.md'));
    assert.equal(result.ok, false); assert.equal(result.data, undefined); assert.match(result.reason, /cloud account changed/);
  }
  checks = -100;
  assert.equal((await handlers.get('conversation-delivery-save')(event, 'ref', f.ids('report.md'))).ok, false);
  assert.equal(dialogs, 1);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});
