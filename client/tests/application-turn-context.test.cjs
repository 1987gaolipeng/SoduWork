'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const application = require('../main/application-turn-context.cjs');
const item = { pluginId: 'app-1', name: 'Example library', version: '0.4.31',
  capabilities: { mcpServers: ['fixture-app-service'] } };

test('ordinary conversation adds no application context', () => {
  assert.equal(application.describe(null, [], []), null);
  assert.equal(application.guide(null), '');
});

test('current authorized application exposes service and target without credentials', () => {
  const value = application.describe({ pluginId: 'app-1', requiresMcp: true,
    pageUrl: 'http://localhost:8901/home.html?record=private-id&lang=en&token=page-secret#key',
    connection: { url: 'http://localhost:8901/mcp', token: 'connection-secret',
      context: { spaceId: 'team', recordId: 'document-1', recordName: 'Project guide',
        spaceName: 'Documentation', arbitrary: 'ignored' } } }, [item], ['fixture-app-service']);
  assert.equal(value.pageUrl, 'http://localhost:8901/home.html?lang=en');
  assert.equal(value.connection.serviceUrl, 'http://localhost:8901/mcp');
  assert.equal(value.connection.status, 'ready');
  assert.equal(value.version, '0.4.31');
  assert.deepEqual(value.target, { spaceId: 'team', recordId: 'document-1',
    recordName: 'Project guide', spaceName: 'Documentation' });
  const guide = application.guide(value);
  assert.doesNotMatch(guide, /page-secret|connection-secret|arbitrary|private-id/);
  assert.match(guide, /不自动截图/);
});

test('missing declaration or authorization fails before producing model guidance', () => {
  assert.throws(() => application.describe({ pluginId: 'app-1', requiresMcp: true },
    [{ ...item, capabilities: { mcpServers: [] } }], []), /v0.4.31.*未声明 MCP/);
  assert.throws(() => application.describe({ pluginId: 'app-1' }, [item], []), /所需 MCP 未授权/);
  assert.throws(() => application.describe({ pluginId: 'other' }, [item], []), /未完成授权/);
});

test('Hub connection and conversation-only applications retain their existing authorization', () => {
  const ready = application.describe({ pluginId: 'app-1' }, [item], ['fixture-app-service']);
  assert.equal(ready.connection.transport, 'hub');
  assert.equal(ready.connection.status, 'ready');
  const ordinary = application.describe({ pluginId: 'app-1' }, [{ ...item,
    capabilities: { mcpServers: [] } }], []);
  assert.equal(ordinary.connection.status, 'not_declared');
});

test('page URLs omit sensitive queries, fragments and embedded credentials', () => {
  assert.equal(application.pageUrl('https://example.test/view?t=topic&lang=en&ukey=secret#secret'),
    'https://example.test/view?lang=en');
  for (const url of ['file:///secret', 'https://name:password@example.test', 'invalid'])
    assert.equal(application.pageUrl(url), '');
});

test('unavailable application context permits conversation guidance without claiming a grant', () => {
  const value = application.describe({pluginId:'app-1',requiresMcp:true}, [item], [], {allowUnavailable:true});
  assert.equal(value.connection.status,'unavailable');
  assert.deepEqual(value.connection.servers,[]);
  assert.deepEqual(value.connection.declaredServers,['fixture-app-service']);
  assert.match(application.guide(value), /仅作文字沟通.*正常回应用户/);
  assert.match(application.guide(value), /不得搜索历史授权文件/);
  assert.throws(() => application.describe({pluginId:'app-1',requiresMcp:true},
    [{...item,capabilities:{mcpServers:[]}}], [], {allowUnavailable:true}), /未声明 MCP/);
});
