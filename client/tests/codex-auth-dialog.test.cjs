'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/codex-auth-dialog.js'), 'utf8');
function fixture() {
  const window = { addEventListener() {} }; vm.runInNewContext(source, { window }); return window.CodexAuthDialog;
}
test('device metadata accepts only official exact URLs, bounded codes and recognized states', () => {
  const api = fixture(), valid = {state:'waiting',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH',expiresAt:1000};
  assert.equal(api.metadata(valid).userCode,'ABCD-EFGH');
  for (const verificationUrl of ['javascript:alert(1)','https://evil.invalid/','https://auth.openai.com/codex/device?token=secret','https://auth.openai.com/codex/device#secret']) assert.equal(api.metadata({...valid,verificationUrl}),null);
  for (const userCode of ['<script>','Bearer secret','A'.repeat(99),'ABCD EFGH']) assert.equal(api.metadata({...valid,userCode}),null);
  for (const expiresAt of [undefined,NaN,Infinity,0,-1]) assert.equal(api.metadata({...valid,expiresAt}),null);
  assert.equal(api.metadata({state:'future',access_token:'secret'}),null);
  assert.deepEqual(JSON.parse(JSON.stringify(api.metadata({state:'succeeded',access_token:'secret'}))),{state:'succeeded'});
});
test('cancellation transport retains the original qualified job and cannot leak it into install actions', async () => {
  const api = fs.readFileSync(path.join(__dirname,'../api.js'),'utf8');
  const start = api.indexOf('    async agentInstall('), end = api.indexOf('    async agentProbe(',start);
  const calls = [], context = {jfetch:async(url,options)=>{calls.push(JSON.parse(options.body));return{jobId:'job'}},mark(){}};
  const method = vm.runInNewContext('({' + api.slice(start,end) + '})',context).agentInstall;
  await method('codex','login-cancel','runner-a',{jobId:'runner|runner-a|job-a'});
  await method('codex','login','runner-a',{jobId:'unrelated'});
  await method('pi','install','runner-b');
  assert.deepEqual(calls,[{key:'codex',action:'login-cancel',runnerId:'runner-a',jobId:'runner|runner-a|job-a'},
    {key:'codex',action:'login',runnerId:'runner-a'},{key:'pi',action:'install',runnerId:'runner-b'}]);
});

test('every authorization message translates through the production locale manifest', () => {
  const context=vm.createContext({Intl,Map,Set,Object,localStorage:{getItem:()=>null,setItem(){}},
    document:{readyState:'loading',documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener(){}},
    CustomEvent:class{},addEventListener(){},dispatchEvent(){},setTimeout,clearTimeout});
  vm.runInContext('window=globalThis',context);
  const root=path.join(__dirname,'../core');
  for(const file of JSON.parse(fs.readFileSync(path.join(root,'locales/manifest.json'),'utf8')))
    vm.runInContext(fs.readFileSync(path.join(root,'locales',file),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'i18n.js'),'utf8'),context);
  const messages=[...new Set([...source.matchAll(/'([^'\n]*[\u3400-\u9fff][^'\n]*)'/g)].map(match=>match[1]))];
  assert.ok(messages.length>30);
  for(const locale of ['en-US','ja-JP','ko-KR']) {
    context.SoduWorkI18n.setLocale(locale);
    for(const message of messages) assert.notEqual(context.SoduWorkI18n.translateText(message),message,`${locale}: ${message}`);
  }
});
