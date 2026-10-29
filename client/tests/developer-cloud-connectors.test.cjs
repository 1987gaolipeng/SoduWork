'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { provider } = require('../../skills/mcp-tools/connectors/validation.cjs');
const runtime = require('../../skills/mcp-tools/connectors/runtime.cjs');
const cloud = require('../../skills/mcp-tools/connectors/cloud-connectors.cjs');
const sign = require('../../skills/mcp-tools/connectors/cloud-signing.cjs');
const { probe } = require('../../skills/mcp-tools/connectors/health.cjs');
const now = Date.parse('2026-10-17T06:00:00Z');
const guid = '12345678-1234-1234-1234-123456789abc';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const configs = {
  'aws-ec2': { AWS_REGION: 'cn-north-1', AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE1234567890', AWS_SECRET_ACCESS_KEY: 'fixture-aws-secret' },
  'aliyun-ecs': { ALIYUN_REGION: 'cn-hangzhou', ALIYUN_ACCESS_KEY_ID: 'fixture-aliyun-id', ALIYUN_ACCESS_KEY_SECRET: 'fixture-aliyun-secret' },
  'tencent-cloud': { TENCENT_REGION: 'ap-guangzhou', TENCENT_SECRET_ID: 'fixture-tencent-id', TENCENT_SECRET_KEY: 'fixture-tencent-secret' },
  'huawei-cloud': { HUAWEI_REGION: 'cn-north-4', HUAWEI_PROJECT_ID: 'a'.repeat(32), HUAWEI_ACCESS_KEY: 'fixture-huawei-id', HUAWEI_SECRET_KEY: 'fixture-huawei-secret' },
  'volcengine-ecs': { VOLC_REGION: 'cn-beijing', VOLC_ACCESS_KEY: 'fixture-volc-id', VOLC_SECRET_KEY: 'fixture-volc-secret' },
  azure: { AZURE_TENANT_ID: guid, AZURE_CLIENT_ID: guid, AZURE_SUBSCRIPTION_ID: guid, AZURE_CLIENT_SECRET: 'fixture-azure-secret' },
  'google-cloud': { GCP_PROJECT: 'fixture-project', GCP_CLIENT_EMAIL: 'fixture@fixture-project.iam.gserviceaccount.com', GCP_PRIVATE_KEY: pem.replace(/\n/g, '\\n') },
};
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const spec = id => ({ command: 'soduwork-connector', args: [id], env: configs[id] });
function fixture(id, tool) {
  if (id === 'aws-ec2') { const action = {describe_regions:'DescribeRegions',describe_instances:'DescribeInstances',describe_images:'DescribeImages'}[tool];
    return '<' + action + 'Response><reservationSet><item><instancesSet><item><instanceId>i-one</instanceId></item><item><instanceId>i-two</instanceId></item></instancesSet></item></reservationSet><nextToken>a&amp;b</nextToken></' + action + 'Response>'; }
  if (id === 'aliyun-ecs') return tool === 'describe_regions' ? {Regions:{Region:[]}} : tool === 'describe_instances' ? {Instances:{Instance:[]},TotalCount:21} : {Images:{Image:[]},TotalCount:21};
  if (id === 'tencent-cloud') return { Response: { [tool === 'describe_regions' ? 'RegionSet' : tool === 'describe_instances' ? 'InstanceSet' : 'ImageSet']: [], TotalCount:21 } };
  if (id === 'volcengine-ecs') return { Result: { [tool === 'describe_instances' ? 'Instances' : tool === 'describe_images' ? 'Images' : 'InstanceTypes']: [], NextToken:'next-page' } };
  if (id === 'huawei-cloud') return tool === 'get_api_versions' ? {versions:[]} : tool === 'list_servers' ? {servers:[]} : {server:{id:'abc-123'}};
  if (id === 'azure') return tool === 'get_virtual_machine' ? {id:'/subscriptions/'+guid+'/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/vm'} : {value:[]};
  return tool === 'get_instance' ? {id:'123',name:'fixture-vm'} : {kind:tool === 'list_zones' ? 'compute#zoneList' : 'compute#instanceAggregatedList', nextPageToken:'page-two'};
}
function argsFor(name) {
  return name === 'get_server' ? {server_id:'abc-123'} : name === 'get_virtual_machine' ? {resource_group:'test',vm_name:'vm'}
    : name === 'get_instance' ? {zone:'us-central1-a',instance_name:'fixture-vm'} : {};
}
// Public official vectors; the POST RunInstances vector below only computes a signature, never sends a request.
test('Alibaba ACS3 matches official V3 reference vector byte for byte', () => {
  const result = sign.aliyunHeaders({ accessKeyId:'YourAccessKeyId', accessKeySecret:'YourAccessKeySecret', method:'POST',
    host:'ecs.cn-shanghai.aliyuncs.com', action:'RunInstances', version:'2014-05-26', now:Date.parse('2023-10-26T10:22:32Z'),
    nonce:'3156853299f313e23d1673dc12e1703d', query:{ ImageId:'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd', RegionId:'cn-shanghai' } });
  assert.equal(result.headers.authorization.split('Signature=')[1], '06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0');
});
test('Tencent TC3 matches official Node SDK signature vector', () => {
  const result=sign.tc3Headers({secretId:'test-secret-id',secretKey:'test-secret-key',service:'cvm',host:'cvm.tencentcloudapi.com',
    timestamp:1640995200,body:JSON.stringify({Action:'DescribeInstances',Version:'2017-03-12'})});
  assert.equal(result.headers.authorization.split('Signature=')[1],'96473b50fe407833672a5d6d067238d88bb44c8abcc39ef83baa3132afbfadd3');
  assert.equal(result.headers['content-type'],'application/json');
});
test('AWS SigV4 matches public get-vanilla reference vector', () => {
  const result=sign.sigV4Headers({accessKey:'AKIDEXAMPLE',secretKey:'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',region:'us-east-1',service:'service',
    method:'GET',host:'example.amazonaws.com',path:'/',query:{},now:Date.parse('2015-08-30T12:36:00Z')});
  assert.equal(result.headers.authorization.split('Signature=')[1],'5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});
for (const id of cloud.KINDS) for (const tool of provider(id).tools) test(id + ': runtime tools/list -> ' + tool.name + ' -> official response shape', async () => {
  const calls=[];
  const result=await runtime.session(spec(id), async rpc => {
    const listed=await rpc('tools/list'); assert.equal(listed.tools.length,3); assert.ok(listed.tools.every(t=>t.annotations.readOnlyHint));
    return rpc('tools/call',{name:tool.name,arguments:argsFor(tool.name)});
  },{now,nonce:'fixture-nonce',fetchImpl:async (url,init)=>{
    calls.push({url:new URL(url),...init}); assert.equal(init.redirect,'manual'); assert.equal(new URL(url).protocol,'https:');
    if (String(url).includes('/token')) return json({access_token:'fixture-bearer',expires_in:3600});
    const data=fixture(id,tool.name); return typeof data==='string' ? new Response(data) : json(data);
  }});
  assert.equal(result.isError,false); const payload=JSON.parse(result.content[0].text); assert.ok(payload.data);
  const call=calls.at(-1), url=call.url;
  if (id==='aws-ec2') { assert.equal(url.host,'ec2.cn-north-1.amazonaws.com.cn'); assert.ok(url.searchParams.get('Action').startsWith('Describe'));
    assert.match(payload.data.xml,/i-one/);assert.match(payload.data.xml,/i-two/);assert.equal(payload.pagination.next_token,'a&b'); }
  if (id==='aliyun-ecs') { assert.equal(url.host,'ecs.cn-hangzhou.aliyuncs.com'); assert.match(call.headers.authorization,/^ACS3-HMAC-SHA256 Credential=fixture-aliyun-id/);
    assert.equal(call.headers['x-acs-date'],'2026-10-17T06:00:00Z');assert.ok(call.headers['x-acs-action'].startsWith('Describe'));assert.equal(url.searchParams.get('AccessKeyId'),null); }
  if (id==='tencent-cloud') { assert.equal(url.host,'cvm.tencentcloudapi.com');assert.equal(call.headers['x-tc-region'],'ap-guangzhou');assert.equal(call.method,'POST'); }
  if (id==='volcengine-ecs') { assert.equal(url.host,'ecs.cn-beijing.volcengineapi.com');assert.match(url.searchParams.get('Action'),/^Describe/);assert.equal(url.searchParams.get('MaxResults'),'20'); }
  if (id==='huawei-cloud' && tool.name!=='get_api_versions') assert.match(url.pathname,/^\/v1\/[a-f0-9]{32}\/cloudservers\//);
  if (id==='azure') { assert.equal(calls.length,2);assert.equal(call.headers.Authorization,'Bearer fixture-bearer');assert.equal(url.searchParams.getAll('api-version').length,1);
    assert.match(calls[0].body,/scope=https%3A%2F%2Fmanagement.azure.com%2F.default/); }
  if (id==='google-cloud') { assert.equal(calls.length,2);assert.equal(call.headers.Authorization,'Bearer fixture-bearer');assert.equal(url.host,'compute.googleapis.com');
    const jwt=new URLSearchParams(calls[0].body).get('assertion').split('.');const claims=JSON.parse(Buffer.from(jwt[1],'base64url'));
    assert.equal(claims.scope,'https://www.googleapis.com/auth/compute.readonly');assert.equal(claims.aud,'https://oauth2.googleapis.com/token');
    assert.equal(claims.exp-claims.iat,3600);assert.ok(crypto.verify('RSA-SHA256',Buffer.from(jwt[0]+'.'+jwt[1]),keys.publicKey,Buffer.from(jwt[2],'base64url'))); }
});
for (const id of cloud.KINDS) test(id + ': invalid args and missing credentials fail before transport',async()=>{
  let calls=0; const options={fetchImpl:async()=>{calls++;return json({})}};
  await assert.rejects(runtime.session(spec(id), rpc=>rpc('tools/call',{name:provider(id).tools[0].name,arguments:{command:'delete'}}),options));
  await assert.rejects(runtime.session({...spec(id),env:{}},()=>{}));assert.equal(calls,0);
});
test('Azure pagination stays on current subscription endpoint without duplicating api-version',async()=>{
  const path='/subscriptions/'+guid+'/providers/Microsoft.Compute/virtualMachines';
  const next='https://management.azure.com'+path+'?api-version=2024-07-01&$skiptoken=abc%2Bdef';
  const def=provider('azure'),tool=def.tools.find(t=>t.name==='list_virtual_machines');
  const req=cloud.request('azure',configs.azure,tool,{next_link:next});assert.equal(req.url.href,next);
  for (const invalid of [next.replace(guid,'a'.repeat(36)),next.replace('management.azure.com','evil.example'),next.replace('/virtualMachines','/disks'),next+'#fragment'])
    assert.throws(()=>cloud.request('azure',configs.azure,tool,{next_link:invalid}),/当前订阅/);
});
for (const [id,payload] of [['tencent-cloud',{Response:{Error:{Code:'AuthFailure',Message:'secret-echo'}}}],['volcengine-ecs',{ResponseMetadata:{Error:{Code:'InvalidAccessKey',Message:'secret-echo'}}}],['aliyun-ecs',{Code:'InvalidAccessKeyId',Message:'secret-echo'}]])
  test(id+': HTTP 200 business failure never marks connected or exposes platform echo',async()=>{
    const result=await probe(spec(id),{fetchImpl:async()=>json(payload)});
    assert.equal(result.ok,false);assert.equal(result.authenticationTested,false);assert.doesNotMatch(JSON.stringify(result),/secret-echo/);
  });
test('cloud health performs authenticated read; empty/malformed JSON is not success',async()=>{
  const result=await probe(spec('huawei-cloud'),{fetchImpl:async url=>{assert.match(String(url),/cloudservers\/detail\?limit=1/);return json({servers:[]})}});
  assert.equal(result.authenticationTested,true);
  assert.equal((await probe(spec('tencent-cloud'),{fetchImpl:async()=>json({})})).ok,false);
});
test('cloud transport timeout, redirect and response limits apply to token and resource requests',async()=>{
  const def=provider('azure'),tool=def.tools[0];
  await assert.rejects(cloud.execute(def,configs.azure,tool,{}, {timeoutMs:10,fetchImpl:()=>new Promise(()=>{})}),/超时/);
  await assert.rejects(cloud.execute(def,configs.azure,tool,{}, {fetchImpl:async()=>new Response('',{status:302,headers:{Location:'https://evil.example'}})}),/重定向/);
  await assert.rejects(cloud.execute(def,configs.azure,tool,{}, {fetchImpl:async()=>new Response('x'.repeat(2*1024*1024+1))}),/2 MB/);
});
test('platform secrets and signed authorization are removed from returned data',async()=>{
  const def=provider('tencent-cloud');const reply=await cloud.execute(def,configs['tencent-cloud'],def.tools[0],{}, {fetchImpl:async(url,init)=>json({Response:{RegionSet:[{note:configs['tencent-cloud'].TENCENT_SECRET_KEY,auth:init.headers.authorization}]}})});
  assert.doesNotMatch(reply.content[0].text,/fixture-tencent-secret|TC3-HMAC/);assert.match(reply.content[0].text,/已隐藏凭据/);
});
test('token failure, invalid lifetime and cancelled token requests never reach resource API',async()=>{
  const def=provider('azure'),tool=def.tools[0];
  for (const data of [{error:'invalid_client',error_description:'secret-echo'}, {access_token:'a',expires_in:0},{access_token:'bad token',expires_in:3600}]) {
    let count=0; await assert.rejects(cloud.execute(def,configs.azure,tool,{}, {fetchImpl:async()=>{count++;return json(data)}}),error=>!error.message.includes('secret-echo'));assert.equal(count,1);
  }
  const cancel=new AbortController();cancel.abort();let called=false;
  await assert.rejects(cloud.execute(def,configs.azure,tool,{}, {signal:cancel.signal,fetchImpl:async()=>{called=true;return json({})}}),/取消/);assert.equal(called,false);
});

test('Huawei SDK official GET vector requires canonical URI trailing slash',()=>{
 const result=sign.huaweiHeaders({accessKey:'AccessKey',secretKey:'SecretKey',method:'GET',host:'service.endpoint.myhuaweicloud.com',path:'/resources',query:{size:'1'},now:Date.parse('2020-06-08T02:39:00Z')});
 assert.equal(result.headers.authorization,'SDK-HMAC-SHA256 Access=AccessKey, SignedHeaders=host;x-sdk-date, Signature=cfb4171acec81de07d50e53d57eb77edd537414d66ddb1d7d780f128e12cd842');
});

test('Volcengine signing matches official Python SDK 1.0.229 with encoded pagination',()=>{
 const result=sign.volcHeaders({accessKey:'fixture-volc-id',secretKey:'fixture-volc-secret',service:'ecs',region:'cn-beijing',method:'GET',
 host:'ecs.cn-beijing.volcengineapi.com',path:'/',query:{Action:'DescribeInstances',Version:'2020-04-01',MaxResults:'20',NextToken:'a+b 中文'},now});
 assert.equal(result.headers.authorization,'HMAC-SHA256 Credential=fixture-volc-id/20261017/cn-beijing/ecs/request, SignedHeaders=host;x-content-sha256;x-date, Signature=2ea9040be5eb9d4292fd750464f67ab86244d1cf6ce097269f88c8c9f4a85e7b');
});

test('real OAuth HTTP400 invalid_client is needs_auth, without reflecting server body',async()=>{
 for(const id of ['azure','google-cloud']) {
  const result=await probe(spec(id),{fetchImpl:async()=>new Response('{"error":"invalid_client","error_description":"secret-echo"}',{status:400})});
  assert.equal(result.connectionState,'needs_auth');assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/secret-echo/);
 }
});
test('Aliyun and Tencent return the next page parameters, not the current page',()=>{
 let result=cloud.parse('aliyun-ecs',{name:'describe_instances'},{page_number:1,page_size:20},Buffer.from(JSON.stringify({Instances:{Instance:[]},TotalCount:21})));
 assert.deepEqual(result.pagination,{has_more:true,page_number:2,page_size:20});
 result=cloud.parse('tencent-cloud',{name:'describe_instances'},{offset:0,limit:20},Buffer.from(JSON.stringify({Response:{InstanceSet:[],TotalCount:21}})));
 assert.deepEqual(result.pagination,{has_more:true,offset:20,limit:20});
 result=cloud.parse('tencent-cloud',{name:'describe_instances'},{offset:20,limit:20},Buffer.from(JSON.stringify({Response:{InstanceSet:[],TotalCount:21}})));
 assert.deepEqual(result.pagination,{has_more:false});
});
