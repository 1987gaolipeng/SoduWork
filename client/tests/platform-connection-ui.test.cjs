// Renderer state regressions use inert local nodes and API replies, never real credentials.
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/platform-plugin-connect.js'),'utf8');
const status=(key,patch={})=>({ok:true,provider:key,installed:true,state:'needs_auth',connected:false,...patch});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(api,notifications=[]){
 const timers=new Map(),events=new Map(),catalog={items:[]};let next=0,layer;
 const window={soduWorkAPI:{platformConnections:api},SoduWorkCapabilityPlugins:{snapshot:()=>catalog},addEventListener:(name,handler)=>events.set(name,handler),dispatchEvent:event=>notifications.push(event.type)};
 window.SoduWorkPluginPlatforms=require('../core/plugin-platforms');
 vm.runInNewContext(source,{window,CustomEvent:class{constructor(type){this.type=type;}},setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
 const ctx={closeModal(){if(layer)layer.isConnected=false;},openModal(_title,_subtitle,body,footer){
  const nodes=new Map([...((body+footer).matchAll(/id="([^"]+)"/g))].map(m=>[m[1],{textContent:'',value:'',dataset:{},disabled:false,hidden:false}]));
  layer={isConnected:true,querySelector:sel=>nodes.get(sel.slice(1))||null};return layer;
 },refresh(){}};
 return{ui:window.SoduWorkPlatformConnections,timers,catalog,scopeChanged(){events.get('soduwork-data-scope-changed')();},direct(key,options){window.SoduWorkPlatformConnections.openProvider(key,ctx,options);const opened=layer;return {get:id=>opened.querySelector('#'+id)};},open(key,options){const item=typeof key==='string'?{key,personal:true}:key;window.SoduWorkPlatformConnections.open(item,ctx,options);const opened=layer;return{item,hide(){opened.hidden=true;},get:id=>opened.querySelector('#'+id)};}};
}

test('business plugin authorization covers all platforms and hydration shares checks',async()=>{
 const calls=[];const f=fixture({status:async key=>{calls.push(key);return status(key,{connected:key==='wecom'});}});
 const item={key:'weekly-brief',personal:true,capabilities:{platforms:['wecom','dingtalk']}};
 await f.ui.hydrate([item,{...item}]);
 assert.deepEqual(calls.sort(),['dingtalk','wecom']);
 assert.equal(f.ui.provider(item),'dingtalk');assert.equal(f.ui.ready(item),false);
 item.platformConnections.dingtalk=status('dingtalk',{connected:true});assert.equal(f.ui.ready(item),true);
});

test('continuation requires a connected account and an explicit click',async()=>{
 let continued=0;
 const f=fixture({refresh:async key=>status(key,{connected:true,state:'connected'})});
 const page=f.open('wecom',{onReady:()=>continued++});await tick();
 assert.equal(continued,0);assert.equal(page.get('capPlatformContinue').hidden,false);
 page.get('capPlatformContinue').onclick();assert.equal(continued,1);
});

test('connection changes invalidate slash plugins without a polling reload loop',async()=>{
 const notices=[];let connected=false;
 const f=fixture({refresh:async()=>status('feishu',{connected,state:connected?'connected':'needs_auth'})},notices);
 const page=f.open('feishu');await tick();notices.length=0;
 connected=true;await page.get('capPlatformCheck').onclick();
 assert.deepEqual(notices,['soduwork:plugins-changed']);
 await page.get('capPlatformCheck').onclick();assert.equal(notices.length,1);
 connected=false;await page.get('capPlatformCheck').onclick();assert.equal(notices.length,2);
 assert.equal(f.ui.ready(page.item),false);
});

test('closing shared modal with its outer controls prevents late connection starts',async()=>{
 let prepared,starts=0;
 const f=fixture({refresh:async()=>status('wecom',{installed:false}),prepare:()=>new Promise(r=>prepared=r),connect:async()=>starts++});
 const page=f.open('wecom');await tick();const pending=page.get('capPlatformStart').onclick();await tick();
 page.hide();prepared(status('wecom'));await pending;assert.equal(starts,0);
});
test('initial check blocks connect until the selected platform is known',async()=>{
 let done;const f=fixture({refresh:()=>new Promise(r=>{done=r;})});const page=f.open('wecom');
 assert.equal(page.get('capPlatformStart').disabled,true);
 done(status('wecom'));await tick();assert.equal(page.get('capPlatformStart').disabled,false);
 assert.equal(page.get('capPlatformAppSecret'),null);
});
test('failed recheck remains visible and does not keep stale ready state',async()=>{
 let calls=0;const f=fixture({refresh:async()=>{if(++calls>1)throw Error('检查失败，请重试');return status('wecom',{state:'connected',connected:true});}});
 const page=f.open('wecom');await tick();assert.equal(f.ui.ready(page.item),true);
 await page.get('capPlatformCheck').onclick();
 assert.match(page.get('capPlatformNote').textContent,/检查失败/);
 assert.equal(page.get('capPlatformState').dataset.state,'error');assert.equal(f.ui.ready(page.item),false);
});
test('a mismatched provider response cannot make another plugin ready',async()=>{
 const f=fixture({refresh:async()=>status('feishu',{state:'connected',connected:true}),status:async()=>status('feishu',{connected:true})});
 const page=f.open('wecom');await tick();
 assert.match(page.get('capPlatformNote').textContent,/平台与当前连接器不一致/);
 await f.ui.hydrate([page.item]);assert.equal(f.ui.ready(page.item),false);
 const stale={key:'dingtalk',personal:true,platformConnection:status('feishu',{connected:true})};
 assert.equal(f.ui.ready(stale),false);assert.ok(!f.ui.markup(stale).includes('账号已连接'));
});
test('closing during preparation does not begin a later authorization',async()=>{
 let prepared,starts=0;const f=fixture({refresh:async()=>status('wecom',{installed:false,state:'needs_setup'}),prepare:()=>new Promise(r=>{prepared=r;}),connect:async()=>{starts++;return status('wecom');}});
 const page=f.open('wecom');await tick();const pending=page.get('capPlatformStart').onclick();await tick();
 page.get('capPlatformClose').onclick();prepared(status('wecom'));await pending;assert.equal(starts,0);
});
test('reopening pending authorization resumes polling; stale polls cannot undo cancellation',async()=>{
 let reply;const waiting=status('wecom',{state:'awaiting_user',authUrl:'https://work.weixin.qq.com/fixture'});
 const f=fixture({refresh:async()=>waiting,status:()=>new Promise(r=>{reply=r;}),cancel:async()=>status('wecom')});
 const page=f.open('wecom');await tick();assert.equal(f.timers.size,1);
 const poll=[...f.timers.values()][0]();await tick();await page.get('capPlatformCancel').onclick();
 reply(waiting);await poll;assert.equal(page.get('capPlatformState').dataset.state,'needs_auth');
 assert.equal(page.get('capPlatformAuth').hidden,true);
});
test('Feishu has no credential fields and uses two public official authorization phases',async()=>{
 let phase='app_registration';
 const waiting=()=>status('feishu',{state:'awaiting_user',phase,authUrl:'https://accounts.feishu.cn/fixture',message:'扫码确认'});
 const f=fixture({refresh:async()=>status('feishu'),connect:async(key,body)=>{
  assert.equal(key,'feishu');assert.equal(Object.keys(body).length,0);return waiting();},
  status:async()=>waiting(),cancel:async()=>status('feishu')});
 const page=f.open('feishu');await tick();assert.equal(page.get('capPlatformAppId'),null);assert.equal(page.get('capPlatformAppSecret'),null);
 await page.get('capPlatformStart').onclick();assert.match(page.get('capPlatformAuthOpen').textContent,/扫码创建应用/);
 assert.equal(page.get('capPlatformCancel').hidden,false);assert.equal(page.get('capPlatformStart').disabled,true);
 phase='user_authorization';await [...f.timers.values()][0]();assert.match(page.get('capPlatformAuthOpen').textContent,/扫码授权/);
 await page.get('capPlatformCancel').onclick();assert.equal(page.get('capPlatformAuth').hidden,true);assert.equal(page.get('capPlatformStart').disabled,false);
});

test('installed legacy manifests get instructions for their own desktop entry',()=>{
 const f=fixture({});const names={wecom:'企业微信',dingtalk:'钉钉',feishu:'飞书'};
 for(const key of Object.keys(names)){
  const description=f.ui.setupDescription({key,personal:true,setup:{description:'旧版飞书钉钉企业微信说明'}});
  assert.ok(description.includes(names[key]));for(const other of Object.keys(names).filter(k=>k!==key))assert.ok(!description.includes(names[other]));
 }
 assert.equal(f.ui.setupDescription({key:'custom',setup:{description:'自定义说明'}}),'自定义说明');
});

test('enterprise packages use each employee desktop connection when they declare a platform',()=>{
 const f=fixture({});
 for(const key of ['feishu','wecom','dingtalk']){
  const bundled={key:'weekly-'+key,scope:'organization',personal:false,
   capabilities:{platforms:[key]},provenance:{publisherType:'platform'}};
  assert.equal(f.ui.provider(bundled),key);
  assert.deepEqual(f.ui.providers(bundled),[key]);
  assert.equal(f.ui.provider({key,scope:'organization',personal:false}),'',
   'an undeclared organization plugin cannot claim a reserved provider key');
 }
});


test('official QR is visible in the dialog and disappears after success or cancellation',async()=>{
 let next=status('wecom',{state:'awaiting_user',qrCode:'data:image/png;base64,iVBORw0KGgo=',authUrl:'https://work.weixin.qq.com/fixture'});
 const f=fixture({refresh:async()=>next,status:async()=>next,cancel:async()=>status('wecom')});
 const page=f.open('wecom');await tick();assert.equal(page.get('capPlatformQr').hidden,false);
 assert.equal(page.get('capPlatformQr').src,next.qrCode);assert.equal(page.get('capPlatformAuth').hidden,false);
 next=status('wecom',{state:'connected',connected:true});await [...f.timers.values()][0]();
 assert.equal(page.get('capPlatformQr').hidden,true);assert.equal(page.get('capPlatformQr').src,'');assert.equal(page.get('capPlatformAuth').hidden,true);
 await page.get('capPlatformCancel').onclick();assert.equal(page.get('capPlatformQr').src,'');
});

test('QR renderer rejects remote URLs and non-PNG content',async()=>{
 for(const qrCode of ['https://untrusted.test/qr','data:image/svg+xml;base64,PHN2Zz4=']){
  const f=fixture({refresh:async()=>status('wecom',{state:'awaiting_user',qrCode})});const page=f.open('wecom');await tick();
  assert.equal(page.get('capPlatformQr').hidden,true);assert.equal(page.get('capPlatformQr').src,'');
 }
});

test('connector directory opens an account without a business plugin',async()=>{
 const calls=[],states=[];
 const f=fixture({refresh:async key=>{calls.push(key);return status(key,{connected:true,state:'connected'});}});
 const page=f.direct('wecom',{onState:value=>states.push(value.state)});await tick();
 assert.deepEqual(calls,['wecom']);assert.equal(page.get('capPlatformState').textContent,'已连接');
 assert.ok(states.includes('connected'));assert.equal(page.get('capPlatformContinue').hidden,true);
 assert.doesNotThrow(()=>f.ui.openProvider('unknown',{}));
});


test('disconnect requires confirmation, cancellation preserves the account, and success allows reconnect',async()=>{
 let disconnects=0,connects=0;const changes=[];
 const f=fixture({refresh:async key=>status(key,{state:'connected',connected:true}),
  disconnect:async key=>{disconnects++;return status(key,{state:'disconnected',disconnected:true});},
  connect:async key=>{connects++;return status(key,{state:'awaiting_user'});}});
 const page=f.direct('wecom',{onState:value=>changes.push(value)});await tick();
 assert.equal(page.get('capPlatformDisconnect').hidden,false);
 page.get('capPlatformDisconnect').onclick();assert.equal(disconnects,0);
 assert.equal(page.get('capPlatformDisconnectConfirm').hidden,false);assert.equal(page.get('capPlatformStart').disabled,true);
 await page.get('capPlatformStart').onclick();assert.equal(connects,0);
 page.get('capPlatformKeep').onclick();assert.equal(disconnects,0);assert.equal(page.get('capPlatformState').dataset.state,'connected');
 page.get('capPlatformDisconnect').onclick();await page.get('capPlatformDisconnectApply').onclick();
 assert.equal(disconnects,1);assert.equal(page.get('capPlatformDisconnectConfirm').hidden,true);
 assert.equal(page.get('capPlatformState').dataset.state,'disconnected');assert.equal(page.get('capPlatformStart').textContent,'重新连接');
 assert.equal(page.get('capPlatformDisconnect').hidden,true);assert.equal(changes.at(-1).connected,false);
 await page.get('capPlatformStart').onclick();assert.equal(connects,1);
});

test('disconnect failure reports the local barrier and can retry without claiming success',async()=>{
 let calls=0;const f=fixture({refresh:async key=>status(key,{state:'connected',connected:true}),disconnect:async key=>{
  calls++;return calls===1?{ok:false,provider:key,state:'error',disconnected:true,reason:'后台停用未同步，请重试'}:status(key,{state:'disconnected',disconnected:true});}});
 const page=f.open('wecom');await tick();
 page.get('capPlatformDisconnect').onclick();await page.get('capPlatformDisconnectApply').onclick();
 assert.equal(page.get('capPlatformState').dataset.state,'error');assert.equal(f.ui.ready(page.item),false);
 assert.equal(page.item.platformConnection.disconnected,true);assert.match(page.get('capPlatformNote').textContent,/未同步/);
 assert.equal(page.get('capPlatformDisconnect').hidden,false);
 page.get('capPlatformDisconnect').onclick();await page.get('capPlatformDisconnectApply').onclick();
 assert.equal(calls,2);assert.equal(page.get('capPlatformState').dataset.state,'disconnected');
});

test('rapid confirmation sends once and a late disconnect cannot overwrite a replacement modal',async()=>{
 let resolve,calls=0;const f=fixture({refresh:async key=>status(key,{state:'connected',connected:true}),disconnect:key=>{calls++;return new Promise(r=>resolve=r);}});
 const a=f.open('wecom');await tick();a.get('capPlatformDisconnect').onclick();
 const saving=a.get('capPlatformDisconnectApply').onclick();await a.get('capPlatformDisconnectApply').onclick();assert.equal(calls,1);
 a.get('capPlatformClose').onclick();const b=f.open('dingtalk');await tick();
 resolve(status('wecom',{state:'disconnected',disconnected:true}));await saving;
 assert.equal(b.get('capPlatformState').dataset.state,'connected');assert.equal(f.ui.ready(b.item),true);
});

test('older desktop bridges do not expose a nonfunctional disconnect action',async()=>{
 const f=fixture({refresh:async key=>status(key,{state:'connected',connected:true})});const page=f.open('wecom');await tick();
 assert.equal(page.get('capPlatformDisconnect').hidden,true);
});


test('disconnect updates cached business plugins and rejects late catalog authorization',async()=>{
 let resolve;const f=fixture({refresh:async key=>status(key,{state:'connected',connected:true}),status:()=>new Promise(r=>resolve=r),
  disconnect:async key=>status(key,{state:'disconnected',disconnected:true})});
 const first={key:'wecom',personal:true},second={key:'weekly',capabilities:{platforms:['wecom']}};f.catalog.items=[first,second];
 const page=f.direct('wecom');await tick();assert.equal(f.ui.ready(first),true);assert.equal(f.ui.ready(second),true);
 const incoming={key:'wecom',personal:true};const loading=f.ui.hydrate([incoming]);
 page.get('capPlatformDisconnect').onclick();await page.get('capPlatformDisconnectApply').onclick();
 resolve(status('wecom',{state:'connected',connected:true}));await loading;
 assert.equal(f.ui.ready(first),false);assert.equal(f.ui.ready(second),false);assert.equal(f.ui.ready(incoming),false);
});

test('account change prevents a late refresh from modifying the current dialog or catalog',async()=>{
 let resolve;const f=fixture({refresh:()=>new Promise(r=>resolve=r)});const page=f.open('wecom');
 f.scopeChanged();resolve(status('wecom',{state:'connected',connected:true}));await tick();
 assert.equal(f.ui.ready(page.item),false);assert.notEqual(page.get('capPlatformState').dataset.state,'connected');
});
