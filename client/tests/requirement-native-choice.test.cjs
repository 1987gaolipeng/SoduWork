'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function fixture(probe = {ok:true}) {
  const calls = [];
  const window = {soduWorkAPI:{conversationSession:{probe:async id=>{calls.push(id);return probe;}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/requirements/requirement-session-choice.js'),'utf8'),{window,setTimeout,clearTimeout});
  return {api:window.RequirementSessionChoice, calls};
}
test('后台 Runner 列表为空时，经过本机探测的 Pi 仍可作为直接对话执行入口', async()=>{
  const f=fixture(); const option=await f.api.nativeOption({selection:{},substrates:[]});
  assert.equal(option.id,'native:pi'); assert.equal(option.available,true);
  assert.deepEqual(f.calls,['pi']);
});
test('原生探测失败不伪造可用底座，工程执行仍保留受管路径校验', async()=>{
  assert.equal(await fixture({ok:false,reason:'missing'}).api.nativeOption({}),null);
  const f=fixture(); assert.equal(await f.api.nativeOption({selection:{repoId:'repo'}}),null);
  assert.equal(f.calls.length,0);
});
