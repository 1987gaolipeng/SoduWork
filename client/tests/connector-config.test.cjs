'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parse,status}=require('../components/panels/connector-config.js');
test('quick configuration preserves credential headers and restrictive tools/timeouts',()=>{
 const [x]=parse(JSON.stringify({mcpServers:{service:{url:'https://example.com/mcp',headers:{Authorization:'Bearer secret'},enabled_tools:['read'],disabled_tools:['send'],startup_timeout_sec:30,tool_timeout_sec:100}}}));
 assert.deepEqual(x.enabledTools,['read']);assert.deepEqual(x.disabledTools,['send']);assert.equal(x.headers.Authorization,'Bearer secret');assert.equal(x.startupTimeoutSeconds,30);assert.equal(x.toolTimeoutSeconds,100);
});
test('multiple connections are returned for explicit selection, never silently discarded',()=>{
 const rows=parse(JSON.stringify({mcpServers:{a:{url:'https://a.example/mcp'},b:{url:'https://b.example/mcp'}}}));assert.equal(rows.length,2);assert.deepEqual(rows.map(x=>x.name),['a','b']);
});
test('unsupported permissions and conflicting aliases fail instead of widening access',()=>{
 for(const row of [{allowedTools:['read']},{enabledTools:['read'],enabled_tools:['write']},{enabledTools:['*']},{startup_timeout_sec:0},{enabledTools:['read'],disabled_tools:['read']},{env:{TOKEN:'secret'}}])
 assert.throws(()=>parse(JSON.stringify({url:'https://example.com/mcp',...row})));
});
test('tool listing is not represented as business authorization',()=>{
 assert.equal(status({ok:true,authenticationTested:false},true).state,'idle');assert.equal(status({ok:false,authenticationTested:false},true).state,'bad');assert.equal(status({ok:true,authenticationTested:true},true).state,'ok');
});

test('PEM clipboard input preserves line breaks without changing ordinary tokens',()=>{
 const {credentialPaste}=require('../components/panels/connector-config.js');
 const pem='-----BEGIN PRIVATE KEY-----\r\nabc+/123=\r\n-----END PRIVATE KEY-----\r\n';
 assert.equal(credentialPaste('GCP_PRIVATE_KEY',pem),'-----BEGIN PRIVATE KEY-----\\nabc+/123=\\n-----END PRIVATE KEY-----');
 assert.equal(credentialPaste('TLS_CA_PEM','-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----'),'-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----');
 assert.equal(credentialPaste('TOKEN',pem),null);assert.equal(credentialPaste('GCP_PRIVATE_KEY','ordinary-value'),null);
});
