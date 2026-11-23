import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import connectorConfig from '../../client/components/panels/connector-config.js'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as argumentText from '../src/screens/mcp-arguments.js'
import { setLocale, translateText as tx } from '../src/i18n.js'
const text=n=>Array.isArray(n)?n.map(text).join(''):n?.props?text(n.props.children):typeof n==='string'?n:''
const formCss=fs.readFileSync(new URL('../src/screens/McpConnectionForm.css',import.meta.url),'utf8')
const wait=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
async function form(t, probe, overrides = {}) {
 const previous=globalThis.window;globalThis.window={SoduWorkConnectorConfig:connectorConfig,dispatchEvent(){}};t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous});
 const calls=[],pending=[];const page=await createComponentHarness(new URL('../src/screens/McpConnectionForm.jsx',import.meta.url),{exportName:'McpForm',props:{initial:{id:'a',name:'A',type:'http',url:'https://example.com/mcp'},onClose(){},onSave:async s=>calls.push(s),...overrides},dependencies:{
 '../api.js':{api:{probeMcpServer:async s=>{pending.push(s);return probe?probe(s):{ok:true,authenticationTested:true}}}},'./mcp-arguments.js':argumentText,'../ui.jsx':{Modal:'Modal',Icon:'Icon',SelectMenu:'SelectMenu',toast(){}},'../components/ConnectorIcon.jsx':'ConnectorIcon','./McpConnectionForm.css':{},'../../../client/components/panels/connector-config.js':connectorConfig}});
 t.after(()=>page.unmount());page.render();return {page,calls,pending,button:s=>page.nodes(n=>n.type==='button'&&text(n)===s)[0],footer:()=>page.nodes(n=>n.type==='Modal')[0].props.foot.props.children.at(-1),url:()=>page.nodes(n=>n.type==='input'&&n.props.value?.startsWith?.('https://'))[0]}
}
test('connect checks once and enables; duplicate clicks cannot create duplicate writes',async t=>{
 const d=wait(),f=await form(t,()=>d.promise);const one=f.footer().props.onClick(),two=f.footer().props.onClick();assert.equal(f.pending.length,1);assert.equal(f.calls.length,0);d.resolve({ok:true,authenticationTested:true});await Promise.all([one,two]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].enabled,true)
});
test('connector form keeps long labels readable, removes double focus chrome, and expands auth headers',()=>{
 assert.match(formCss,/\.connector-form \.f-lbl\{[^}]*overflow-wrap:anywhere/)
 assert.match(formCss,/\.connector-form \.connector-auth-headers\{[^}]*min-height:112px/)
 assert.match(formCss,/\.connector-form :is\(input,select,textarea\):focus\{[^}]*box-shadow:none/)
})
test('connection labels follow locale while names, auth keys and saved configuration stay intact', async t => {
 t.after(() => setLocale('zh-CN'));
 const initial = {id:'a',name:'用户自定义连接',type:'http',url:'https://example.com/mcp',keycloak:{tokenUrl:'https://auth.example/token',username:'业务账号',password:'fixture-secret'}};
 for (const [locale,title,label] of [['en-US','Manage connection','Token URL'],['ja-JP','接続を管理','トークン URL'],['ko-KR','연결 관리','토큰 URL']]) {
  setLocale(locale); const f=await form(t,null,{initial});
  assert.equal(f.page.nodes(n=>n.type==='Modal')[0].props.title,title);
  assert.ok(text(f.page.render()).includes(label));
  assert.ok(f.page.nodes(n=>n.type==='input'&&n.props.value==='用户自定义连接').length);
  await f.footer().props.onClick();
  assert.equal(f.calls[0].name,initial.name); assert.equal(f.calls[0].url,initial.url);
  assert.deepEqual(f.calls[0].keycloak,initial.keycloak); assert.equal(f.calls[0].enabled,true);
 }
});
test('conditional connection validation uses the current locale without probing or losing the draft', async t => {
 t.after(() => setLocale('zh-CN'));
 for (const [locale,message] of [['en-US','Enter a connection URL'],['ja-JP','接続先 URL を入力してください'],['ko-KR','연결 URL을 입력하세요']]) {
  setLocale(locale); const f=await form(t,null,{initial:{name:'保持原稿',type:'http',url:''}});
  await f.footer().props.onClick(); f.page.render();
  assert.ok(text(f.page.render()).includes(message)); assert.equal(f.pending.length,0); assert.equal(f.calls.length,0);
  assert.ok(f.page.nodes(n=>n.type==='input'&&n.props.value==='保持原稿').length);
 }
});
test('changed config discards previous result',async t=>{
 const old=wait(),f=await form(t,()=>old.promise);const one=f.button('仅检查连接').props.onClick();f.page.act(()=>f.url().props.onChange({target:{value:'https://new.example/mcp'}}));old.resolve({ok:true,authenticationTested:true});await one;f.page.render();assert.equal(f.page.nodes(n=>n.props.className?.includes?.('connector-status')).length,0);assert.equal(f.calls.length,0)
});
test('auth rejection preserves draft without enabling',async t=>{
 const f=await form(t,()=>({ok:false,error:'invalid credentials'}));await f.footer().props.onClick();f.page.render();assert.equal(f.calls.length,0);assert.match(text(f.page.render()),/invalid credentials/);assert.equal(f.url().props.value,'https://example.com/mcp')
});
test('inactive draft skips probe',async t=>{
 const f=await form(t);await f.button('保存为停用配置').props.onClick();assert.equal(f.calls.length,1);assert.equal(f.calls[0].enabled,false);assert.equal(f.pending.length,0)
});
test('late result after unmount never saves or mutates state',async t=>{
 const d=wait(),f=await form(t,()=>d.promise);const p=f.footer().props.onClick();f.page.unmount();d.resolve({ok:true,authenticationTested:true});await p;assert.equal(f.calls.length,0)
});
test('company management writes one row with its original server revision',async t=>{
 const calls=[];const original={id:'a',name:'A',revision:'server-rev',type:'http',url:'https://a.example/mcp'};
 const page=await createComponentHarness(new URL('../src/screens/McpServers.jsx',import.meta.url),{dependencies:{'../api.js':{api:{mcpServers:async()=>({servers:[original]}),upsertMcpServer:async(server,base)=>{calls.push({server,base});return{servers:[server,{id:'colleague',name:'new'}]}},deleteMcpServer:async()=>{throw Error('unexpected')}}},'../ui.jsx':{ErrorState:'ErrorState',Loading:'Loading',Icon:'Icon',Modal:'Modal',Confirm:'Confirm',toast(){}},'./McpSharing.jsx':'McpSharing','../components/ConnectorIcon.jsx':'ConnectorIcon','./McpConnectionForm.jsx':{McpForm:'McpForm'}}});
 t.after(()=>page.unmount());page.render();await page.flush();page.act(()=>page.nodes(n=>n.type==='button'&&text(n)==='编辑')[0].props.onClick());await page.nodes(n=>n.type==='McpForm')[0].props.onSave({...original,name:'Updated'});page.render();assert.deepEqual(calls[0].base,original);assert.equal(calls[0].server.name,'Updated');assert.match(text(page.render()),/new/)
});

async function management(t, api) {
 const messages=[];
 const page=await createComponentHarness(new URL('../src/screens/McpServers.jsx',import.meta.url),{dependencies:{
  '../api.js':{api},
  '../ui.jsx':{ErrorState:'ErrorState',Loading:'Loading',Icon:'Icon',Modal:'Modal',Confirm:'Confirm',toast:message=>messages.push(message)},
  './McpSharing.jsx':'McpSharing','../components/ConnectorIcon.jsx':'ConnectorIcon','./McpConnectionForm.jsx':{McpForm:'McpForm'},
 }});
 t.after(()=>page.unmount());page.render();await page.flush();
 const dialog=action=>page.nodes(node=>node.type===(action==='save'?'McpForm':'Confirm'))[0];
 return {page,messages,dialog,
  open(action){page.act(()=>page.nodes(node=>node.type==='button'&&text(node)===tx(action==='save'?'编辑':'移除'))[0].props.onClick())},
  submit(action,draft){return action==='save'?dialog(action).props.onSave(draft):dialog(action).props.onConfirm()},
 };
}

const refreshFailed='此连接已被更新，但自动刷新失败。当前填写内容已保留，请稍后重试。';
const refreshSucceeded='此连接已被更新，当前填写内容已保留。关闭后重新打开可查看最新配置。';
for (const action of ['save','delete']) for (const [locale,failureWords] of [
 ['zh-CN',/自动刷新失败/],['en-US',/automatic refresh failed/i],['ja-JP',/自動.*失敗/],['ko-KR',/자동.*실패/],
]) test(`${action} conflict reports failed refresh in ${locale} and recovers on another attempt`,async t=>{
 setLocale(locale);t.after(()=>setLocale('zh-CN'));
 const original={id:'a',name:'Original connector',revision:'v1',type:'http',url:'https://example.com/mcp'};
 const latest={...original,name:'Latest connector',revision:'v2'};
 const draft={...original,name:'Unsaved connector'};
 const refresh=wait(),writes=[];let reads=0;
 const conflict=()=>Object.assign(Error('fixture-sensitive-write-error'),{status:409});
 const f=await management(t,{
  mcpServers:async()=>{reads++;return reads===1?{servers:[original]}:reads===2?refresh.promise:{servers:[latest]}},
  upsertMcpServer:async(server,base)=>{writes.push({action:'save',server,base});throw conflict()},
  deleteMcpServer:async(id,base)=>{writes.push({action:'delete',id,base});throw conflict()},
 });
 f.open(action);
 const pending=f.submit(action,draft);await f.page.flush();
 assert.equal(reads,2);assert.equal(writes.length,1);
 assert.equal(writes[0].action,action);assert.deepEqual(writes[0].base,original);
 assert.ok(f.dialog(action),'the conflict does not close the active dialog');
 if(action==='save')assert.equal(f.dialog(action).props.busy,true);
 refresh.reject(Error('fixture-sensitive-refresh-error'));await pending;f.page.render();
 assert.ok(f.dialog(action));assert.match(text(f.page.render()),/Original connector/);
 assert.doesNotMatch(text(f.page.render()),/Latest connector/);
 if(action==='save'){
  assert.equal(f.dialog(action).props.busy,false);
  assert.deepEqual(f.dialog(action).props.initial,original);
  assert.equal(writes[0].server.name,draft.name);
 }
 assert.deepEqual(f.messages,[tx(refreshFailed)]);
 assert.match(f.messages[0],failureWords);
 assert.notEqual(f.messages[0],tx(refreshSucceeded));
 assert.doesNotMatch(f.messages.join(' '),/fixture-sensitive-/);
 await f.submit(action,draft);f.page.render();
 assert.equal(reads,3);assert.equal(writes.length,2);
 assert.deepEqual(writes[1].base,original,'a failed write never changes the optimistic revision');
 assert.match(text(f.page.render()),/Latest connector/);
 assert.ok(f.dialog(action),'refreshing the list does not discard the active draft or confirmation');
 if(action==='save')assert.equal(f.dialog(action).props.busy,false);
 assert.deepEqual(f.messages,[tx(refreshFailed),tx(refreshSucceeded)]);
 f.page.act(()=>f.dialog(action).props.onClose());
 f.open(action);
 if(action==='save')assert.deepEqual(f.dialog(action).props.initial,latest);
 else assert.match(f.dialog(action).props.text,/Latest connector/);
});

for(const action of ['save','delete'])test(`${action} failure without a conflict does not refresh the connector list`,async t=>{
 setLocale('zh-CN');t.after(()=>setLocale('zh-CN'));
 const original={id:'a',name:'Original connector',revision:'v1',type:'http',url:'https://example.com/mcp'};
 let reads=0,writes=0;
 const fail=async()=>{writes++;throw Object.assign(Error('Fixture write failure'),{status:503})};
 const f=await management(t,{mcpServers:async()=>{reads++;return{servers:[original]}},upsertMcpServer:fail,deleteMcpServer:fail});
 f.open(action);await f.submit(action,{...original,name:'Unsaved connector'});f.page.render();
 assert.equal(reads,1);assert.equal(writes,1);assert.ok(f.dialog(action));
 assert.match(text(f.page.render()),/Original connector/);
 assert.deepEqual(f.messages,[tx('保存失败：')+'Fixture write failure']);
 if(action==='save')assert.equal(f.dialog(action).props.busy,false);
});

test('typed private-key field accepts complete PEM paste without exposing or stripping lines',async t=>{
 const previous=globalThis.window;globalThis.window={SoduWorkConnectorConfig:connectorConfig,dispatchEvent(){}};t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous});
 const f=await form(t,null,{initial:{id:'fixture',name:'GCP fixture',type:'stdio',command:'soduwork-connector',args:['google-cloud']},
 template:{configurable:true,connectionFields:[{key:'GCP_PRIVATE_KEY',label:'Private key',secret:true,required:true}]}});
 const input=f.page.nodes(n=>n.type==='input'&&n.props.type==='password')[0];let prevented=false;
 f.page.act(()=>input.props.onPaste({clipboardData:{getData:()=> '-----BEGIN PRIVATE KEY-----\r\nfixture\r\n-----END PRIVATE KEY-----\r\n'},preventDefault(){prevented=true}}));
 await f.button('保存为停用配置').props.onClick();assert.equal(prevented,true);
 assert.equal(f.calls[0].env.GCP_PRIVATE_KEY,'-----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----');assert.equal(f.calls[0].enabled,false);
});


test('imported API uses declared auth fields and retains its source and restricted tools',async t=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
 const {compile}=require('../../skills/mcp-tools/connectors/api-definition.cjs');
 const definition=compile({name:'Projects',baseUrl:'https://api.example.com',securitySchemes:{auth:{type:'apiKey',name:'X-Key',in:'header'}},security:[{auth:[]}],endpoints:[{method:'GET',path:'/projects',name:'list_projects'}]});
 const f=await form(t,null,{initial:{id:'api',name:definition.name,type:'stdio',command:'soduwork-api',args:[],apiDefinition:definition,env:{},enabledTools:['list_projects']}});
 const input=f.page.nodes(n=>n.type==='input'&&n.props.type==='password')[0];assert.ok(input);
 f.page.act(()=>input.props.onChange({target:{value:'fixture-key'}}));
 await f.footer().props.onClick();assert.equal(f.calls.length,1);assert.equal(f.calls[0].apiDefinition.id,definition.id);
 assert.equal(f.calls[0].env.AUTH_AUTH_KEY,'fixture-key');assert.deepEqual(f.calls[0].enabledTools,['list_projects']);
});

test('device arguments use commas in probe and save and preserve imported argument boundaries', async t => {
 const expected=['-y','package','C:\\Team Work','a,b','', '--flag','--flag'];
 const f=await form(t,null,{initial:{name:'Device',type:'stdio',command:'npx',args:expected}});
 const input=()=>f.page.nodes(n=>n.type?.name==='AutoGrowTextarea')[0];
 assert.equal(input().props.value,argumentText.formatArguments(expected));
 assert.equal(input().props.minRows,5);
 await f.footer().props.onClick();
 assert.deepEqual(f.pending[0].args,expected);assert.deepEqual(f.calls[0].args,expected);
 const next=' -y, package, "a,b", --path=C:\\Team Work, , --flag, --flag ';
 f.page.act(()=>input().props.onChange({target:{value:next}}));
 await f.footer().props.onClick();
 assert.deepEqual(f.calls[1].args,['-y','package','a,b','--path=C:\\Team Work','--flag','--flag']);
});

test('invalid argument quotes show a localized error and never probe or save', async t => {
 t.after(()=>setLocale('zh-CN'));setLocale('en-US');
 const f=await form(t,null,{initial:{name:'Device',type:'stdio',command:'npx'}});
 const input=()=>f.page.nodes(n=>n.type?.name==='AutoGrowTextarea')[0];
 f.page.act(()=>input().props.onChange({target:{value:'-y, "unfinished'}}));
 assert.equal(input().props['aria-invalid'],true);
 assert.match(text(f.page.render()),/Close the double quote/);
 await f.footer().props.onClick();assert.equal(f.calls.length,0);assert.equal(f.pending.length,0);
});
