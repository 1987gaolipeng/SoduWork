'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const {project} = require('../main/personal-plugin-permissions.cjs');
const base = {requestId:'request-1',policyRevision:1};
test('native edit approval shows its files without leaking replacement content',()=>{
  const cwd=path.resolve('test-workspace');
  const row=project({...base,action:'native.tool',kind:'edit',arguments:{changes:[{path:path.join(cwd,'index.html'),newText:'secret body'}]}},{cwd});
  assert.equal(row.summary,'修改文件');assert.equal(row.detail,'index.html');assert.equal(row.reviewable,true);
  assert.doesNotMatch(JSON.stringify(row),/secret body/);
});
test('commands retain actual operation while masking credential forms and caller secrets',()=>{
  const row=project({...base,action:'native.command',arguments:{command:'curl https://alice:password@example.invalid/?token=one --password "two words" -H "Authorization: Bearer abc123"; KEY=value; token="three words"; opaque-private-secret'}},{redact:x=>x.replaceAll('opaque-private-secret','[hidden]')});
  assert.match(row.detail,/curl/);assert.match(row.detail,/KEY=value/);
  for(const secret of ['alice:password','token=one','two words','abc123','three words','opaque-private-secret'])assert.equal(row.detail.includes(secret),false,secret);
});
test('absolute outside targets remain visible and overlong operations cannot be approved blindly',()=>{
  const cwd=path.resolve('test-workspace'), outside=path.resolve('outside.txt');
  assert.equal(project({...base,action:'file.read',target:outside},{cwd}).detail,outside);
  const row=project({...base,action:'command.execute',target:'a'.repeat(12001)});
  assert.equal(row.reviewable,false);assert.equal(row.detail.length,12000);
  assert.equal(project({...base,policyRevision:'1'}),null);
});

test('a vague command title cannot substitute for a reviewable operation',()=>{
const row=project({...base,action:'native.command',title:'Please allow my command'});assert.equal(row.reviewable,false);assert.equal(row.detail,'');
});

test('question projection preserves opaque IDs while safely displaying the question and bounded choices',()=>{
  const options=[{optionId:'q0_opt_0',name:'First',kind:'allow_once'},
    {optionId:'q0_opt_1',name:'Second private-value',kind:'allow_once'},{optionId:'skip',name:'Skip',kind:'reject_once'}];
  const row=project({...base,action:'native.question',title:'Choose private-value',options},{redact:x=>x.replaceAll('private-value','[hidden]')});
  assert.equal(row.action,'native.question');assert.equal(row.reviewable,true);assert.equal(row.detail,'Choose [hidden]');
  assert.deepEqual(row.options.map(option=>option.optionId),options.map(option=>option.optionId));
  assert.equal(row.options[1].name,'Second [hidden]');assert.equal(row.options[2].kind,'reject_once');
  for(const invalid of [[],[options[0],options[0]],Array(65).fill(options[0]),[{...options[0],kind:'allow_always'}]]) {
    const rejected=project({...base,action:'native.question',title:'Choose',options:invalid});
    assert.equal(rejected.reviewable,false);assert.deepEqual(rejected.options,[]);
  }
});

test('workflow question card submits the selected choice and cancellation with the displayed revision',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{El}=require('./fixture/chat-draft-harness.cjs');
  class Element extends El {
    append(...children){for(const child of children)this.appendChild(child);}
    prepend(child){this.insertBefore(child,this.firstChild);}
    replaceChildren(...children){this.children=[];this.append(...children);}
    get parentElement(){return this.parent;}
    querySelector(selector){
      if(selector==='span:not(.pdebug-status)')return this.querySelectorAll('span').find(item=>!item.classList.contains('pdebug-status'));
      return super.querySelector(selector);
    }
  }
  const host=new Element('div'),content=new Element('div'),root=new Element('section');root.append(content);
  const replies=[],permission={requestId:'question-1',policyRevision:2,action:'native.question',detail:'Choose <one>',reviewable:true,
    options:[{optionId:'first',name:'First',kind:'allow_once'},{optionId:'second<>',name:'<Second>',kind:'allow_once'}]};
  const run={id:'run-1',revision:3,status:'running',mode:'debug',name:'Example',version:'1',
    nodes:[{key:'node-1',name:'Example',status:'running',pendingPermissions:[permission]}]};
  const window={NativeChat:{sessionInfo:()=>({ref:'chat-a'})},PluginUIHost:{registerAction(){},
    mount:()=>({root,content,inline:true,destroy(){}})},soduWorkAPI:{personalPlugins:{
      debug:async(ref,payload)=>{if(payload.command!=='get')replies.push({ref,...payload});return{ok:true,run};}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/plugin-debug-card.js'),'utf8'),{
    window,document:{createElement:tag=>new Element(tag)},setTimeout(){return 0;},clearTimeout(){}
  });
  await window.PluginDebugCard.open({ref:'chat-a',host});
  const prompt=content.querySelector('.pdebug-confirm');assert.ok(prompt);
  const buttons=prompt.querySelectorAll('button');assert.deepEqual(buttons.map(button=>button.textContent),['取消','First','<Second>']);
  assert.equal(prompt.querySelector('pre').textContent,'Choose <one>');assert.deepEqual(replies,[]);
  await buttons[2]._listeners.click[0]();
  await buttons[0]._listeners.click[0]();
  assert.deepEqual(replies,[{ref:'chat-a',requestId:'question-1',policyRevision:2,decision:'answer',optionId:'second<>',
    command:'permission',runId:'run-1',revision:3,nodeKey:'node-1'},
   {ref:'chat-a',requestId:'question-1',policyRevision:2,decision:'deny',command:'permission',runId:'run-1',revision:3,nodeKey:'node-1'}]);
});
