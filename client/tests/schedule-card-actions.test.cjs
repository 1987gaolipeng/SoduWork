'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules.css'),'utf8');
function context(){const c={esc:s=>String(s).replaceAll('"','&quot;'),window:{addEventListener(){}}};vm.createContext(c);vm.runInContext(source,c);return c;}
test('all four schedule actions are icon-only named native buttons with original actions',()=>{
  const c=context();
  for(const [act,label] of [['run','立刻跑一次'],['runs','执行记录'],['edit','编辑自动化'],['del','删除自动化']]){
    const html=c._schActionButton(act,label);
    assert.match(html,/type="button"/);assert.ok(html.includes('data-act="'+act+'"'));
    assert.ok(html.includes('aria-label="'+label+'"'));assert.ok(html.includes('title="'+label+'"'));
    assert.match(html,/<svg[^>]*aria-hidden="true"/);
    assert.equal(html.replace(/<[^>]*>/g,''),'');
    if(['runs','edit'].includes(act))assert.match(html,/aria-haspopup="dialog" aria-expanded="false"/);
  }
});
test('pending execution keeps an icon and accessible busy state; restoring never returns visible text',()=>{
  const c=context(),attrs={},button={setAttribute:(k,v)=>attrs[k]=v};
  c._schSetRunBusy(button,true);assert.equal(button.disabled,true);assert.equal(attrs['aria-busy'],'true');
  assert.equal(attrs['aria-label'],'正在提交执行');assert.match(button.innerHTML,/<circle/);
  c._schSetRunBusy(button,false);assert.equal(button.disabled,false);assert.equal(attrs['aria-busy'],'false');
  assert.equal(button.title,'立刻跑一次');assert.equal(button.innerHTML,c._schActionIcon('run'));
});
test('repeated execution of an already disabled run button cannot submit again',async()=>{
  const c=context();vm.runInContext('_schRows=[{id:"one"}]',c);
  c.SoduWorkAPI={runSchedule:()=>{throw Error('must not dispatch')}};
  await c._schAct('run','one',{disabled:true});
});

test('failed delete keeps the plan and reports failure, without a success notification',async()=>{
  const c=context(),handlers={},notices=[];let removed=false,reloads=0;
  const card={querySelector:()=>null,appendChild(){},classList:{add(){},remove(){}}};
  const bar={querySelector:key=>({addEventListener:(_name,fn)=>{handlers[key]=fn}}),remove(){removed=true}};
  c.document={querySelector:()=>card,createElement:()=>bar};
  c.petSay=text=>notices.push(text);c._loadSch=()=>reloads++;
  c.SoduWorkAPI={deleteSchedule:async()=>{throw Error('connection offline')}};
  vm.runInContext('_schRows=[{id:"one",title:"Work"}]',c);
  c._schConfirmDel('one',{title:'Work'});await handlers['[data-c="yes"]']();
  assert.equal(vm.runInContext('_schRows.length',c),1);assert.equal(reloads,0);
  assert.ok(removed);assert.equal(notices.length,1);assert.match(notices[0],/没删掉|删除失败/);
  assert.doesNotMatch(notices[0],/删掉了定时任务/);
});
test('scoped toolbar styles retain fixed geometry, theme colors, keyboard focus and reduced motion',()=>{
  assert.match(css,/\.sch-i-ops \.sch-icon-action\{[^}]*width:32px;height:32px/);
  assert.match(css,/\.sch-icon-action svg\{[^}]*stroke:currentColor/);
  assert.match(css,/\.sch-icon-action:focus-visible/);
  assert.match(css,/@media\(pointer:coarse\)[^\n]*width:44px;height:44px/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)[^\n]*animation:none/);
  assert.doesNotMatch(css,/\.sch-i-ops \.btn-mini/);
  assert.match(source,/_schConfirmDel\(sid, s\)/);
});
