'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), http = require('node:http');
const { execute, request } = require('../../skills/mcp-tools/connectors/special.cjs');
const { tencentSignature, klingToken, signS3, sha256 } = require('../../skills/mcp-tools/connectors/special-signing.cjs');

const field = (key, secret = false, required = true) => ({ key, label: key, secret, required });
const writes = { key: 'ALLOW_WRITES', label: '写入权限', default: 'false', pattern: '^(true|false)$' };
function definition(kind) {
  const common = { schemaVersion: 1, id: kind, runtimeKind: kind, headers: {} };
  if (kind === 's3') return { ...common, baseUrl: '{S3_ENDPOINT}', fields: [
    field('S3_ENDPOINT'), field('S3_REGION'), field('S3_ACCESS_KEY_ID'), field('S3_SECRET_ACCESS_KEY', true),
    field('S3_SESSION_TOKEN', true, false), writes,
  ] };
  if (kind === 'kling') return { ...common, baseUrl: 'https://api-singapore.klingai.com',
    fields: [field('KLING_ACCESS_KEY'), field('KLING_SECRET_KEY', true), writes] };
  return { ...common, baseUrl: 'https://api.meeting.qq.com', fields: [
    field('TENCENT_APP_ID'), field('TENCENT_SECRET_ID', true), field('TENCENT_SECRET_KEY', true),
    field('TENCENT_SDK_ID', false, false), writes,
  ] };
}
const s3 = { S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com', S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const tencent = { TENCENT_APP_ID: '1234567890', TENCENT_SECRET_ID: 'fixture-secret-id', TENCENT_SECRET_KEY: 'fixture-secret-key', TENCENT_SDK_ID: 'fixture-sdk-id' };
const kling = { KLING_ACCESS_KEY: 'fixture-access-key', KLING_SECRET_KEY: 'fixture-secret-key' };
const objectTool = () => ({ name: 'get_object', method: 'GET', path: '/{bucket}/{key}', readOnly: true,
  inputSchema: { type: 'object', properties: { bucket: { type: 'string' }, key: { type: 'string' } }, required: ['bucket', 'key'] } });
const listTool = () => ({ name: 'list_objects', method: 'GET', path: '/{bucket}', readOnly: true,
  inputSchema: { type: 'object', properties: { bucket: { type: 'string' }, prefix: { type: 'string' },
    max_keys: { type: 'integer', minimum: 1, maximum: 1000, default: 20 } }, required: ['bucket'] },
  query: { prefix: 'prefix', 'max-keys': 'max_keys' }, fixedQuery: { 'list-type': '2' } });
const meetingTool = () => ({ name: 'list_meetings', method: 'GET', path: '/v1/meetings', readOnly: true,
  inputSchema: { type: 'object', properties: { userid: { type: 'string' }, instanceid: { type: 'integer', default: 1 } }, required: ['userid'] },
  query: { userid: 'userid', instanceid: 'instanceid' } });
const klingTool = () => ({ name: 'get_video_task', method: 'GET', path: '/v1/videos/text2video/{id}', readOnly: true,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const data = result => JSON.parse(result.content[0].text);

test('腾讯会议官方 HMAC 合同：独立 Python 生成的固定向量（hex 后 Base64）', () => {
  const signature = tencentSignature({ secretId: 'fixture-secret-id', secretKey: 'fixture-secret-key', method: 'GET',
    uri: '/v1/meetings?userid=tester1&instanceid=1', timestamp: '1572168600', nonce: '1234567' });
  assert.equal(signature, 'M2U2YzQ3YjVlMTNhMzE1ZWEwNGZjOGM4NGYzZGZkOTIwZDE4YThlYWI1YTRkZmYwYTkxMDQzMDEyMTRkNTlkZQ==');
});
test('腾讯会议签入真实 URI/query，AppId/SdkId 与 SecretId 不混用', () => {
  const req = request(definition('tencent-meeting'), tencent, meetingTool(), { userid: 'tester1' },
    { now: 1572168600000, nonce: 1234567 });
  assert.equal(req.headers.AppId, tencent.TENCENT_APP_ID);
  assert.equal(req.headers.SdkId, tencent.TENCENT_SDK_ID);
  assert.equal(req.headers['X-TC-Key'], tencent.TENCENT_SECRET_ID);
  assert.equal(req.headers['X-TC-Registered'], '1');
  assert.equal(req.headers['X-TC-Signature'], 'M2U2YzQ3YjVlMTNhMzE1ZWEwNGZjOGM4NGYzZGZkOTIwZDE4YThlYWI1YTRkZmYwYTkxMDQzMDEyMTRkNTlkZQ==');
  const other = request(definition('tencent-meeting'), tencent, meetingTool(), { userid: '另一用户' }, { now: 1572168600000, nonce: 1234567 });
  assert.notEqual(other.headers['X-TC-Signature'], req.headers['X-TC-Signature']);
  assert.ok(!req.url.href.includes(tencent.TENCENT_SECRET_KEY));
  assert.ok(!Object.hasOwn(req.headers, 'X-TC-AppId'));
});
test('腾讯会议缺少 SecretId 必须失败，不能回退为 SDK ID；旧应用允许无 SdkId', () => {
  const cfg = { ...tencent }; delete cfg.TENCENT_SECRET_ID;
  assert.throws(() => request(definition('tencent-meeting'), cfg, meetingTool(), { userid: 'a' }));
  const old = request(definition('tencent-meeting'), { ...tencent, TENCENT_SDK_ID: '' }, meetingTool(), { userid: 'a' });
  assert.ok(!Object.hasOwn(old.headers, 'SdkId'));
});
test('可灵 JWT 按官方 HS256、iss、30 分钟 exp、提前 5 秒 nbf 验签', () => {
  const token = klingToken(kling.KLING_ACCESS_KEY, kling.KLING_SECRET_KEY, 1700000000000);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: kling.KLING_ACCESS_KEY, exp: 1700001800, nbf: 1699999995 });
  assert.equal(signature, crypto.createHmac('sha256', kling.KLING_SECRET_KEY).update(header + '.' + payload).digest('base64url'));
  assert.ok(!token.includes(kling.KLING_SECRET_KEY));
});
test('AWS 官方 S3 GET Object SigV4 固定向量逐字匹配', () => {
  // Public provider test credentials, not production secrets.
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  const headers = signS3({ url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), method: 'GET',
    headers: { Range: 'bytes=0-9' }, region: 'us-east-1', accessKey: s3.S3_ACCESS_KEY_ID, secretKey: s3.S3_SECRET_ACCESS_KEY,
    now: Date.parse('2013-05-24T00:00:00Z') });
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});
test('AWS 官方 List Objects SigV4 向量验证 query 排序及空 payload', () => {
  const url = new URL('https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2');
  const headers = signS3({ url, method: 'GET', region: 'us-east-1', accessKey: s3.S3_ACCESS_KEY_ID,
    secretKey: s3.S3_SECRET_ACCESS_KEY, now: Date.parse('2013-05-24T00:00:00Z') });
  assert.equal(url.search, '?max-keys=2&prefix=J');
  assert.ok(headers.authorization.endsWith('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'));
});
test('S3 路径保留中文、空格、重复斜杠与百分号，拒绝 dot segment 归一化', () => {
  const req = request(definition('s3'), s3, objectTool(), { bucket: 'my-bucket', key: "folder//中文 !'()*%?.txt" });
  assert.equal(req.url.pathname, '/my-bucket/folder//%E4%B8%AD%E6%96%87%20%21%27%28%29%2A%25%3F.txt');
  for (const key of ['../secret', 'folder/./file', 'folder/../file']) assert.throws(() => request(definition('s3'), s3, objectTool(), { bucket: 'my-bucket', key }), /相对路径/);
  const list = request(definition('s3'), s3, listTool(), { bucket: 'my-bucket', prefix: '中文 &+=?' });
  assert.ok(list.url.search.includes('%20%26%2B%3D%3F'));
  assert.ok(!list.url.search.includes('+'));
});
test('S3 临时 session token 被发送并纳入签名，不是 URL 查询参数', () => {
  const req = request(definition('s3'), { ...s3, S3_SESSION_TOKEN: 'fixture-session-token' }, listTool(), { bucket: 'my-bucket' });
  assert.equal(req.headers['x-amz-security-token'], 'fixture-session-token');
  assert.match(req.headers.authorization, /SignedHeaders=[^,]*x-amz-security-token/);
  assert.ok(!req.url.href.includes('fixture-session-token'));
});
test('S3 PUT 原样发送 UTF-8 文本且 payload hash 不包含 JSON 引号', () => {
  const tool = { ...objectTool(), name: 'put_object', method: 'PUT', readOnly: false, body: '$content',
    inputSchema: { ...objectTool().inputSchema, properties: { ...objectTool().inputSchema.properties, content: { type: 'string' } }, required: ['bucket', 'key', 'content'] } };
  const req = request(definition('s3'), { ...s3, ALLOW_WRITES: 'true' }, tool, { bucket: 'my-bucket', key: 'a.txt', content: '中文\n"raw"' });
  assert.equal(req.body, '中文\n"raw"');
  assert.equal(req.headers['x-amz-content-sha256'], sha256('中文\n"raw"'));
});
test('三类运行器均拒绝无授权写入，包括错误标记为 readOnly 的 POST', () => {
  for (const [kind, cfg, tool, args] of [
    ['tencent-meeting', tencent, meetingTool(), { userid: 'a' }],
    ['kling', kling, klingTool(), { id: 'task' }],
    ['s3', s3, objectTool(), { bucket: 'my-bucket', key: 'a' }],
  ]) {
    assert.throws(() => request(definition(kind), cfg, { ...tool, method: 'POST' }, args), /授权写入/);
    assert.throws(() => request(definition(kind), cfg, { ...tool, readOnly: false }, args), /授权写入/);
  }
});
test('参数与配置保持声明边界，不接受工具传入任意 URL/未知字段/越界分页', () => {
  assert.throws(() => request(definition('s3'), s3, listTool(), { bucket: 'my-bucket', url: 'https://attacker.invalid' }));
  assert.throws(() => request(definition('s3'), { ...s3, TOKEN: 'unknown' }, listTool(), { bucket: 'my-bucket' }));
  assert.throws(() => request(definition('s3'), s3, listTool(), { bucket: 'my-bucket', max_keys: 1001 }));
  assert.throws(() => request(definition('s3'), s3, objectTool(), { bucket: '../bad', key: 'a' }));
});
test('腾讯会议与可灵仅接收精确官方 HTTPS 主机，拒绝伪装、端口和重定向源', () => {
  for (const baseUrl of ['http://api.meeting.qq.com', 'https://api.meeting.qq.com.evil.invalid', 'https://api.meeting.qq.com@evil.invalid',
    'https://api.meeting.qq.com:8443', 'https://api.meeting.qq.com/path', 'https://api.meeting.qq.com\\@evil.invalid']) {
    assert.throws(() => request({ ...definition('tencent-meeting'), baseUrl }, tencent, meetingTool(), { userid: 'a' }));
  }
  assert.throws(() => request({ ...definition('kling'), baseUrl: 'https://api.klingai.com' }, kling, klingTool(), { id: 'a' }), /官方地址/);
});
test('用户明确配置的 MinIO endpoint 仅 HTTPS，HTTP 只允许严格本机地址', () => {
  for (const endpoint of ['http://169.254.169.254', 'http://192.0.2.1:9000', 'http://localhost.evil.invalid', 'https://a:b@host.invalid',
    'https://host.invalid/path', 'https://host.invalid?key=secret', 'https://host.invalid#fragment', 'file:///tmp/a', 'http://2130706433:9000']) {
    assert.throws(() => request(definition('s3'), { ...s3, S3_ENDPOINT: endpoint }, listTool(), { bucket: 'my-bucket' }));
  }
  for (const endpoint of ['http://127.0.0.1:9000', 'http://localhost:9000', 'http://[::1]:9000', 'https://minio.company.invalid:9000']) {
    assert.doesNotThrow(() => request(definition('s3'), { ...s3, S3_ENDPOINT: endpoint }, listTool(), { bucket: 'my-bucket' }));
  }
});
test('重定向被阻断且凭据只发送一次，不跟随 Location', async () => {
  let calls = 0;
  await assert.rejects(execute(definition('kling'), kling, klingTool(), { id: 'task' }, { fetchImpl: async (_url, opts) => {
    calls++; assert.equal(opts.redirect, 'manual');
    return new Response('', { status: 307, headers: { location: 'https://attacker.invalid' } });
  } }), /重定向/);
  assert.equal(calls, 1);
});
test('HTTP 及网络错误不泄漏原始响应/凭据，写入绝不自动重试', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(execute(definition('kling'), { ...kling, ALLOW_WRITES: 'true' }, { ...klingTool(), method: 'POST', readOnly: false }, { id: 'task' }, {
      fetchImpl: async () => { calls++; return new Response(kling.KLING_SECRET_KEY, { status }); },
    }), error => error.message.includes(String(status)) && !error.message.includes(kling.KLING_SECRET_KEY));
    assert.equal(calls, 1);
  }
  await assert.rejects(execute(definition('kling'), kling, klingTool(), { id: 'task' }, {
    fetchImpl: async () => { throw Error(kling.KLING_SECRET_KEY); },
  }), error => !error.message.includes(kling.KLING_SECRET_KEY));
});
test('取消与 deadline 覆盖忽略 AbortSignal 的 fetch，不触发后台重试', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(execute(definition('kling'), kling, klingTool(), { id: 'task' }, {
    signal: controller.signal, fetchImpl: () => { calls++; return new Promise(() => {}); },
  }), /已取消/);
  assert.equal(calls, 0);
  await assert.rejects(execute(definition('kling'), kling, klingTool(), { id: 'task' }, {
    timeoutMs: 20, fetchImpl: () => { calls++; return new Promise(() => {}); },
  }), /超时/);
  assert.equal(calls, 1);
});
test('deadline 也覆盖已返回 HTTP 头但永不结束的响应流', async () => {
  await assert.rejects(execute(definition('kling'), kling, klingTool(), { id: 'task' }, {
    timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
  }), /超时/);
});
test('响应体有 2 MB 硬上限，包括无 Content-Length 的流', async () => {
  for (const response of [new Response('', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    await assert.rejects(execute(definition('kling'), kling, klingTool(), { id: 'task' }, { fetchImpl: async () => response }), /2 MB/);
  }
});
test('腾讯会议 error_info / 可灵非零 code 不伪装成功，也不泄漏错误正文', async () => {
  await assert.rejects(execute(definition('tencent-meeting'), tencent, meetingTool(), { userid: 'a' }, {
    fetchImpl: async () => json({ error_info: { error_code: 2001, message: tencent.TENCENT_SECRET_KEY } }),
  }), /平台拒绝/);
  await assert.rejects(execute(definition('kling'), kling, klingTool(), { id: 'a' }, {
    fetchImpl: async () => json({ code: 1002, message: kling.KLING_SECRET_KEY }),
  }), /平台拒绝/);
});
test('成功响应若回显凭据或本次 JWT，返回内容仍脱敏', async () => {
  const result = await execute(definition('kling'), kling, klingTool(), { id: 'a' }, {
    fetchImpl: async (_url, options) => json({ code: 0, echo: options.headers.Authorization,
      secret: kling.KLING_SECRET_KEY, encoded: encodeURIComponent(kling.KLING_SECRET_KEY) }),
  });
  assert.equal(result.isError, false);
  assert.ok(!result.content[0].text.includes(kling.KLING_SECRET_KEY));
  assert.ok(!result.content[0].text.includes('eyJhbGci'));
  assert.match(result.content[0].text, /已隐藏凭据/);
});
test('S3 列表安全返回 XML 并提取编码后的分页游标', async () => {
  const result = await execute(definition('s3'), s3, listTool(), { bucket: 'my-bucket' }, {
    fetchImpl: async () => new Response('<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><NextContinuationToken>a&amp;b&#x2B;=</NextContinuationToken></ListBucketResult>'),
  });
  assert.equal(data(result).format, 'xml');
  assert.equal(data(result).pagination.continuationToken, 'a&b+=');
});
test('S3 XML DTD/实体声明、伪 HTML 和业务错误均被拒绝', async () => {
  for (const xml of [
    '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private">]><ListBucketResult>&secret;</ListBucketResult>',
    '<!ENTITY x "xx"><ListBucketResult/>', '<html>login</html>',
    '<Error><Code>AccessDenied</Code><Message>private-secret</Message></Error>',
  ]) await assert.rejects(execute(definition('s3'), s3, listTool(), { bucket: 'my-bucket' }, {
    fetchImpl: async () => new Response(xml),
  }), error => !error.message.includes('private-secret'));
});
test('S3 文本和二进制对象只返回内容，不声称已经保存文件', async () => {
  const text = await execute(definition('s3'), s3, objectTool(), { bucket: 'my-bucket', key: 'a' }, { fetchImpl: async () => new Response('中文') });
  assert.deepEqual(data(text), { contentType: 'text/plain;charset=UTF-8', encoding: 'utf8', content: '中文' });
  const bytes = await execute(definition('s3'), s3, objectTool(), { bucket: 'my-bucket', key: 'a' }, { fetchImpl: async () => new Response(Buffer.from([0xff, 0, 1])) });
  assert.equal(data(bytes).encoding, 'base64'); assert.equal(data(bytes).content, '/wAB');
});
test('真实本机 HTTP 夹具验证 MinIO 请求签名、UTF-8 路径与单次 PUT 传输', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', part => parts.push(part));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts).toString('utf8') });
      if (req.method === 'PUT') { res.setHeader('ETag', '"fixture-etag"'); res.end(); }
      else { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('本机夹具'); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cfg = { ...s3, S3_ENDPOINT: 'http://127.0.0.1:' + server.address().port };
  try {
    const result = await execute(definition('s3'), cfg, objectTool(), { bucket: 'my-bucket', key: '文件/a b.txt' });
    assert.equal(data(result).content, '本机夹具');
    const tool = { ...objectTool(), name: 'put_object', method: 'PUT', readOnly: false, body: '$content',
      inputSchema: { ...objectTool().inputSchema, properties: { ...objectTool().inputSchema.properties, content: { type: 'string' } }, required: ['bucket', 'key', 'content'] } };
    const put = await execute(definition('s3'), { ...cfg, ALLOW_WRITES: 'true' }, tool, { bucket: 'my-bucket', key: '文件/a b.txt', content: '原样文本' });
    assert.equal(data(put).etag, '"fixture-etag"');
    assert.equal(received.length, 2); assert.equal(received[1].body, '原样文本');
    assert.equal(received[0].url, '/my-bucket/%E6%96%87%E4%BB%B6/a%20b.txt');
    for (const item of received) {
      assert.equal(item.headers['x-amz-content-sha256'], sha256(item.body));
      assert.match(item.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request,/);
      assert.ok(!JSON.stringify(item).includes(s3.S3_SECRET_ACCESS_KEY));
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('响应凭据包含引号、反斜杠、纯数字时脱敏后仍为有效 JSON', async () => {
  for (const secret of ['secret-"quoted"\\tail', '987654321']) {
    const cfg = { ...kling, KLING_SECRET_KEY: secret };
    const result = await execute(definition('kling'), cfg, klingTool(), { id: 'a' }, {
      fetchImpl: async () => json({ code: 0, [secret]: secret, value: secret === '987654321' ? 987654321 : secret }),
    });
    const parsed = data(result);
    assert.equal(parsed['[已隐藏凭据]'], '[已隐藏凭据]');
    assert.equal(parsed.value, '[已隐藏凭据]');
    assert.ok(!result.content[0].text.includes(secret));
  }
});
test('取消已在途的请求会终止本次调用，后续调用可以正常读取', async () => {
  const controller = new AbortController();
  let started, fetchSignal;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = execute(definition('kling'), kling, klingTool(), { id: 'task' }, {
    signal: controller.signal, fetchImpl: (_url, options) => { fetchSignal = options.signal; started(); return new Promise(() => {}); },
  });
  await ready; controller.abort();
  await assert.rejects(pending, /已取消/);
  assert.equal(fetchSignal.aborted, true);
  const next = await execute(definition('kling'), kling, klingTool(), { id: 'task' }, { fetchImpl: async () => json({ code: 0, task: 'next' }) });
  assert.equal(data(next).task, 'next');
});
test('S3 接受空列表自闭合 XML，但不接受自定义实体引用', async () => {
  const result = await execute(definition('s3'), s3, listTool(), { bucket: 'my-bucket' }, {
    fetchImpl: async () => new Response('<ListBucketResult/>'),
  });
  assert.equal(data(result).xml, '<ListBucketResult/>');
  await assert.rejects(execute(definition('s3'), s3, listTool(), { bucket: 'my-bucket' }, {
    fetchImpl: async () => new Response('<ListBucketResult>&private;</ListBucketResult>'),
  }), /实体/);
});
test('超大响应立即中止底层传输，错误收尾不等待永不完成的 cancel', async () => {
  let signal;
  await assert.rejects(execute(definition('kling'), kling, klingTool(), { id: 'task' }, {
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { ok: true, status: 200, headers: new Headers({ 'content-length': '2097153' }), body: { cancel: () => new Promise(() => {}) } };
    },
  }), /2 MB/);
  assert.equal(signal.aborted, true);
});

test('S3 两种分页合同不混淆：对象列表不复用回显游标，桶列表采用返回游标', async () => {
  for (const [xml, expected] of [
    ['<ListBucketResult><ContinuationToken>old</ContinuationToken><NextContinuationToken>next</NextContinuationToken></ListBucketResult>', 'next'],
    ['<ListBucketResult><ContinuationToken>last</ContinuationToken><IsTruncated>false</IsTruncated></ListBucketResult>', undefined],
    ['<ListAllMyBucketsResult><ContinuationToken>next-buckets</ContinuationToken></ListAllMyBucketsResult>', 'next-buckets'],
  ]) {
    const result = await execute(definition('s3'), s3, listTool(), { bucket: 'my-bucket' }, { fetchImpl: async () => new Response(xml) });
    assert.equal(data(result).pagination?.continuationToken, expected);
  }
});
test('正式三类定义通过通用 runtime 派发，配置、参数和写权限保持真实契约', async () => {
  const { provider } = require('../../skills/mcp-tools/connectors/validation.cjs');
  const { session } = require('../../skills/mcp-tools/connectors/runtime.cjs');
  const cases = [
    ['tencent-meeting', tencent, 'list_user_meetings', { userid: '9527' }],
    ['kling', { ...kling, KLING_ACCESS_KEY: 'fixtureaccesskey' }, 'get_video_task', { task_id: 'fixture-task-001' }],
    ['s3', s3, 'list_objects', { bucket: 'my-bucket' }],
  ];
  for (const [id, env, toolName, args] of cases) {
    let calls = 0;
    await session({ command: 'soduwork-connector', args: [id], env }, async rpc => {
      const listed = await rpc('tools/list');
      assert.ok(listed.tools.some(tool => tool.name === toolName));
      assert.ok(listed.tools.every(tool => tool.annotations.readOnlyHint));
      const write = provider(id).tools.find(tool => tool.readOnly !== true);
      assert.ok(!listed.tools.some(tool => tool.name === write.name));
      const result = await rpc('tools/call', { name: toolName, arguments: args });
      assert.equal(result.isError, false);
    }, { fetchImpl: async (url, options) => {
      calls++; assert.equal(options.redirect, 'manual');
      if (id === 'tencent-meeting') {
        assert.equal(url.searchParams.get('instanceid'), '1');
        assert.equal(url.searchParams.get('pos'), '0');
        assert.equal(options.headers['X-TC-Key'], tencent.TENCENT_SECRET_ID);
      }
      if (id === 'kling') assert.equal(url.hostname, 'api-singapore.klingai.com');
      return id === 's3' ? new Response('<ListBucketResult/>') : json({ code: 0 });
    } });
    assert.equal(calls, 1);
  }
  const def = provider('tencent-meeting'), create = def.tools.find(tool => tool.name === 'create_meeting');
  const req = request(def, { ...tencent, ALLOW_WRITES: 'true' }, create, {
    userid: '9527', subject: 'Test', start_time: '1700000000', end_time: '1700003600',
  });
  assert.deepEqual(JSON.parse(req.body), { userid: '9527', subject: 'Test', instanceid: 1, type: 0,
    meeting_type: 0, start_time: '1700000000', end_time: '1700003600' });
});
