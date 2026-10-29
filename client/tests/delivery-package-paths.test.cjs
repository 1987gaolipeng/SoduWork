'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const artifacts = require('../main/conversation/artifact-runtime');
const packages = require('../main/conversation/delivery-package');
const outputs = require('../main/pi-session/outputs');

async function fixture(t, files) {
  const parent = path.resolve(os.tmpdir());
  const cwd = await fs.mkdtemp(path.join(parent, 'soduwork-delivery-paths-'));
  assert.equal(path.dirname(path.resolve(cwd)), parent);
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(cwd, name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
  const session = { cwd, sessionId: 'path-test', snapshot: () => ({ status: 'idle' }),
    outputSnapshot() { return outputs.scan(this.cwd, 0, 1); } };
  const id = name => artifacts.snapshot(session).items.find(item => item.relative === name)?.artifactId;
  return { cwd, session, id };
}

test('artifact resolution and package manifests use one canonical path for Windows short directory aliases', async t => {
  const f = await fixture(t, { 'site/index.html': '<link href="app.css">', 'site/app.css': 'body{color:green}' });
  const canonical = await fs.realpath(f.cwd), ids = [f.id('site/index.html')];
  const resolved = artifacts.resolve(f.session, ids[0]);
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.path, await fs.realpath(path.join(f.cwd, 'site/index.html')),
    'the artifact producer must return the same native canonical path as asynchronous packaging');
  const aliased = await packages.prepare(f.session, ids);
  assert.equal(aliased.manifest.entryPath, 'site/index.html');
  assert.deepEqual(aliased.manifest.files.map(item => item.path), ['site/app.css', 'site/index.html']);
  const canonicalSession = { ...f.session, cwd: canonical };
  const canonicalIds = artifacts.snapshot(canonicalSession).items
    .filter(item => item.relative === 'site/index.html').map(item => item.artifactId);
  assert.deepEqual(canonicalIds, ids, 'path spellings cannot change the existing artifact identity');
  const direct = await packages.prepare(canonicalSession, canonicalIds);
  assert.equal(aliased.manifest.revision, direct.manifest.revision);
  assert.deepEqual(aliased.bytes, direct.bytes, 'both spellings must export the same original bytes');
});

test('a workspace directory alias retains its original relative files and bytes', async t => {
  const f = await fixture(t, { 'work/report.md': '# Final report' });
  const alias = path.join(f.cwd, 'alias');
  await fs.symlink(path.join(f.cwd, 'work'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const session = { ...f.session, cwd: alias };
  const ids = artifacts.snapshot(session).items.filter(item => item.relative === 'report.md').map(item => item.artifactId);
  const result = await packages.prepare(session, ids);
  assert.equal(result.manifest.entryPath, 'report.md');
  assert.equal(result.bytes.toString(), '# Final report');
});

for (const outside of [false, true]) test('canonical roots keep supporting directory links blocked: ' + (outside ? 'outside' : 'inside'), async t => {
  const f = await fixture(t, { 'site/index.html': '<link href="linked/app.css">', 'assets/app.css': 'body{color:red}' });
  const other = outside ? await fixture(t, { 'app.css': 'body{color:blue}' }) : null;
  const target = outside ? other.cwd : path.join(f.cwd, 'assets');
  await fs.symlink(target, path.join(f.cwd, 'site/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packages.prepare(f.session, [f.id('site/index.html')]), /不支持链接|不在当前会话工作区/);
  assert.equal(await fs.readFile(path.join(target, 'app.css'), 'utf8'), outside ? 'body{color:blue}' : 'body{color:red}');
});

test('an indexed file link cannot authorize an output outside the workspace', async t => {
  const f = await fixture(t, { 'report.md': '# Local' }), other = await fixture(t, { 'private.md': '# Private' });
  const link = path.join(f.cwd, 'linked.md');
  await fs.symlink(path.join(other.cwd, 'private.md'), link, 'file');
  const session = { ...f.session, outputSnapshot: () => ({ files: [{ path: link, name: 'linked.md', size: 9, at: Date.now() }] }) };
  const id = artifacts.snapshot(session).items.find(item => item.name === 'linked.md').artifactId;
  assert.equal(artifacts.resolve(session, id).ok, false);
  await assert.rejects(packages.prepare(session, [id]), /不在当前会话工作区|真实路径超出/);
  assert.equal(await fs.readFile(path.join(other.cwd, 'private.md'), 'utf8'), '# Private');
});
