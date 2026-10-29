'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
const localSource = fs.readFileSync(path.join(__dirname, '..', 'api-library-local.js'), 'utf8');
const bytes = Buffer.from([0, 255, 13, 10, 42]);
const binary = () => ({ ok: true, name: 'private.bin', mimeType: 'application/octet-stream', data: bytes.toString('base64') });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const stale = error => error.code === 'STALE_TASK_SCOPE';
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let user = 'alice';
  const values = new Map([['soduwork_work_hub_url', 'http://hub-a:8989']]);
  const calls = [], downloads = [], objectUrls = [], nativeCalls = [];
  const bridge = {
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: user }, session: 'session-' + user, expiresIn: 1800 }),
    localLibrary: { context: async () => ({ owner: 'owner-' + user }), call: async (action, payload) => {
      if (action === 'outputStatus') return { ok: true, item: null };
      nativeCalls.push({ action, payload }); return { ok: true, item: { id: 'local-one' } };
    } },
  };
  const window = { __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true }, soduWorkAPI: bridge, dispatchEvent() {} };
  const h = { bridge, calls, downloads, objectUrls, nativeCalls,
    fetch: async () => new Response(JSON.stringify({ ok: true })),
  };
  class TestURL extends URL {
    static createObjectURL(blob) { objectUrls.push(blob); return 'blob:test'; }
    static revokeObjectURL() {}
  }
  const context = {
    window, User: { id: 'device-1', name: 'Test' }, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); return h.fetch(url, options); },
    document: { body: { appendChild() {} }, createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }) },
    URL: TestURL, URLSearchParams, FormData, Blob, File, Response, Uint8Array, atob, AbortController,
    FileReader: class { async readAsDataURL(blob) { this.result = 'data:application/octet-stream;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload(); } },
    CustomEvent: class {}, console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  };
  vm.runInNewContext(localSource, context, { filename: 'api-library-local.js' });
  vm.runInNewContext(source, context, { filename: 'api.js' });
  h.api = window.SoduWorkAPI;
  h.signIn = async next => { user = next; await h.api.registerClient(); };
  h.switchScope = async kind => {
    if (kind === 'user') await h.signIn('bob');
    else h.api.setHubEnvironment('development', 'http://hub-b:8989');
  };
  return h;
}

for (const scope of ['user', 'hub']) {
  test(`local output cannot upload into a changed ${scope}`, async () => {
    const h = harness(), read = deferred(); await h.signIn('alice');
    h.bridge.conversationSession = { readOutputBinary: () => read.promise };
    const result = h.api.uploadLibraryOutput('session-a', { path: 'private.bin' });
    await h.switchScope(scope); read.resolve(binary());
    await assert.rejects(result, stale);
    assert.equal(h.calls.length, 0);
  });

  for (const stage of ['listing', 'reading']) {
    test(`task attachment cancels after ${stage} when ${scope} changes`, async () => {
      const h = harness(), wait = deferred(); await h.signIn('alice');
      let reads = 0;
      h.api.listAttachments = stage === 'listing' ? () => wait.promise : async () => [{ id: 'a-1', filename: 'private.bin' }];
      h.api.attachmentUrl = () => 'http://hub-a:8989/attachment/a-1';
      h.bridge.readAttachmentBinary = () => { reads++; return stage === 'reading' ? wait.promise : Promise.resolve(binary()); };
      const result = h.api.uploadLibraryOutput('', { taskId: 't-1', attachmentId: 'a-1' });
      await tick(); await h.switchScope(scope);
      wait.resolve(stage === 'listing' ? [{ id: 'a-1', filename: 'private.bin' }] : binary());
      await assert.rejects(result, stale);
      assert.equal(reads, stage === 'listing' ? 0 : 1);
      assert.equal(h.calls.length, 0);
    });
  }

  test(`binary response is discarded and its stream cancelled after ${scope} changes`, async () => {
    const h = harness(); await h.signIn('alice');
    let controller, cancelled = false;
    h.fetch = async () => new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { cancelled = true; } }));
    const result = h.api.readLibraryBinary('private');
    await tick(); await h.switchScope(scope); controller.enqueue(bytes);
    await assert.rejects(result, stale);
    assert.equal(cancelled, true);
  });

  test(`a delayed download cannot save old bytes after ${scope} changes`, async () => {
    const h = harness(), body = deferred(); await h.signIn('alice');
    h.fetch = async () => ({ ok: true, status: 200, blob: () => body.promise });
    const result = h.api.downloadLibraryItem('private', 'private.bin');
    await tick(); await h.switchScope(scope); body.resolve(new Blob([bytes]));
    await assert.rejects(result, stale);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.objectUrls.length, 0);
  });

  test(`upload completion from an old ${scope} is not returned to the new identity`, async () => {
    const h = harness(), body = deferred(); await h.signIn('alice');
    h.fetch = async () => ({ ok: true, status: 200, text: () => body.promise });
    const result = h.api.uploadLibraryFile(new File([bytes], 'private.bin'), '', 'nfs');
    await tick(); await h.switchScope(scope); body.resolve('{"ok":true,"item":{"id":"private"}}');
    await assert.rejects(result, stale);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].url, /hub-a/);
    assert.equal(h.calls[0].options.headers.Authorization, 'Device session-alice');
  });
}

for (const kind of ['local', 'attachment']) {
  test(`${kind} output retains exact bytes when the identity remains unchanged`, async () => {
    const h = harness(); await h.signIn('alice');
    h.bridge.conversationSession = { readOutputBinary: async () => binary() };
    h.bridge.readAttachmentBinary = async () => binary();
    h.api.listAttachments = async () => [{ id: 'a-1', filename: 'private.bin' }];
    h.api.attachmentUrl = () => 'http://hub-a:8989/attachment/a-1';
    const result = await h.api.uploadLibraryOutput('session-a', kind === 'local'
      ? { path: 'private.bin' } : { taskId: 't-1', attachmentId: 'a-1' });
    assert.equal(result.ok, true);
    assert.equal(h.calls.length, 0);
    const upload = h.nativeCalls[0];
    assert.equal(upload.action, 'upload');
    assert.deepEqual(Buffer.from(upload.payload.dataBase64, 'base64'), bytes);
    assert.equal(upload.payload.name, 'private.bin');
  });
}

test('chat and requirement attachment aliases resolve the same durable receipt before any binary read', async () => {
  const h = harness(); await h.signIn('alice');
  const key = h.api.libraryOutputKey('', { taskId: 'task', attachmentId: 'attachment', at: 1 });
  h.bridge.localLibrary.call = async (action, payload) => {
    assert.equal(action, 'outputStatus'); assert.equal(payload.outputKey, key);
    return { ok: true, item: { id: 'local-saved' } };
  };
  h.bridge.conversationSession = { readOutputBinary: async () => assert.fail('saved bytes must not be read again') };
  const result = await h.api.uploadLibraryOutput('reopened-chat', {
    cloudTaskId: 'task', remoteAttachmentId: 'attachment', artifactId: 'local-artifact', at: 999,
  });
  assert.equal(result.item.id, 'local-saved'); assert.equal(result.duplicate, true);
});

test('a saved receipt from a previous account cannot mark the new account saved', async () => {
  const h = harness(); await h.signIn('alice'); const pending = deferred();
  h.bridge.localLibrary.call = async () => pending.promise;
  const result = h.api.uploadLibraryOutput('chat', { taskId: 'task', attachmentId: 'attachment' });
  await tick(); await h.signIn('bob'); pending.resolve({ ok: true, item: { id: 'local-private' } });
  await assert.rejects(result, stale);
});

test('all library mutations retain their original scope through authentication bootstrap', async () => {
  const operations = [
    api => api.createLibraryFolder('new', '', 'nfs'), api => api.deleteLibraryFolder('old'),
    api => api.updateLibraryFolder('old', { name: 'new' }), api => api.createLibraryItem({ content: 'private', storage: 'nfs' }),
    api => api.updateLibraryItem('old', { content: 'private' }), api => api.deleteLibraryItem('old'),
    api => api.restoreLibraryItem('old'), api => api.purgeLibraryItem('old'), api => api.emptyLibraryTrash('nfs'),
  ];
  for (const operation of operations) {
    const h = harness();
    // The renderer starts unbound; bootstrap resolves a different bound user.
    await assert.rejects(operation(h.api), stale);
    assert.equal(h.calls.length, 0);
  }
});

test('library sharing keeps the organization recipient scope and optional note', async () => {
  const h = harness(); await h.signIn('alice');
  const responses = [
    { ok: true, members: [{ id: 'alice', isMe: true }, { id: 'bob', isMe: false }] },
    { ok: true, shared: 1, recipients: [{ id: 'bob', delivered: false }] },
  ];
  h.fetch = async (url, options) => {
    const body = responses.shift();
    assert.ok(body, `unexpected request: ${url}`);
    if (options?.body) {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload, { recipientUserIds: ['bob'], note: '请查收' });
      assert.equal(options.method, 'POST');
      assert.match(url, /\/library\/items\/item-1\/share$/);
    } else {
      assert.match(url, /\/library\/share-members$/);
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const directory = await h.api.listLibraryShareMembers();
  assert.deepEqual(Array.from(directory.members, member => member.id), ['alice', 'bob']);
  const result = await h.api.shareLibraryItem('item-1', ['bob'], '请查收');
  assert.equal(result.shared, 1);
  assert.equal(responses.length, 0);
});

test('unchanged binary reads and downloads still deliver their original bytes', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
  const binaryResult = await h.api.readLibraryBinary('one');
  assert.deepEqual(Buffer.from(await binaryResult.blob.arrayBuffer()), bytes);
  assert.equal((await h.api.downloadLibraryItem('one', 'one.bin')).ok, true);
  assert.deepEqual(h.downloads, ['one.bin']);
  assert.deepEqual(Buffer.from(await h.objectUrls[0].arrayBuffer()), bytes);
});

test('public artifact IDs resolve through the native boundary without a renderer path', async () => {
  const h = harness(); await h.signIn('alice');
  const reads = [];
  h.bridge.conversationSession = { readOutputBinary: async (ref, target) => { reads.push({ ref, target }); return binary(); } };
  assert.equal((await h.api.uploadLibraryOutput('session-a', { artifactId: 'opaque-1', name: 'report.html' })).ok, true);
  assert.equal(reads[0].ref, 'session-a');
  assert.equal(reads[0].target.artifactId, 'opaque-1');
  assert.equal(Object.keys(reads[0].target).join(','), 'artifactId');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(Buffer.from(h.nativeCalls[0].payload.dataBase64, 'base64'), bytes);
});

test('task outputs carrying a path use the authenticated attachment reader', async () => {
  const h = harness(); await h.signIn('alice');
  let attachmentReads = 0;
  h.bridge.conversationSession = { readOutputBinary: async () => { throw Error('Wrong local reader'); } };
  h.bridge.readAttachmentBinary = async () => { attachmentReads++; return binary(); };
  h.api.listAttachments = async () => [{ id: 'a-1', filename: 'private.bin' }];
  h.api.attachmentUrl = () => 'http://hub-a:8989/attachment/a-1';
  assert.equal((await h.api.uploadLibraryOutput('session-a', { taskId: 't-1', attachmentId: 'a-1', path: '/server/private.bin' })).ok, true);
  assert.equal(attachmentReads, 1);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(Buffer.from(h.nativeCalls[0].payload.dataBase64, 'base64'), bytes);
});

for (const scope of ['user', 'hub']) {
  test(`delivery upload completion cannot change the new ${scope}'s UI`, async () => {
    const h = harness(), body = deferred(); await h.signIn('alice');
    h.fetch = async () => ({ ok: true, status: 200, text: () => body.promise });
    const result = h.api.publishDelivery({ manifest: { revision: 'one' }, data: bytes.toString('base64'), filename: 'file.bin' });
    await tick(); await h.switchScope(scope); body.resolve('{"ok":true}');
    await assert.rejects(result, stale); assert.equal(h.calls.length, 1);
    assert.deepEqual(Buffer.from(await h.calls[0].options.body.get('file').arrayBuffer()), bytes);
  });
  test(`delivery member read cancels when ${scope} changes while streaming`, async () => {
    const h = harness(); await h.signIn('alice'); let controller, canceled = false;
    h.fetch = async () => new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { canceled = true; } }));
    const result = h.api.readDeliveryFile('one', '资料/report.md'); await tick(); await h.switchScope(scope); controller.enqueue(bytes);
    await assert.rejects(result, stale); assert.equal(canceled, true);
    assert(h.calls[0].url.endsWith('/files/%E8%B5%84%E6%96%99/report.md'));
  });
}

test('delivery member read preserves bytes and refuses an oversized declared response', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(bytes);
  assert.deepEqual(Buffer.from(await (await h.api.readDeliveryFile('one', 'file.bin')).arrayBuffer()), bytes);
  h.fetch = async () => new Response(bytes, { headers: { 'content-length': String(65 * 1024 * 1024) } });
  await assert.rejects(h.api.readDeliveryFile('one', 'file.bin'), /文件较大/);
});

test('preview reads preserve the read-only query without changing editor requests', async () => {
  const h = harness(); await h.signIn('alice');
  await h.api.readLibraryContent('text'); await h.api.readLibraryContent('text', { preview: true });
  assert.ok(h.calls[0].url.endsWith('/library/items/text/content'));
  assert.ok(h.calls[1].url.endsWith('/library/items/text/content?preview=true'));
});

test('selected delivery member is the file downloaded, opened and revealed', async () => {
  const h = harness(); await h.signIn('alice'); const handed = [];
  h.fetch = async () => new Response(bytes);
  h.bridge.openLibraryExternally = async payload => { handed.push(payload); };
  h.bridge.revealLibraryItem = async payload => { handed.push(payload); };
  const member = { path: 'documents/report.docx' };
  await h.api.downloadLibraryItem('bundle', 'whole.zip', member);
  await h.api.openLibraryExternally('bundle', member);
  await h.api.revealLibraryItem('bundle', member);
  assert.deepEqual(h.downloads, ['report.docx']);
  assert.ok(h.calls.every(call => call.url.endsWith('/deliveries/bundle/files/documents/report.docx')));
  assert.equal(handed.length, 2);
  for (const payload of handed) { assert.equal(payload.filename, 'report.docx'); assert.deepEqual(Buffer.from(payload.data, 'base64'), bytes); }
});

test('account change during native handoff cancels the previous-account file', async () => {
  const h = harness(), wait = deferred(); await h.signIn('alice'); let opened = 0;
  h.api.readDeliveryFile = () => wait.promise;
  h.bridge.openLibraryExternally = async () => { opened++; }; h.bridge.revealLibraryItem = async () => {};
  const result = h.api.openLibraryExternally('bundle', { path: 'report.docx' });
  await h.switchScope('user'); wait.resolve(new Blob([bytes]));
  await assert.rejects(result, stale); assert.equal(opened, 0);
});

test('ZIP manifest and decoded member preview keep authenticated, encoded archive routes', async () => {
  const h = harness(); await h.signIn('alice');
  const manifest = { archive: { files: [{ path: '资料/a & b.md', filename: 'a & b.md', size: 5, isDirectory: false }] } };
  h.fetch = async () => new Response(JSON.stringify(manifest));
  assert.deepEqual(JSON.parse(JSON.stringify(await h.api.getLibraryArchive('zip id'))), manifest);
  h.fetch = async () => new Response(JSON.stringify({ ok: true, content: '中文预览', preview: { encoding: 'gb18030' } }));
  const preview = await h.api.readLibraryArchiveFile('zip id', '资料/a & b.md', { preview: true });
  assert.equal(preview.content, '中文预览'); assert.equal(preview.preview.encoding, 'gb18030');
  assert.ok(h.calls[0].url.endsWith('/library/items/zip%20id/archive'));
  const url = new URL(h.calls[1].url);
  assert.equal(url.pathname, '/api/v1/library/items/zip%20id/archive/file');
  assert.equal(url.searchParams.get('path'), '资料/a & b.md'); assert.equal(url.searchParams.get('preview'), 'true');
  for (const call of h.calls) {
    assert.equal(call.options.headers.Authorization, 'Device session-alice');
    assert.equal(call.options.redirect, 'error');
    assert.ok(!call.url.includes('session-alice'));
  }
});

test('ZIP member reads reject unsafe paths before sending a request', async () => {
  const h = harness(); await h.signIn('alice');
  for (const member of ['', '/private.txt', '../private.txt', 'docs/../private.txt', 'docs/./file', 'docs//file', 'C:/private.txt', 'docs\\private.txt', 'docs/\0file']) {
    await assert.rejects(h.api.readLibraryArchiveFile('zip', member), /路径/);
  }
  assert.equal(h.calls.length, 0);
});

test('ZIP binary member preserves bytes, content type and refuses redirected requests', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(bytes, { headers: { 'content-type': 'image/png' } });
  const blob = await h.api.readLibraryArchiveFile('zip', '图片/a #1.png');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes); assert.equal(blob.type, 'image/png');
  assert.equal(new URL(h.calls[0].url).searchParams.get('path'), '图片/a #1.png');
  assert.equal(h.calls[0].options.redirect, 'error');
  assert.equal(h.calls[0].options.headers.Authorization, 'Device session-alice');
});

for (const scope of ['user', 'hub']) {
  for (const decoded of [false, true]) {
    test(`ZIP ${decoded ? 'decoded preview' : 'manifest'} discards delayed JSON after ${scope} changes`, async () => {
      const h = harness(), body = deferred(); await h.signIn('alice');
      h.fetch = async () => ({ ok: true, status: 200, text: () => body.promise });
      const pending = decoded ? h.api.readLibraryArchiveFile('zip', 'private.md', { preview: true }) : h.api.getLibraryArchive('zip');
      await tick(); await h.switchScope(scope); body.resolve('{"ok":true,"content":"private"}');
      await assert.rejects(pending, stale);
    });
  }
  test(`ZIP member response cancels while streaming after ${scope} changes`, async () => {
    const h = harness(); await h.signIn('alice'); let controller, canceled = false;
    h.fetch = async () => new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { canceled = true; } }));
    const pending = h.api.readLibraryArchiveFile('zip', 'private.bin');
    await tick(); await h.switchScope(scope); controller.enqueue(bytes);
    await assert.rejects(pending, stale); assert.equal(canceled, true);
  });
  test(`ZIP member cancels an unread response after ${scope} changes`, async () => {
    const h = harness(), response = deferred(); await h.signIn('alice'); let canceled = false;
    h.fetch = () => response.promise;
    const pending = h.api.readLibraryArchiveFile('zip', 'private.bin');
    await h.switchScope(scope);
    response.resolve(new Response(new ReadableStream({ cancel() { canceled = true; } })));
    await assert.rejects(pending, stale); assert.equal(canceled, true);
  });
}

test('ZIP JSON requests stay bound to the initiating identity during authentication bootstrap', async () => {
  for (const operation of [api => api.getLibraryArchive('zip'), api => api.readLibraryArchiveFile('zip', 'private.md', { preview: true })]) {
    const h = harness();
    await assert.rejects(operation(h.api), stale);
    assert.equal(h.calls.length, 0);
  }
});

test('ZIP binary bounds both advertised size and chunked size and cancels oversized streams', async () => {
  const h = harness(); await h.signIn('alice');
  let canceled = 0;
  h.fetch = async () => new Response(new ReadableStream({ cancel() { canceled++; } }), { headers: { 'content-length': String(65 * 1024 * 1024) } });
  await assert.rejects(h.api.readLibraryArchiveFile('zip', 'large.bin'), /64MB/); assert.equal(canceled, 1);
  const chunk = new Uint8Array(32 * 1024 * 1024);
  h.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(chunk); c.enqueue(chunk); c.enqueue(chunk); }, cancel() { canceled++; } }));
  await assert.rejects(h.api.readLibraryArchiveFile('zip', 'large.bin'), /64MB/); assert.equal(canceled, 2);
});

test('ZIP typed failures retain the server message and error code', async () => {
  const h = harness(); await h.signIn('alice');
  h.fetch = async () => new Response(JSON.stringify({ detail: { code: 'ARCHIVE_ENCRYPTED', message: '加密 ZIP 无法预览', retryable: false } }), { status: 422 });
  await assert.rejects(h.api.readLibraryArchiveFile('zip', 'private.bin'), e => e.status === 422 && e.code === 'ARCHIVE_ENCRYPTED' && e.message === '加密 ZIP 无法预览' && e.retryable === false);
});

test('selected ZIP member is downloaded, opened and revealed through the archive endpoint', async () => {
  const h = harness(); await h.signIn('alice'); const handed = [];
  h.fetch = async () => new Response(bytes);
  h.bridge.openLibraryExternally = async payload => { handed.push(payload); };
  h.bridge.revealLibraryItem = async payload => { handed.push(payload); };
  const member = { path: 'documents/report.docx', archive: true };
  await h.api.downloadLibraryItem('zip', 'whole.zip', member);
  await h.api.openLibraryExternally('zip', member);
  await h.api.revealLibraryItem('zip', member);
  assert.deepEqual(h.downloads, ['report.docx']);
  assert.ok(h.calls.every(call => new URL(call.url).pathname === '/api/v1/library/items/zip/archive/file'));
  assert.ok(h.calls.every(call => new URL(call.url).searchParams.get('path') === member.path));
  assert.equal(handed.length, 2);
  for (const payload of handed) { assert.equal(payload.filename, 'report.docx'); assert.deepEqual(Buffer.from(payload.data, 'base64'), bytes); }
});

test('ZIP native handoff discards a previously selected file when the account changes', async () => {
  const h = harness(), body = deferred(); await h.signIn('alice'); let opened = 0, reads = 0;
  h.api.readLibraryArchiveFile = () => { reads++; return body.promise; };
  h.bridge.openLibraryExternally = async () => { opened++; }; h.bridge.revealLibraryItem = async () => {};
  const pending = h.api.openLibraryExternally('zip', { path: 'report.docx', archive: true });
  assert.equal(reads, 1);
  await h.switchScope('user'); body.resolve(new Blob([bytes]));
  await assert.rejects(pending, stale); assert.equal(opened, 0);
});
