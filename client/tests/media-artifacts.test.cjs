'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const media = require('../main/pi-session/media-artifacts');

test('simultaneous recovery and tool results download an attachment only once', async () => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-video-concurrent-'));
  const data = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const artifact = { kind: 'video', attachmentId: 'video-parallel-1234',
    url: '/api/v1/attachments/video-parallel-1234?ticket=signed',
    filename: 'once.mp4', mimeType: 'video/mp4', size: data.length };
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(data, { headers: { 'content-type': 'video/mp4' } });
  };
  try {
    const files = await Promise.all(Array.from({ length: 3 }, () =>
      media.materialize(artifact, { hub: 'https://hub.test' }, cwd, fetchImpl)));
    assert.equal(calls, 1);
    assert.equal(new Set(files.map(file => file.path)).size, 1);
  } finally { await fs.promises.rm(cwd, { recursive: true, force: true }); }
});

test('atomic media index replacement works when file protection requires JSON temporary files', async t => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-media-protected-index-'));
  const indexFile = path.join(cwd, 'outputs', '.soduwork-media-index.json');
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    // Windows file protection can reject a rename across protected file types,
    // even when both files belong to the same directory on the same volume.
    if (to === indexFile && path.extname(from) !== '.json') {
      throw Object.assign(Error('File protection rejected mixed file types'), {code: 'EXDEV'});
    }
    return rename(from, to);
  });
  const video = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const artifact = {kind: 'video', attachmentId: 'protected-index-1234',
    url: '/api/v1/attachments/protected-index-1234?ticket=synthetic',
    filename: 'once.mp4', mimeType: 'video/mp4', size: video.length};
  let downloads = 0;
  const download = async () => {downloads++; return new Response(video, {headers: {'content-type': 'video/mp4'}});};
  try {
    const first = await media.materialize(artifact, {hub: 'https://hub.test'}, cwd, download);
    const second = await media.materialize(artifact, {hub: 'https://hub.test'}, cwd, download);
    assert.equal(downloads, 1, 'persisted attachment index must prevent a second download');
    assert.equal(first.path, second.path);
    assert.equal(second.changedInTurn, false);
    await media.materialize({...artifact, attachmentId: 'protected-index-5678', filename: 'other.mp4',
      url: '/api/v1/attachments/protected-index-5678?ticket=synthetic'}, {hub: 'https://hub.test'}, cwd, download);
    const original = await media.materialize(artifact, {hub: 'https://hub.test'}, cwd, download);
    assert.equal(downloads, 2, 'replacing the existing index must retain the earlier attachment');
    assert.equal(original.path, first.path);
    assert.equal(original.changedInTurn, false);
    assert.deepEqual(JSON.parse(await fs.promises.readFile(indexFile, 'utf8')),
      {'https://hub.test:protected-index-1234': 'once.mp4', 'https://hub.test:protected-index-5678': 'other.mp4'});
    assert.deepEqual((await fs.promises.readdir(path.dirname(indexFile))).sort(), ['.soduwork-media-index.json', 'once.mp4', 'other.mp4']);
  } finally {await fs.promises.rm(cwd, {recursive: true, force: true});}
});

test('truncated video is rejected without leaving a completed or partial file', async () => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-video-truncated-'));
  const data = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  try {
    await assert.rejects(media.materialize({ kind: 'video', attachmentId: 'video-short-1234',
      url: '/api/v1/attachments/video-short-1234?ticket=signed', filename: 'short.mp4',
      mimeType: 'video/mp4', size: data.length + 10 }, { hub: 'https://hub.test' }, cwd,
    async () => new Response(data, { headers: { 'content-type': 'video/mp4' } })), /下载不完整/);
    assert.deepEqual(await fs.promises.readdir(path.join(cwd, 'outputs')), []);
  } finally { await fs.promises.rm(cwd, { recursive: true, force: true }); }
});

test('extracts a video artifact from the plugin MCP JSON result', () => {
  const event = {
    type: 'tool_execution_end', toolName: 'bash', isError: false,
    result: { content: [{ type: 'text', text: JSON.stringify({
      server: 'soduwork-media', tool: 'generate_video', result: {
        ok: true, artifact: {
          kind: 'video', attachmentId: 'video-12345678',
          filename: 'launch.mp4', mimeType: 'video/mp4', size: 42,
          url: '/api/v1/attachments/video-12345678?ticket=signed-ticket',
        },
      },
    }) }] },
  };
  assert.deepEqual(media.fromToolEvent(event), {
    kind: 'video', attachmentId: 'video-12345678',
    url: '/api/v1/attachments/video-12345678?ticket=signed-ticket',
    filename: 'launch.mp4', mimeType: 'video/mp4', size: 42,
  });
});

test('materializes a signed Hub attachment into the conversation outputs folder', async () => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-video-'));
  const calls = [];
  const video = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  try {
    const file = await media.materialize({
      kind: 'video', attachmentId: 'video-12345678',
      url: '/api/v1/attachments/video-12345678?ticket=signed-ticket',
      filename: '../launch.mp4', mimeType: 'video/mp4',
    }, { hub: 'https://hub.test' }, cwd, async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true, status: 200,
        headers: { get: name => name === 'content-length' ? String(video.length) :
          (name === 'content-type' ? 'video/mp4' : '') },
        arrayBuffer: async () => video,
      };
    });
    assert.equal(file.relative, 'outputs/launch.mp4');
    assert.deepEqual(await fs.promises.readFile(file.path), video);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hub.test/api/v1/attachments/video-12345678?ticket=signed-ticket');
    assert.equal(calls[0].options.redirect, 'error');
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
});

test('streams a video response to the atomic output file without arrayBuffer buffering', async () => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-video-stream-'));
  const head = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  const tail = Uint8Array.from([0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4]);
  try {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(head);
        controller.enqueue(tail);
        controller.close();
      },
    });
    const file = await media.materialize({
      kind: 'video', attachmentId: 'video-12345678',
      url: '/api/v1/attachments/video-12345678?ticket=signed-ticket',
      filename: 'stream.tmp', mimeType: 'video/mp4', size: head.length + tail.length,
    }, { hub: 'https://hub.test' }, cwd, async () => ({
      ok: true, status: 200, body,
      headers: { get: name => name === 'content-type' ? 'video/mp4' : '' },
      arrayBuffer: async () => { throw new Error('must not buffer'); },
    }));
    assert.equal(file.name, 'stream.mp4');
    assert.equal(file.size, head.length + tail.length);
    assert.deepEqual(await fs.promises.readFile(file.path), Buffer.concat([head, tail]));
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
});

test('refreshes an expired attachment ticket with the authenticated device session', async () => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-video-refresh-'));
  const video = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  const calls = [];
  try {
    const file = await media.materialize({
      kind: 'video', attachmentId: 'video-12345678',
      url: '/api/v1/attachments/video-12345678?ticket=expired',
      filename: 'refresh.mp4', mimeType: 'video/mp4', size: video.length,
    }, { hub: 'https://hub.test', session: 'device-session' }, cwd, async (url, options) => {
      calls.push({ url, options });
      if (String(url).endsWith('?ticket=expired')) return { ok: false, status: 401 };
      if (String(url).endsWith('/access')) return {
        ok: true, status: 200,
        json: async () => ({
          url: '/api/v1/attachments/video-12345678?ticket=fresh',
        }),
      };
      return {
        ok: true, status: 200,
        headers: { get: name => name === 'content-type' ? 'video/mp4' : '' },
        arrayBuffer: async () => video,
      };
    });
    assert.equal(file.name, 'refresh.mp4');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.headers.Authorization, 'Device device-session');
    assert.match(calls[2].url, /ticket=fresh$/);
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
});

test('persists attachment ids so reopening a conversation does not download duplicates', async () => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-video-index-'));
  const video = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  let downloads = 0;
  const artifact = {
    kind: 'video', attachmentId: 'video-index-1234',
    url: '/api/v1/attachments/video-index-1234?ticket=signed-ticket',
    filename: 'once.mp4', mimeType: 'video/mp4', size: video.length,
  };
  const fetchImpl = async () => {
    downloads += 1;
    return {
      ok: true, status: 200,
      headers: { get: name => name === 'content-type' ? 'video/mp4' : '' },
      arrayBuffer: async () => video,
    };
  };
  try {
    const first = await media.materialize(artifact, { hub: 'https://hub.test' }, cwd, fetchImpl);
    const second = await media.materialize(artifact, { hub: 'https://hub.test' }, cwd, fetchImpl);
    assert.equal(downloads, 1);
    assert.equal(second.path, first.path);
    assert.equal(second.changedInTurn, false);
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
});

test('recovers completed conversation media through the authenticated index endpoint', async () => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-video-recover-'));
  const video = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  const calls = [];
  try {
    const result = await media.recover(
      { hub: 'https://hub.test', session: 'device-session' }, 'chat/a', cwd,
      async (url, options) => {
        calls.push({ url, options });
        if (String(url).includes('/conversations/')) return {
          ok: true, status: 200,
          json: async () => ({ items: [{
            kind: 'video', attachmentId: 'video-recover-1',
            url: '/api/v1/attachments/video-recover-1?ticket=fresh',
            filename: 'recovered.mp4', mimeType: 'video/mp4', size: video.length,
          }] }),
        };
        return {
          ok: true, status: 200,
          headers: { get: name => name === 'content-type' ? 'video/mp4' : '' },
          arrayBuffer: async () => video,
        };
      });
    assert.equal(result.errors.length, 0);
    assert.equal(result.files[0].name, 'recovered.mp4');
    assert.equal(calls[0].options.headers.Authorization, 'Device device-session');
    assert.match(calls[0].url, /conversations\/chat%2Fa\/media$/);
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
});

test('ignores a video-shaped object that is not the trusted media gateway result', () => {
  const event = {
    type: 'tool_execution_end', toolName: 'bash', isError: false,
    result: { content: [{ type: 'text', text: JSON.stringify({
      ok: true, artifact: {
        kind: 'video', attachmentId: 'video-12345678', filename: 'invoice.exe',
        mimeType: 'video/mp4',
        url: '/api/v1/attachments/video-12345678?ticket=signed-ticket',
      },
    }) }] },
  };
  assert.equal(media.fromToolEvent(event), null);
});

test('forces a safe video extension from the trusted MIME type', () => {
  assert.equal(media._safeFilename('invoice.exe', 'video/mp4'), 'invoice.mp4');
  assert.equal(media._safeFilename('../clip.txt', 'video/webm'), 'clip.webm');
  assert.throws(() => media._safeFilename('clip.exe', 'application/octet-stream'), /不受支持/);
});

test('rejects a non-video body even when the response claims video/mp4', async () => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-video-invalid-'));
  try {
    await assert.rejects(() => media.materialize({
      kind: 'video', attachmentId: 'video-12345678',
      url: '/api/v1/attachments/video-12345678?ticket=signed-ticket',
      filename: 'invoice.exe', mimeType: 'video/mp4',
    }, { hub: 'https://hub.test' }, cwd, async () => ({
      ok: true, status: 200,
      headers: { get: name => name === 'content-type' ? 'video/mp4' : '' },
      arrayBuffer: async () => Buffer.from('not a video'),
    })), /不是可识别的视频文件/);
    assert.deepEqual(await fs.promises.readdir(path.join(cwd, 'outputs')), []);
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
});

test('rejects arbitrary external media URLs', async () => {
  await assert.rejects(
    media.materialize({
      kind: 'video', attachmentId: 'video-12345678',
      url: 'https://evil.test/video.mp4', filename: 'evil.mp4',
    }, { hub: 'https://hub.test' }, os.tmpdir(), async () => ({ ok: true })),
    /受信任的附件地址/,
  );
});

test('rejects a signed URL whose attachment id does not match the artifact', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soduwork-media-id-'));
  const artifact = {
    kind: 'video', attachmentId: 'attachment-a',
    url: 'http://hub.test/api/v1/attachments/attachment-b?ticket=t',
    filename: 'clip.mp4', mimeType: 'video/mp4',
  };
  await assert.rejects(
    () => media.materialize(artifact, { hub: 'http://hub.test' }, dir,
      async () => ({ ok: true, status: 200, headers: { get: () => '1' },
        arrayBuffer: async () => Buffer.from('video') })),
    /附件标识不一致/,
  );
});
