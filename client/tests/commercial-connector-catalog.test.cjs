'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {provider}=require('../../skills/mcp-tools/connectors/validation.cjs');
const {request,session}=require('../../skills/mcp-tools/connectors/runtime.cjs');
const root=path.resolve(__dirname,'../../skills/mcp-tools/connectors/providers');
const ids=fs.readdirSync(root).map(x=>x.replace(/\.json$/,''));
const schemaCandidates=['ABC','ABC-123','123456789:abcdefghijklmnopqrstuvwxyz1234567890',['xoxb','123456789','123456789','fixturecatalogtoken'].join('-'),'1'.repeat(24),'example','company','abc','root','public','test@example.com','2026-10-16','2026-10-16T09:00:00Z','2048x2048','https://example.com/image.png',
 'www.zohoapis.com','api.example.com','127.0.0.1','5432','us1','us-east-1','C0123456789','abc-mnop-xyz','spaces/abc-mnop-xyz','app01234567890123','app0123456789012345',
 '123456','1234567890','1234567890123','123456789012345678','0123456789abcdef0123456789abcdef','01234567-89ab-4def-8123-456789abcdef',
 'abcdef1234567890abcdef1234567890abcdef1234','gid://shopify/Product/123','owner/repository','text/plain','A1:B2'];
function sample(s,key){
 if(Object.hasOwn(s,'default'))return s.default;if(s.enum)return s.enum[0];
 if(s.type==='object')return Object.fromEntries((s.required||[]).map(k=>[k,sample(s.properties[k],k)]));
 if(s.type==='array')return Array.from({length:s.minItems||1},()=>sample(s.items||{type:'string'},key));
 if(s.type==='boolean')return false;if(s.type==='integer'||s.type==='number')return s.minimum??1;
 const candidates=[...(s.example?[s.example]:[]),...schemaCandidates,'a'.repeat(s.minLength||20),'1'.repeat(s.minLength||12)];
 const v=candidates.find(x=>(!s.pattern||new RegExp(s.pattern).test(x))&&x.length>=(s.minLength||0)&&x.length<=(s.maxLength||10000));
 assert.ok(v!==undefined,'add fixture for '+key+' '+s.pattern);return v;
}
function credentials(d){return Object.fromEntries(d.fields.map(f=>[f.key,f.key==='ALLOW_WRITES'?'true':f.secret?(f.pattern?sample({...f,type:'string'},f.key):'opaque-test-credential'):f.default?String(f.default):sample({...f,type:'string'},f.key)]));}

test('59 reviewed definitions expose stable tools, complete references and bounded input',()=>{
 assert.equal(ids.length,59);
 for(const id of ids){
  const d=provider(id),names=new Set();
  assert.ok(d.officialDocs.length&&d.officialDocs.every(x=>x.startsWith('https://')));
  for(const t of d.tools){
   assert.ok(!names.has(t.name),id+' duplicate '+t.name);names.add(t.name);
   assert.equal(t.inputSchema.additionalProperties,false,id+': '+t.name);
   assert.equal(typeof t.readOnly,'boolean');
   const props=t.inputSchema.properties||{};
   for(const key of t.inputSchema.required||[])assert.ok(Object.hasOwn(props,key),id+' '+key);
   for(const ref of JSON.stringify(t.body??{}).matchAll(/"\$([A-Za-z][A-Za-z0-9_]*)"/g))assert.ok(Object.hasOwn(props,ref[1]),id+' missing body input '+ref[1]);
   for(const ref of Object.values(t.query||{}))assert.ok(Object.hasOwn(props,ref),id+' missing query '+ref);
   if(d.runtimeKind)continue;
   const req=request(d,credentials(d),t,sample(t.inputSchema,t.name));
   assert.equal(req.url.protocol,'https:');
   assert.ok(!/[{}]/.test(req.url.href),id+' unresolved path');
   assert.ok(!Object.values(req.headers).some(v=>/[{}]/.test(v)),id+' unresolved header');
   if(req.body&&req.headers['Content-Type']==='application/json')JSON.parse(req.body);
  }
 }
});
test('generic connections only expose write tools with explicit per-connection permission',async()=>{
 const d=provider('github'),env={GITHUB_TOKEN:'opaque-token'};
 const read=await session({command:'soduwork-connector',args:['github'],env},rpc=>rpc('tools/list'));
 assert.ok(read.tools.every(t=>t.annotations.readOnlyHint));
 const write=await session({command:'soduwork-connector',args:['github'],env:{...env,ALLOW_WRITES:'true'}},rpc=>rpc('tools/list'));
 assert.ok(write.tools.some(t=>t.name==='create_issue'));
 await assert.rejects(session({command:'soduwork-connector',args:['github'],env},rpc=>rpc('tools/call',{name:'create_issue',arguments:{owner:'a',repo:'b',title:'c'}})),/授权写入/);
});
test('known upstream wire formats match documented API contracts',()=>{
 function make(id,name,args){const d=provider(id);return request(d,credentials(d),d.tools.find(t=>t.name===name),args);}
 assert.equal(make('clickup','get_authorized_user',{}).headers.Authorization,'opaque-test-credential');
 assert.equal(make('discord','get_current_user',{}).headers.Authorization,'Bot '+credentials(provider('discord')).BOT_TOKEN);
 assert.equal(make('zoho-crm','get_current_user',{}).headers.Authorization,'Zoho-oauthtoken opaque-test-credential');
 const zendesk=make('zendesk','get_current_user',{});assert.match(Buffer.from(zendesk.headers.Authorization.slice(6),'base64').toString(),/\/token:/);
 const stripe=make('stripe','create_customer',{email:'a@example.com',name:'A B'});assert.equal(stripe.headers['Content-Type'],'application/x-www-form-urlencoded');assert.equal(new URLSearchParams(stripe.body).get('name'),'A B');
 assert.equal(make('dropbox','get_current_account',{}).body,'null');
 const mail=make('gmail','send_message',{from:'a@example.com',to:'b@example.com',subject:'中文',body:'正文'});assert.match(Buffer.from(JSON.parse(mail.body).raw,'base64url').toString(),/From: a@example.com/);
 const drive=make('google-drive','upload_file',{name:'中文.txt',mime_type:'text/plain',content:'正文'});assert.match(drive.headers['Content-Type'],/^multipart\/related; boundary=/);assert.match(drive.body,/中文.txt/);
 const cloud=make('onedrive','upload_small_file',{parent_id:'root',file_name:'中文.txt',content:'正文'});assert.equal(cloud.method,'PUT');assert.equal(cloud.body,'正文');
 assert.match(make('google-meet','get_space',{space_id:'abc-mnop-xyz'}).url.pathname,/\/spaces\/abc-mnop-xyz$/);
 const excel=make('excel-online','add_table_row',{item_id:'abcdef123',table_id:'Sales',values:[['1','text']]});assert.ok(excel.url.pathname.endsWith('/tables/Sales/rows/add'));
 const page=make('onedrive','list_children',{item_id:'root',skip_token:'abc+/=',top:25});assert.equal(page.url.searchParams.get('$skiptoken'),'abc+/=');assert.equal(page.url.searchParams.get('$top'),'25');
 const video=make('runway','create_image_to_video',{model:'gen4_turbo',prompt_text:'test',prompt_image:'https://example.com/frame.png',ratio:'1280:720'});assert.equal(JSON.parse(video.body).ratio,'1280:720');
 assert.equal(make('google-ads','list_accessible_customers',{}).headers['developer-token'],'opaque-test-credential');
});
