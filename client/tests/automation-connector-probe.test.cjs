'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { probe } = require('../main/automation-connector-probe.cjs');
const identity = { hub: 'http://hub.example', clientId: 'device', session: 'test-only-device-session' };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
function fixture({ catalog, status = 200, discovery, grant, firstError } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    if (firstError) throw Error(firstError);
    if (url.endsWith('/mcp-servers')) return response(catalog || {
      company: [], enabledCompany: [], personal: [{ id: 'docs-id', name: 'docs', enabled: true, approved: true }] }, status);
    if (url.endsWith('/conversation-grant')) return response({ ok: true,
      mcpGrant: grant || { ticket: 'test-only-ticket', servers: body.personalMcpServers } });
    if (url.endsWith('/probe')) {
      return response(discovery || { ok: true, tools: ['list'], authenticationTested: true,
        connectionState: 'verified', checkedAt: 'fixture-time' });
    }
    throw Error('unexpected network route');
  }};
}
test('readiness validates scoped grant and saved connector identity without arbitrary business calls', async () => {
  const f = fixture(); const result = await probe(identity, ['docs'], f);
  assert.equal(result[0].state, 'ready');
  assert.deepEqual(f.calls.map(x => x.method), ['GET', 'POST', 'POST']);
  assert.deepEqual(f.calls[1].body.pluginIds, []);
  assert.deepEqual(f.calls[1].body.personalMcpServers, ['docs']);
  assert.match(f.calls[2].url, /mcp-servers\/probe$/);
  assert.equal(f.calls[2].body.id, 'docs-id');
  assert.equal(result[0].connectionState, 'verified');
  assert.equal(result[0].authenticationTested, true);
});
for (const personal of [[], [{ name: 'docs', enabled: false, approved: true }], [{ name: 'docs', enabled: true, approved: false }]]) {
  test('missing/disabled/unapproved connection is blocked before issuing a grant: ' + JSON.stringify(personal), async () => {
    const f = fixture({ catalog: { personal, company: [], enabledCompany: [] } });
    assert.equal((await probe(identity, ['docs'], f))[0].state, 'blocked'); assert.equal(f.calls.length, 1);
  });
}
test('company selection is respected and an unselected company connection is not enabled by preflight', async () => {
  const f = fixture({ catalog: { company: [{ id: 'company-docs', name: 'docs', enabled: true }], enabledCompany: [], personal: [] } });
  assert.equal((await probe(identity, ['docs'], f))[0].state, 'blocked');
  const selected = fixture({ catalog: { company: [{ id: 'company-docs', name: 'docs', enabled: true }], enabledCompany: ['docs'], personal: [] } });
  assert.equal((await probe(identity, ['docs'], selected))[0].state, 'ready');
  assert.match(selected.calls[2].url, /company\/company-docs\/probe$/);
});
test('grant missing a requested server is blocked; no secrets appear in the result', async () => {
  const f = fixture({ grant: { ticket: 'test-only-ticket', servers: [] } });
  const result = await probe(identity, ['docs'], f); assert.equal(result[0].state, 'blocked');
  assert.ok(!JSON.stringify(result).includes('ticket')); assert.equal(f.calls.length, 2);
});
test('auth rejection is blocked while offline transport is waiting', async () => {
  const denied = fixture({ status: 403 }); assert.equal((await probe(identity, ['docs'], denied))[0].state, 'blocked');
  const offline = fixture({ firstError: 'private credentials in provider error' });
  const result = await probe(identity, ['docs'], offline); assert.equal(result[0].state, 'waiting');
  assert.ok(!JSON.stringify(result).includes('private'));
});
for (const discovery of [{ error: { message: 'private provider error' } }, { result: { isError: true, content: [] } },
  { result: { content: [{ type: 'text', text: '{}' }] } }]) {
  test('malformed or failed discovery never reports ready: ' + JSON.stringify(discovery), async () => {
    const result = await probe(identity, ['docs'], fixture({ discovery }));
    assert.equal(result[0].state, 'waiting'); assert.ok(!JSON.stringify(result).includes('private'));
  });
}
test('built-in virtual tools require no external connection or grant', async () => {
  const f = fixture(); assert.deepEqual(await probe(identity, ['soduwork-media'], f), []); assert.equal(f.calls.length, 0);
});

test('an empty tool list is unverified rather than a ready business capability', async () => {
  const f = fixture({ discovery: { result: { content: [{ type: 'text', text: '{"server":"docs","tools":[]}' }] } } });
  assert.equal((await probe(identity, ['docs'], f))[0].state, 'waiting');
});

test('automation distinguishes configured-only, invalid authorization and offline runner', async () => {
  for (const [health, expected] of [[{ok:true,connectionState:'configured',tools:['list'],authenticationTested:false},'ready'],
    [{ok:false,connectionState:'needs_auth',tools:['list']},'blocked'],
    [{ok:false,connectionState:'offline',tools:[]},'waiting']]) {
    const f=fixture({discovery:health}); const [result]=await probe(identity,['docs'],f);
    assert.equal(result.state,expected); assert.equal(result.connectionState,health.connectionState);
    assert.equal(result.authenticationTested,false);
    assert.doesNotMatch(result.label,/已验证连接器工具清单/);
  }
});
