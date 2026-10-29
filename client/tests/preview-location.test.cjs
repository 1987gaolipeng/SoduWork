'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const runtime = require('../main/conversation/artifact-runtime');

test('managed preview addresses map to real files only for their own conversation and active origin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-location-'));
  try {
    const entry = path.join(root, '中文 空格#%.html'), other = path.join(root, 'second page.html');
    fs.writeFileSync(entry, '<title>First local page</title>');
    fs.writeFileSync(other, '<title>Second local page</title>');
    const running = await runtime.previewInput({ cwd: root }, 'location-owner', entry);
    assert.equal(running.ok, true);
    const suffix = '?q=%E4%B8%AD&literal=%23%3F#part';
    assert.equal(runtime.previewLocation('location-owner', running.url + suffix), pathToFileURL(entry).href + suffix);
    assert.equal(runtime.previewLocation('location-owner', new URL('second%20page.html', running.url).href), pathToFileURL(other).href);
    // Application fallback may serve the entry bytes, but its real route is
    // still a URL. Actual extensionless files/directories remain file previews.
    assert.equal(runtime.previewLocation('location-owner', new URL('/route/42?q=2#section', running.url).href), '');
    const extensionless = path.join(root, 'README'); fs.writeFileSync(extensionless, 'Document');
    const directory = path.join(root, 'site'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'index.html'), '<title>Directory index</title>');
    assert.equal(runtime.previewLocation('location-owner', new URL('/README?q=2', running.url).href), pathToFileURL(extensionless).href + '?q=2');
    assert.equal(runtime.previewLocation('location-owner', new URL('/site/', running.url).href), pathToFileURL(path.join(directory, 'index.html')).href);
    for (const url of ['https://example.test/index.html', 'http://127.0.0.1:12345/index.html',
      new URL('/%2e%2e%2fprivate.html', running.url).href, new URL('/missing.html', running.url).href])
      assert.equal(runtime.previewLocation('location-owner', url), '', url);
    assert.equal(runtime.previewLocation('other-owner', running.url), '');
    fs.unlinkSync(other);
    assert.equal(runtime.previewLocation('location-owner', new URL('second%20page.html', running.url).href), '');
    runtime.closeRef('location-owner');
    assert.equal(runtime.previewLocation('location-owner', running.url), '');
  } finally { runtime.closeRef('location-owner'); fs.rmSync(root, { recursive: true, force: true }); }
});

test('managed address mapping and location actions reject a workspace symlink to an outside file', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-symlink-'));
  try {
    const root = path.join(temp, 'workspace'); fs.mkdirSync(root);
    const entry = path.join(root, 'index.html'), outside = path.join(temp, 'private.html'), escaped = path.join(root, 'escaped.html');
    fs.writeFileSync(entry, '<title>Local</title>'); fs.writeFileSync(outside, '<title>Outside</title>');
    fs.symlinkSync(outside, escaped, 'file');
    const session = { cwd: root, outputs: () => [{ name: 'escaped.html', path: escaped, size: 22 }] };
    const running = await runtime.previewInput(session, 'link-owner', entry);
    assert.equal(running.ok, true);
    assert.equal(runtime.previewLocation('link-owner', new URL('/escaped.html', running.url).href), '');
    const item = runtime.snapshot(session).items.find(row => row.name === 'escaped.html');
    if (item) assert.equal((await runtime.action(session, 'link-owner', item.artifactId, 'location', {})).ok, false);
  } finally { runtime.closeRef('link-owner'); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('file location actions resolve an indexed artifact inside its current workspace without publishing paths in its index', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-artifact-location-'));
  try {
    const target = path.join(root, 'report.md'); fs.writeFileSync(target, '# Report');
    const session = { cwd: root, outputSnapshot: () => ({ files: [{ name: 'report.md', relative: 'report.md', path: target, at: Date.now(), size: 8 }] }) };
    const item = runtime.snapshot(session).items.find(row => row.name === 'report.md');
    assert.ok(item);
    assert.equal(Object.hasOwn(runtime.decorate('file-owner', { items: [item] })[0], 'path'), false);
    assert.deepEqual(await runtime.action(session, 'file-owner', item.artifactId, 'location', {}), { ok: true, path: fs.realpathSync.native(target) });
    assert.equal((await runtime.action(session, 'file-owner', 'art_missing', 'location', {})).ok, false);
    fs.unlinkSync(target);
    assert.equal((await runtime.action(session, 'file-owner', item.artifactId, 'location', {})).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('authorized document and image reads expose their real location without adding paths to the public index', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-read-location-'));
  try {
    const doc = path.join(root, 'report.md'), png = path.join(root, 'image.png');
    fs.writeFileSync(doc, '# Report');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0UAAAAASUVORK5CYII=', 'base64'));
    const session = { cwd: root, outputs: () => [doc, png].map(target => ({ path: target, name: path.basename(target), size: fs.statSync(target).size })) };
    const items = runtime.snapshot(session).items;
    for (const item of items) {
      const action = item.kind === 'image' ? 'image-full' : 'read';
      const read = await runtime.action(session, 'read-location', item.artifactId, action, {});
      assert.equal(read.ok, true);
      assert.equal(read.path, fs.realpathSync.native(item.path));
      assert.equal(Object.hasOwn(runtime.decorate('read-location', { items: [item] })[0], 'path'), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
