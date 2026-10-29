'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const runtime = require('../../skills/mcp-tools/connectors/runtime.cjs');
const { input, settings, provider } = require('../../skills/mcp-tools/connectors/validation.cjs');
const { encode } = require('../../skills/mcp-tools/connectors/encoding.cjs');
const definition = () => ({ id: 'fixture', fields: [{ key: 'TOKEN', label: '令牌', secret: true, required: true },
  { key: 'ALLOW_WRITES', default: 'false', pattern: '^(true|false)$' }],
  baseUrl: 'https://api.example.com', auth: { type: 'bearer', tokenKey: 'TOKEN' } });
const tool = () => ({ name: 'get', path: '/items', method: 'GET', readOnly: true,
  inputSchema: { type: 'object', properties: {} } });
const values = { TOKEN: 'fixture-token' };
const response = value => new Response(JSON.stringify(value));
const data = result => JSON.parse(result.content[0].text);

test('Teams channel IDs from Graph are encoded as one path segment and writes remain opt-in', () => {
  const def = provider('microsoft-teams');
  const config = { MSFT_ACCESS_TOKEN: 'fixture-token' };
  const teamId = '893075dd-2487-4122-925f-022c42e20265';
  const ids = ['19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2',
    '19:d468258bc90f4a358361b5d73b89d39b@thread.skype', '19:AbC_123-xyz@thread.tacv2',
    '01234567-89ab-4def-8123-456789abcdef', '1234567890123'];
  for (const name of ['list_channel_messages', 'send_channel_message']) {
    const t = def.tools.find(item => item.name === name);
    for (const channelId of ids) {
      const args = { team_id: teamId, channel_id: channelId,
        ...(t.readOnly ? {} : { content: '<p>Fixture</p>' }) };
      if (!t.readOnly) assert.throws(() => runtime.request(def, config, t, args), /授权写入/);
      const req = runtime.request(def, { ...config, ALLOW_WRITES: 'true' }, t, args);
      assert.equal(req.url.origin, 'https://graph.microsoft.com');
      assert.equal(req.url.pathname, `/v1.0/teams/${teamId}/channels/${encodeURIComponent(channelId)}/messages`);
      assert.equal(req.method, t.readOnly ? 'GET' : 'POST');
      if (!t.readOnly) assert.deepEqual(JSON.parse(req.body), { body: { contentType: 'html', content: '<p>Fixture</p>' } });
    }
    for (const channelId of ['', '../messages', '19:abc@thread.tacv2/../other',
      '19:abc@thread.tacv2?token=x', '19:abc@evil.example', '19:abc%2Fdef@thread.skype',
      '19:abc\n@thread.skype', '19:abc@thread.tacv2\n', '1234567890123\r\n',
      '19:' + 'a'.repeat(256) + '@thread.tacv2']) {
      assert.throws(() => runtime.request(def, { ...config, ALLOW_WRITES: 'true' }, t,
        { team_id: teamId, channel_id: channelId, ...(t.readOnly ? {} : { content: 'Fixture' }) }));
    }
  }
});

test('任意 JSON 字段支持嵌套数组/对象/null，严格兄弟字段仍拒绝未知项', () => {
  const schema = { type: 'object', properties: { fields: { type: 'object', additionalProperties: true } }, required: ['fields'] };
  const value = { fields: { null: null, rows: [{ title: 'x', number: 4, nested: [null, true, { a: false }] }] } };
  assert.equal(input(value, schema), value);
  assert.throws(() => input({ ...value, hidden: true }, schema), /不支持参数/);
  assert.throws(() => input({ fields: { rows: [{ constructor: 'unsafe' }] } }, schema), /参数键/);
});
test('所有层级拒绝原型键与非 JSON 对象，不接受无限数字、函数和未定义', () => {
  const schema = { type: 'object', additionalProperties: true };
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => input(JSON.parse('{"x":[{"' + key + '":"unsafe"}]}'), schema), /参数键/);
  }
  for (const value of [new Date(), new Map(), Buffer.from('x'), { x: NaN }, { x: Infinity }, { x: undefined }, { x: () => {} }]) {
    assert.throws(() => input(value, schema));
  }
  assert.equal({}.unsafe, undefined);
});
test('动态字段仍遵守总节点/文本/递归深度边界与 schema 的零上限', () => {
  const schema = { type: 'object', additionalProperties: true };
  const value = {}; let current = value;
  for (let i = 0; i < 14; i++) current = current.child = {};
  assert.throws(() => input(value, schema), /嵌套过深/);
  const huge = { values: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => 'x')) };
  assert.throws(() => input(huge, schema), /结构过大/);
  assert.throws(() => input({ values: Array.from({ length: 100 }, () => '中'.repeat(10000)) }, schema), /2 MB/);
  assert.throws(() => input(['x'], { type: 'array', maxItems: 0 }), /数组/);
  assert.throws(() => input({ x: 1 }, { type: 'object', additionalProperties: true, maxProperties: 0 }), /字段过多/);
  assert.throws(() => input('x', { type: 'string', maxLength: 0 }), /过长/);
});
test('真实 Airtable 字段传递嵌套 JSON，正文引用不字符串化业务对象', () => {
  const def = provider('airtable'), create = def.tools.find(item => item.name === 'create_record');
  const fields = { Tags: ['a', 'b'], Linked: [{ id: 'rec1234567890', nullable: null }] };
  const req = runtime.request(def, { AIRTABLE_PAT: 'fixture-token', ALLOW_WRITES: 'true' }, create,
    { base_id: 'app1234567890', table_id_or_name: '数据表', fields });
  assert.deepEqual(JSON.parse(req.body), { records: [{ fields }] });
});
test('配置只能是声明字段的普通对象，禁止原型继承值和对象转字符串', () => {
  for (const value of [[], new Date(), Object.create({ TOKEN: 'inherited' }), { TOKEN: {} },
    JSON.parse('{"TOKEN":"x","__proto__":"bad"}')]) assert.throws(() => settings(definition(), value));
  assert.throws(() => runtime.request(definition(), values, tool(), []), /参数应为对象/);
});
test('误标只读的 PUT/PATCH/DELETE 仍要求明确写入许可；正常只读 POST 可用', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.throws(() => runtime.request(definition(), values, { ...tool(), method }, {}), /授权写入/);
  }
  const req = runtime.request(definition(), values, { ...tool(), method: 'POST', path: '/search', body: { query: 'fixed search' } }, {});
  assert.equal(req.method, 'POST');
});
test('固定 GraphQL 查询可读，参数替换查询或误标 mutation 被拒绝', () => {
  for (const query of ['$query', 'mutation { deleteAll }', '# comment\nmutation Remove { deleteAll }']) {
    assert.throws(() => runtime.request(definition(), values, { ...tool(), method: 'POST', path: '/graphql', body: { query } }, {}), /GraphQL/);
  }
  assert.equal(runtime.request(definition(), values, { ...tool(), method: 'POST', path: '/graphql',
    body: { query: 'query Q { viewer { id } }' } }, {}).method, 'POST');
});
test('正文不读取继承属性，缺失的数组引用不可偷偷写成 null', () => {
  const t = { ...tool(), method: 'POST', body: { optional: '$constructor', fixed: false } };
  assert.deepEqual(JSON.parse(runtime.request(definition(), values, t, {}).body), { fixed: false });
  assert.throws(() => runtime.request(definition(), values, { ...t, body: ['$missing'] }, {}), /缺少必要参数/);
  assert.throws(() => runtime.request(definition(), values, { ...t, body: '$missing' }, {}), /缺少必要参数/);
});
test('密钥仅能进入协议声明的鉴权位置，模型参数不能覆盖连接配置或鉴权 query', () => {
  assert.throws(() => runtime.request(definition(), values, { ...tool(), path: '/{TOKEN}' }, {}), /密钥不得/);
  assert.throws(() => runtime.request(definition(), values, { ...tool(), inputSchema: { type: 'object', properties: { TOKEN: { type: 'string' } } } }, { TOKEN: 'other' }), /覆盖连接配置/);
  const def = { ...definition(), auth: { type: 'query', query: { key: 'TOKEN' } } };
  assert.throws(() => runtime.request(def, values, { ...tool(), fixedQuery: { key: 'other' } }, {}), /覆盖鉴权/);
  assert.throws(() => runtime.request(def, values, { ...tool(), query: { key: 'cursor' } }, {}), /覆盖鉴权/);
  const telegram = provider('telegram');
  const req = runtime.request(telegram, { BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz12345678' }, telegram.tools[0], {});
  assert.equal(req.url.hostname, 'api.telegram.org');
});
test('拒绝未声明鉴权字段、危险请求头与标准化后改变的地址', () => {
  assert.throws(() => runtime.request({ ...definition(), auth: { type: 'bearer', tokenKey: 'OTHER' } }, values, tool(), {}), /鉴权字段/);
  for (const headers of [{ Host: 'other.invalid' }, { 'Content-Length': '100' }, { 'X-Foo': 'x\r\nBad: header' }]) {
    assert.throws(() => runtime.request({ ...definition(), headers }, values, tool(), {}), /请求头/);
  }
  for (const baseUrl of ['https://api.example.com\\@evil.invalid', 'https://user:secret@api.example.com', 'http://api.example.com']) {
    assert.throws(() => runtime.request({ ...definition(), baseUrl }, values, tool(), {}));
  }
  assert.throws(() => runtime.request(definition(), values, { ...tool(), path: '/%2e%2e/evil' }, {}), /发生变化/);
});
test('成功响应脱敏不破坏 JSON：引号、反斜杠、数字、短令牌和 URI 编码均处理', async () => {
  for (const token of ['with-"quotes"\\slash', '987654', 'xy']) {
    const result = await runtime.execute(definition(), { TOKEN: token }, tool(), {}, {
      fetchImpl: async () => response({ [token]: token, uri: encodeURIComponent(token), num: token === '987654' ? 987654 : 1 }),
    });
    const parsed = data(result);
    assert.equal(parsed['[已隐藏凭据]'], '[已隐藏凭据]');
    assert.equal(parsed.uri, '[已隐藏凭据]');
    if (token === '987654') assert.equal(parsed.num, '[已隐藏凭据]');
  }
});
test('Basic 认证完整头和裸编码回显都脱敏，不回传组合凭据', async () => {
  const def = { ...definition(), fields: [{ key: 'USER', required: true }, { key: 'PASSWORD', required: true, secret: true }],
    auth: { type: 'basic', usernameKey: 'USER', passwordKey: 'PASSWORD' } };
  const result = await runtime.execute(def, { USER: 'user@example.com', PASSWORD: 'fixture-password' }, tool(), {}, {
    fetchImpl: async (_url, opts) => response({ complete: opts.headers.Authorization, encoded: opts.headers.Authorization.slice(6) }),
  });
  assert.deepEqual(data(result), { complete: '[已隐藏凭据]', encoded: '[已隐藏凭据]' });
});
test('网络预算覆盖忽略取消的建连、响应体读取及永不完成的清理', async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
  ]) await assert.rejects(runtime.execute(definition(), values, tool(), {}, { timeoutMs: 10, fetchImpl }), /超时/);
  await assert.rejects(runtime.execute(definition(), values, tool(), {}, { timeoutMs: 10, fetchImpl: async () => ({
    ok: false, status: 500, body: { cancel: () => new Promise(() => {}) },
  }) }), /HTTP 500/);
});
test('取消在途请求及时返回且不重试，预取消不发网络请求', async () => {
  const controller = new AbortController(); let calls = 0, start;
  const ready = new Promise(resolve => { start = resolve; });
  const pending = runtime.execute(definition(), values, tool(), {}, {
    signal: controller.signal, fetchImpl: () => { calls++; start(); return new Promise(() => {}); },
  });
  await ready; controller.abort();
  await assert.rejects(pending, /已取消/);
  await assert.rejects(runtime.execute(definition(), values, tool(), {}, {
    signal: controller.signal, fetchImpl: () => { calls++; return response({}); },
  }), /已取消/);
  assert.equal(calls, 1);
});
test('GraphQL HTTP 200 的业务失败不得返回成功，不泄漏原始错误内容', async () => {
  for (const reply of [{ data: { productCreate: { userErrors: [{ message: 'fixture-token' }] } } },
    { data: { issueCreate: { success: false } } }]) {
    await assert.rejects(runtime.execute(definition(), values, tool(), {}, { fetchImpl: async () => response(reply) }),
      error => /平台拒绝/.test(error.message) && !error.message.includes('fixture-token'));
  }
  const result = await runtime.execute(definition(), values, tool(), {}, { fetchImpl: async () => response(null) });
  assert.equal(data(result), null);
});
test('Gmail MIME 保留中文主题/正文，长行折行且拒绝收件人注入', () => {
  const payload = { to: 'first+tag@example.com', from: 'sender@example.com', subject: '中文主题'.repeat(20), body: '中文正文'.repeat(100) };
  const encoded = encode('gmail', payload);
  const wire = Buffer.from(JSON.parse(encoded.body).raw, 'base64url').toString('utf8');
  const [headers, body] = wire.split('\r\n\r\n');
  const subjects = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(match => Buffer.from(match[1], 'base64').toString('utf8')).join('');
  assert.equal(subjects, payload.subject);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), payload.body);
  assert.ok(body.split('\r\n').every(line => line.length <= 76));
  for (const to of ['first@example.com\r\nBcc: other@example.com', 'first@example.com,other@example.com', 'A <first@example.com>']) {
    assert.throws(() => encode('gmail', { ...payload, to }), /邮件地址/);
  }
});
test('文本/form/multipart 编码拒绝类型伪装，原样保留中文正文', () => {
  assert.equal(encode('form', { name: '中文', count: 3 }).body, 'name=%E4%B8%AD%E6%96%87&count=3');
  assert.throws(() => encode('form', { object: {} }), /表单字段/);
  assert.throws(() => encode('text', {}), /文本/);
  assert.throws(() => encode('drive-multipart', { name: 'a', mimeType: 'text/plain\r\nBad: header', content: 'x' }), /MIME/);
  const encoded = encode('drive-multipart', { name: '文件.txt', mimeType: 'text/plain', content: '正文' });
  assert.match(encoded.body, /正文/);
  assert.match(encoded.contentType, /^multipart\/related; boundary=soduwork_/);
});


test('Jira 创建请求完整保留描述并转换成有效 ADF，缺省描述仍省略', () => {
 const def = provider('jira'), tool = def.tools.find(t => t.name === 'create_issue');
 const env = { TENANT: 'fixture', JIRA_EMAIL: 'user@example.com', JIRA_API_TOKEN: 'fixture', ALLOW_WRITES: 'true' };
 const args = { project_key: 'DEMO', summary: '请求标题', description: '第一行中文\r\n\r\n引号 " \\ 与 <标签>\n尾行' };
 const body = JSON.parse(runtime.request(def, env, tool, args).body);
 assert.equal(body.fields.summary, args.summary); assert.equal(body.fields.description.type, 'doc');
 assert.equal(body.fields.description.version, 1);
 assert.deepEqual(body.fields.description.content.map(p => { assert.equal(p.type, 'paragraph');
  for (const text of p.content) { assert.equal(text.type, 'text'); assert.ok(text.text.length); } return p.content.map(t => t.text).join(''); }),
  ['第一行中文', '', '引号 " \\ 与 <标签>', '尾行']);
 const omitted = JSON.parse(runtime.request(def, env, tool, { project_key: 'DEMO', summary: '无描述' }).body);
 assert.equal(Object.hasOwn(omitted.fields, 'description'), false);
 const empty = JSON.parse(runtime.request(def, env, tool, { ...args, description: '' }).body);
 assert.deepEqual(empty.fields.description.content, [{ type: 'paragraph', content: [] }]);
 assert.throws(() => runtime.request(def, { ...env, ALLOW_WRITES: 'false' }, tool, args), /授权写入/);
});

test('Linear 创建描述使用 GraphQL 数据变量传递，不能改变固定 mutation', () => {
 const def = provider('linear'), tool = def.tools.find(t => t.name === 'create_issue');
 const env = { LINEAR_API_KEY: 'fixture', ALLOW_WRITES: 'true' };
 const args = { team_id: 'fixture-team', title: '请求标题', description: '中文 Markdown\n" } mutation DeleteEverything { example } \\' };
 const body = JSON.parse(runtime.request(def, env, tool, args).body);
 assert.equal(body.variables.description, args.description); assert.equal(body.variables.title, args.title);
 assert.match(body.query, /\$description: String/); assert.match(body.query, /description: \$description/);
 assert.equal(body.query, tool.body.query); assert.doesNotMatch(body.query, /DeleteEverything/);
 const omitted = JSON.parse(runtime.request(def, env, tool, { team_id: 'fixture-team', title: '无描述' }).body);
 assert.equal(Object.hasOwn(omitted.variables, 'description'), false);
 assert.throws(() => runtime.request(def, { ...env, ALLOW_WRITES: 'false' }, tool, args), /授权写入/);
});
