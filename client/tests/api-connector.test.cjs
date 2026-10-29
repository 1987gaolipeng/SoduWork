'use strict';
process.env.SODUWORK_ENV='development';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {spawn}=require('node:child_process');
const {compile}=require('../../skills/mcp-tools/connectors/api-definition.cjs');
const runtime=require('../../skills/mcp-tools/connectors/api-runtime.cjs');
function doc(base='https://api.example.com/v1',securitySchemes={},security=[]){return {openapi:'3.0.3',info:{title:'研发系统'},servers:[{url:base}],components:{securitySchemes},security,'x-soduwork-probe':'identity',paths:{
 '/me':{get:{operationId:'identity'}},
 '/projects/{id}':{get:{operationId:'get_project',parameters:[{in:'path',name:'id',schema:{type:'string'},required:true},{in:'query',name:'tag',schema:{type:'array',items:{type:'string'}}}]}},
 '/projects':{post:{operationId:'create_project',requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{name:{type:'string'}},required:['name']}}}}}}
}};}
const spec=(d,env={})=>({command:'soduwork-api',args:[],apiDefinition:compile(d),env});
async function fixture(handler,fn){const sockets=new Set();let closing=false;const server=http.createServer((req,res)=>{
 // Each fixture owns a short-lived server; avoid reusing an aborted response socket.
 res.setHeader('Connection','close');handler(req,res);
});
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));if(closing)socket.destroy();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await fn('http://127.0.0.1:'+server.address().port);}finally{
 // Close aborted response connections after all request assertions have completed.
 closing=true;const closed=new Promise(r=>server.close(r));server.closeAllConnections();for(const socket of sockets)socket.destroy();await closed;
}}
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
async function bridge(s,action,tool,args){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,['skills/mcp-tools/scripts/mcp.mjs',action,'api',...(tool?[tool]:[])],{cwd:require('node:path').resolve(__dirname,'../..'),env:{...process.env,SODUWORK_MCP_SERVERS_JSON:JSON.stringify({servers:{api:s}}),SODUWORK_MCP_JSON:'1',SODUWORK_MCP_ARGS_STDIN:'1'}});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',code=>code?reject(Error(err)):resolve(JSON.parse(out)));p.stdin.end(JSON.stringify(args||{}));});}
test('compiler creates stable credential-free definitions and retains local refs',()=>{const d=doc();d.components.schemas={Project:{type:'object',properties:{name:{type:'string',example:'NEVER_STORE_EXAMPLE'}}}};d.paths['/projects'].post.requestBody.content['application/json'].schema={$ref:'#/components/schemas/Project'};const a=compile(d);assert.equal(a.id,compile(a).id);assert.equal(a.tools.length,3);assert(!JSON.stringify(a).includes('NEVER_STORE_EXAMPLE'));assert.equal(a.fields[0].key,'ALLOW_WRITES');});
test('compact API inventory compiles without authoring executable code',()=>{const c=compile({name:'库存',baseUrl:'https://api.example.com',endpoints:[{method:'GET',path:'/stock',name:'stock'}]});assert.equal(c.tools[0].name,'stock');});
for(const [name,change]of Object.entries({
 remote_ref:d=>{d.paths['/me']={$ref:'https://evil.test/spec.json'};},
 unsupported_auth:d=>{d.components.securitySchemes.x={type:'openIdConnect'};},
 alternatives:d=>{d.security=[{a:[]},{b:[]}];},
 undeclared_auth:d=>{d.security=[{missing:[]}];},
 metadata:d=>{d.servers[0].url='http://169.254.169.254/latest';},
 ipv6_metadata:d=>{d.servers[0].url='http://[::ffff:169.254.169.254]';},
 public_http:d=>{d.servers[0].url='http://api.example.com';},
 credentials:d=>{d.servers[0].url='https://user:secret@api.example.com';},
 duplicate:d=>{d.paths['/projects'].post.operationId='identity';},
 unsafe_probe:d=>{d['x-soduwork-probe']='create_project';},
 callback:d=>{d.paths['/me'].get.callbacks={x:{}};},
 missing_path:d=>{d.paths['/unknown/{x}']={get:{operationId:'unknown'}};},
 regexp:d=>{d.paths['/projects/{id}'].get.parameters[0].schema.pattern='(a+)+$';}
}))test('compiler rejects '+name,()=>{const d=doc();change(d);assert.throws(()=>compile(d));});
test('runtime uses canonical document, not tampered compiled fields',async()=>{const s=spec(doc());s.apiDefinition.tools[0].path='/evil';s.apiDefinition.baseUrl='https://evil.test';const d=runtime.definition(s);assert.equal(d.tools[0].path,'/me');assert.equal(d.baseUrl,'https://api.example.com/v1');});
test('tools list is offline and hides write tools until explicitly allowed',async()=>{const s=spec(doc());const rows=await runtime.session(s,rpc=>rpc('tools/list'));assert.equal(rows.tools.length,2);s.env.ALLOW_WRITES='true';assert.equal((await runtime.session(s,rpc=>rpc('tools/list'))).tools.length,3);await assert.rejects(runtime.session({...s,env:{}},rpc=>rpc('tools/call',{name:'create_project',arguments:{body:{name:'x'}}})),/写入/);});
test('real bridge API key, path/query encoding, typed JSON writes and redaction',async()=>{const seen=[];await fixture((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{seen.push({url:req.url,method:req.method,auth:req.headers['x-api-key'],body});json(res,{ok:true,path:req.url,echo:req.headers['x-api-key'],body:body?JSON.parse(body):null});});},async base=>{
 const s=spec(doc(base,{key:{type:'apiKey',in:'header',name:'X-API-Key'}},[{key:[]}]),{AUTH_KEY_KEY:'test-$SECRETS-$PATH',ALLOW_WRITES:'false'});
 const health=await bridge(s,'health');assert.equal(health.authenticationTested,true);
 const read=await bridge(s,'call','get_project',{id:'中文 空格',tag:['one','two']});assert(!JSON.stringify(read).includes('test-$SECRETS-$PATH'));assert.equal(seen[0].auth,'test-$SECRETS-$PATH');assert.match(seen[1].url,/tag=one&tag=two/);
 s.env.ALLOW_WRITES='true';await bridge(s,'call','create_project',{body:{name:'项目'}});assert.equal(JSON.parse(seen[2].body).name,'项目');
 });});
test('real Basic and query API key authentication work',async()=>{await fixture((req,res)=>json(res,{auth:req.headers.authorization,query:new URL(req.url,'http://local').searchParams.get('key')}),async base=>{
 for(const[schemes,env]of [[{auth:{type:'http',scheme:'basic'}},{AUTH_AUTH_USER:'dev',AUTH_AUTH_PASSWORD:'secret'}],[{auth:{type:'apiKey',in:'query',name:'key'}},{AUTH_AUTH_KEY:'secret'}]]){const s=spec(doc(base,schemes,[{auth:[]}]),env);const r=await runtime.session(s,rpc=>rpc('tools/call',{name:'identity'}));assert(!JSON.stringify(r).includes('secret'));assert(!JSON.stringify(r).includes(Buffer.from('dev:secret').toString('base64')));}
 });});
test('real client credentials exchanges token on each process; never retries writes',async()=>{let token=0,write=0;await fixture((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{if(req.url==='/token'){assert.equal(new URLSearchParams(body).get('grant_type'),'client_credentials');assert.equal(req.headers.authorization,'Basic '+Buffer.from('client:secret').toString('base64'));json(res,{access_token:'token-'+(++token),token_type:'Bearer',expires_in:30});}else if(req.method==='POST'){write++;json(res,{error:'failed'},503);}else{assert.equal(req.headers.authorization,'Bearer token-'+token);json(res,{ok:true});}});},async base=>{
 const s=spec(doc(base,{oauth:{type:'oauth2',flows:{clientCredentials:{tokenUrl:base+'/token',scopes:{read:''}}}}},[{oauth:['read']}]),{AUTH_OAUTH_CLIENT_ID:'client',AUTH_OAUTH_CLIENT_SECRET:'secret',ALLOW_WRITES:'true'});
 await bridge(s,'call','identity');await bridge(s,'call','identity');assert.equal(token,2);
 await assert.rejects(bridge(s,'call','create_project',{body:{name:'x'}}));assert.equal(write,1);
 });});
// Keep each failure on its own server so aborted sockets cannot contaminate the next case.
// Advance the timeout only after the server accepts the request, avoiding a Windows close/accept race.
for (const [route, pattern] of [['unauthorized', /授权/], ['redirect', /重定向/], ['big', /2 MB/], ['slow', /超时/]]) {
 test('API failure ' + route + ' preserves its reason without leaking credentials', async t => {
  if (route === 'slow') t.mock.timers.enable({apis:['setTimeout']});
  await fixture((req, res) => {
   if (route === 'unauthorized') return json(res, {secret:'never'}, 401);
   if (route === 'redirect') { res.writeHead(302, {Location:'https://evil.test'}); res.end(); return; }
   if (route === 'big') return json(res, {data:'x'.repeat(2*1024*1024)});
   // Keep the response pending while exercising the real request timeout.
   t.mock.timers.tick(11);
  }, async base => {
   const d=doc(base); d.paths={['/'+route]:{get:{operationId:'identity'}}};
   await assert.rejects(runtime.session(spec(d), rpc=>rpc('tools/call',{name:'identity'}),
    {timeoutMs:route==='slow'?10:5000}), pattern);
  });
 });
}

test('missing explicit probe never pretends business authentication was tested',async()=>{const d=doc();delete d['x-soduwork-probe'];const r=await runtime.probe(spec(d));assert.equal(r.ok,true);assert.equal(r.authenticationTested,false);});
test('authcode runtime requires Hub-supplied token and supports retained binding token',async()=>{await fixture((req,res)=>{assert.equal(req.headers.authorization,'Bearer from-hub');json(res,{ok:true});},async base=>{const d=doc(base,{oauth:{type:'oauth2',flows:{authorizationCode:{authorizationUrl:base+'/authorize',tokenUrl:base+'/token',scopes:{read:''}}}}},[{oauth:['read']}]);const s=spec(d,{AUTH_OAUTH_CLIENT_ID:'id',AUTH_OAUTH_CLIENT_SECRET:'secret'});await assert.rejects(runtime.session(s,rpc=>rpc('tools/call',{name:'identity'})),/认证/);s.env.AUTH_OAUTH_ACCESS_TOKEN='from-hub';await runtime.session(s,rpc=>rpc('tools/call',{name:'identity'}));});});

test('document object key order does not invalidate approval or OAuth binding',()=>{const a=doc();const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reverse(v[k])])):v;assert.equal(compile(a).id,compile(reverse(a)).id);});

test('anonymous probe does not claim account credentials are verified',async()=>{await fixture((req,res)=>json(res,{ok:true}),async base=>{const r=await runtime.probe(spec(doc(base)));assert.equal(r.ok,true);assert.equal(r.authenticationTested,false);});});
test('OAuth rejects insecure private-network token endpoints',()=>{const d=doc('https://api.example.com',{o:{type:'oauth2',flows:{clientCredentials:{tokenUrl:'http://192.0.2.7/token',scopes:{}}}}},[{o:[]}]);assert.throws(()=>compile(d),/HTTPS/);});
test('token service outage is not mislabeled as revoked credentials',async()=>{await fixture((req,res)=>json(res,{error:'unavailable'},503),async base=>{const s=spec(doc(base,{o:{type:'oauth2',flows:{clientCredentials:{tokenUrl:base+'/token',scopes:{}}}}},[{o:[]}]),{AUTH_O_CLIENT_ID:'id',AUTH_O_CLIENT_SECRET:'fixture'});const r=await runtime.probe(s);assert.equal(r.connectionState,'error');});});

for(const security of [[null],[false],[[]],null])test('malformed security cannot become anonymous: '+JSON.stringify(security),()=>{const d=doc();d.paths['/me'].get.security=security;assert.throws(()=>compile(d));});
test('compact inventory rejects unknown methods instead of dropping endpoints',()=>{assert.throws(()=>compile({name:'系统',baseUrl:'https://api.example.com',endpoints:[{method:'GET',path:'/ok',name:'ok'},{method:'FETCH',path:'/missing',name:'missing'}]}));});
test('literal Unicode paths remain usable without widening destination',async()=>{await fixture((req,res)=>{assert.equal(req.url,'/%E7%94%A8%E6%88%B7');json(res,{ok:true});},async base=>{const d=compile({name:'系统',baseUrl:base,endpoints:[{method:'GET',path:'/用户',name:'users'}]});await runtime.execute(d,{},d.tools[0],{});});});

function compactAuth(){return {name:'Auth contract',baseUrl:'https://api.example.com',
 securitySchemes:{auth:{type:'http',scheme:'bearer'}},security:[{auth:[]}],
 endpoints:[{method:'GET',path:'/identity',operationId:'identity'}]};}
const falseyAuthValues={null:null,false:false,zero:0,negativeZero:-0,empty:'',undefined:undefined,nan:NaN};
for(const [label,value]of Object.entries(falseyAuthValues)){
 test('compact security rejects explicit falsey '+label+' instead of anonymous access',()=>{
  const d=compactAuth();d.security=value;assert.throws(()=>compile(d),/认证/);
 });
 test('malformed authentication metadata rejects falsey '+label+' without fallback',()=>{
  const compact=compactAuth();compact.securitySchemes=value;compact.security=[];
  assert.throws(()=>compile(compact),/securitySchemes/);
  const schemes={oauth:{type:'oauth2',flows:{clientCredentials:{tokenUrl:'https://auth.example.com/token',scopes:{}}}}};
  const d=doc('https://api.example.com',schemes,[{oauth:[]}]);
  schemes.oauth.flows.authorizationCode=value;assert.throws(()=>compile(d),/flows/);delete schemes.oauth.flows.authorizationCode;
  schemes.oauth.flows.clientCredentials.scopes=value;assert.throws(()=>compile(d),/scopes/);schemes.oauth.flows.clientCredentials.scopes={};
  schemes.oauth['x-token-endpoint-auth-method']=value;assert.throws(()=>compile(d),/认证方式/);
 });
}
test('explicit empty security remains anonymous and omitted operation security inherits authentication',()=>{
 const d=compactAuth();d.endpoints.push({method:'GET',path:'/public',operationId:'public',security:[]});
 const compiled=compile(d);assert.deepEqual(compiled.tools[0].security,{auth:[]});assert.deepEqual(compiled.tools[1].security,{});
 const anonymous={name:d.name,baseUrl:d.baseUrl,endpoints:d.endpoints};assert.deepEqual(compile(anonymous).tools[0].security,{});
 const oauth=doc('https://api.example.com',{o:{type:'oauth2',flows:{clientCredentials:{tokenUrl:'https://auth.example.com/token'}}}},[{o:[]}]);
 assert.equal(compile(oauth).securitySchemes.o.tokenAuth,'client_secret_basic');assert.deepEqual(compile(oauth).securitySchemes.o.scopes,[]);
});
test('malformed authentication containers never become an empty catalog',()=>{
 for(const value of [null,false,0,'',[],undefined]){
  const d=doc();d.components=value;assert.throws(()=>compile(d),/components/);
  d.components={securitySchemes:value};assert.throws(()=>compile(d),/securitySchemes/);
 }
});
