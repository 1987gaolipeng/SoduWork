'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { probe } = require('../../skills/mcp-tools/connectors/health.cjs');
const spec = (id, env) => ({ command: 'soduwork-connector', args: [id], env });
test('身份探测请求固定身份接口，只返回状态，不泄漏响应或令牌', async () => {
  let request;
  const out = await probe(spec('figma', { FIGMA_PAT: 'fixture-pat' }), { fetchImpl: async (url, init) => {
    request = { url: String(url), init }; return new Response(JSON.stringify({ id: 'private-identity', email: 'private@example.invalid' }));
  }});
  assert.equal(request.url, 'https://api.figma.com/v1/me'); assert.equal(request.init.method, 'GET');
  assert.equal(out.connectionState, 'verified'); assert.equal(out.authenticationTested, true);
  assert.doesNotMatch(JSON.stringify(out), /fixture-pat|private-identity|private@example/);
});
test('授权失效和网络失败分开，HTTP200中的失效凭据也不能通过', async () => {
  for (const status of [401, 403]) {
    const out = await probe(spec('figma', { FIGMA_PAT: 'fixture-pat' }), { fetchImpl: async () => new Response('secret detail', { status }) });
    assert.equal(out.ok, false); assert.equal(out.connectionState, 'needs_auth');
    assert.doesNotMatch(JSON.stringify(out), /secret detail/);
  }
  const failed = await probe(spec('figma', { FIGMA_PAT: 'fixture-pat' }), { fetchImpl: async () => { throw Error('internal-network-secret'); } });
  assert.equal(failed.connectionState, 'error');
  const slack = await probe(spec('slack', { BOT_TOKEN: ['xoxb', 'fixture', 'health', 'token'].join('-') }), { fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' })) });
  assert.equal(slack.connectionState, 'needs_auth');
});
test('未提供身份探测的平台只标记配置就绪，不调用任意工具', async () => {
  let calls = 0;
  const out = await probe(spec('google-sheets', { GOOGLE_ACCESS_TOKEN: 'fixture-token' }), { fetchImpl: async () => { calls++; throw Error('must not fetch'); } });
  assert.equal(calls, 0); assert.equal(out.connectionState, 'configured'); assert.equal(out.authenticationTested, false);
});
test('Google/Graph 身份探测限制返回字段，不读文件/邮件', async () => {
  for (const [id, env, expected] of [['google-drive',{ GOOGLE_ACCESS_TOKEN:'fixture-token' },'/drive/v3/about'], ['outlook',{MSFT_ACCESS_TOKEN:'fixture-token'},'/v1.0/me']]) {
    let target;
    const out = await probe(spec(id,env), { fetchImpl: async url => { target = new URL(url); return new Response(JSON.stringify(id === 'google-drive' ? {user:{permissionId:'fixture-id'}} : {id:'fixture-id'})); } });
    assert.equal(target.pathname,expected); assert.equal(out.connectionState,'verified');
    assert.equal([...target.searchParams.keys()].length,1);
  }
});

test('空身份响应不能伪装授权成功', async () => {
  for (const payload of ['{}', 'null', '[]', '"success"']) {
    const out = await probe(spec('figma', { FIGMA_PAT: 'fixture-pat' }), { fetchImpl: async () => new Response(payload) });
    assert.equal(out.ok, false); assert.equal(out.authenticationTested, false);
  }
});
