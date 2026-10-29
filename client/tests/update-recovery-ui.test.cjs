'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture() {
  function element() { return { children: [], listeners: {}, append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); }, replaceChildren() { this.children = []; },
    addEventListener(event, fn) { this.listeners[event] = fn; } }; }
  const elements = Object.fromEntries(['Badge','Dot','Title','Detail','Action','Blockers'].map(name => ['clientUpdate'+name,element()]));
  const calls = [], rows = Array.from({length:7},(_,i)=>({kind:'conversation',ref:'ref-'+i,id:'chat-'+i,title:'Task '+i}));
  const state = {state:'waiting',targetVersion:'1.12.45',blockers:rows};
  const bridge = {clientUpdateStatus:async()=>state,resolveClientUpdate:async action=>{calls.push(action);return state;}};
  const context = vm.createContext({document:{getElementById:id=>elements[id],createElement:element},
    window:{soduWorkAPI:bridge,WorkspaceHost:{}},soduWorkAPI:bridge,
    WorkspaceHost:{open:(...args)=>calls.push(args)},closeSettings:()=>{},console});
  const src = fs.readFileSync(path.join(__dirname,'../components/settings/settings.js'),'utf8');
  vm.runInContext(src.slice(src.indexOf('let _clientUpdateState'),src.indexOf('function _bindSettingsEvents(')),context);
  context._paintClientUpdateStatus(state);
  return {elements,calls,context,state};
}
test('all blocking work is visible, local stop and navigation use the selected identity',async()=>{
  const f=fixture(), list=f.elements.clientUpdateBlockers;
  assert.equal(list.hidden,false);assert.equal(list.children.length,8);
  const row=list.children[6];
  await row.children[2].listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{kind:'conversation',id:'ref-6'});
  row.children[3].listeners.click();
  assert.equal(f.calls[1][1].chatId,'chat-6');
});
test('waiting installation has an enabled cancellation action and keeps blockers after deferral',async()=>{
  const f=fixture();f.context._bindClientUpdateStatus();
  assert.equal(f.elements.clientUpdateAction.disabled,false);
  assert.equal(f.elements.clientUpdateAction.textContent,'取消本次等待');
  await f.elements.clientUpdateAction.listeners.click();
  assert.equal(f.calls[0].action,'cancel-wait');
  f.context._paintClientUpdateStatus({...f.state,state:'deferred'});
  assert.equal(f.elements.clientUpdateBlockers.hidden,false);
  assert.equal(f.elements.clientUpdateAction.textContent,'安全安装');
});
