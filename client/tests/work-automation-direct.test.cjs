'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(overrides = {}) {
  const writes = [], events = {}, parses = [], scope = { value: 'owner-a' };
  const api = { taskStorageKey: () => scope.value,
    taskExecutionOptions: async () => ({ substrates: [{key:'local:pi',name:'Pi',available:true}],repos:[] }),
    parseTaskText: async (...args) => { parses.push(args); return {title:'采集行业资料', note:'整理来源与摘要'}; },
    preflightSchedule: async () => ({state:'ready'}),
    createSchedule: async body => { writes.push(body); return {id:'schedule-1',...body}; }, ...overrides };
  const window = { SoduWorkAPI: api, addEventListener: (name, cb) => { events[name] = cb; }, _schmLoad: async () => [] };
  const ctx = vm.createContext({window, Intl, Date, Map, Set, Promise, String, Number, Object,
    setTimeout,clearTimeout, SoduWorkAPI:api});
  for (const name of ['schedule-timing','work-automation-bindings','work-automation-card-state','work-automation-sheet','work-automation-direct']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../components/panels',name+'.js'),'utf8'),ctx);
  }
  return {direct:window.WorkAutomationDirect, window,api,writes,parses,events,scope};
}
const params = text => ({text,context:{spaceId:'space-a',spaceName:'研发空间',page:'https://ops.example/资料/index.html',appName:'运营云端版'}});
test('direct entry parses /自动化 and creates once without opening a form; full text and space are retained', async () => {
  const f=fixture(), text='每天早上9点采集 AI 资料，保留来源。\n'+ '原始要求'.repeat(600);
  const result=await f.direct.create(params(text));
  assert.equal(result.state,'created');assert.equal(result.schedule.id,'schedule-1');assert.equal(f.writes.length,1);
  const body=f.writes[0];assert.equal(body.atHour,9);assert.equal(body.every,'daily');assert.equal(body.timeZone,'Asia/Shanghai');
  assert.match(body.note,/space-a/);assert.ok(body.note.includes(text));assert.equal(body.assigneeId,'local:pi');
  assert.ok(f.parses[0][0].startsWith('/自动化 '));assert.equal(f.parses[0][3].kind,'automation');
  assert.equal(f.window.WorkAutomationSheet.hasSurface(),false);
});
test('one-off keeps its date; missing date and unsupported monthly frequency never become daily',async()=>{
  const f=fixture();
  const once=await f.direct.create(params('2030年12月20日晚上8点执行一次，采集资料'));
  assert.equal(once.schedule.every,'once');assert.equal(f.writes[0].runAt,'2030-12-20T12:00:00.000Z');
  await assert.rejects(f.direct.create(params('执行一次，收集资料')),/日期|时间/);
  await assert.rejects(f.direct.create(params('每月5日收集资料')),/月度|支持/);
  await assert.rejects(f.direct.create(params('每两小时收集资料')),/支持/);
  await assert.rejects(f.direct.create(params('每天25点收集资料')),/时间无效/);
  assert.equal(f.writes.length,1);
});
test('parse errors, unavailable named executor, missing agent and blocked preflight cannot create',async()=>{
  for(const overrides of [
    {parseTaskText:async()=>({_parseError:'模型解析失败'})},
    {taskExecutionOptions:async()=>({substrates:[],repos:[]})},
    {preflightSchedule:async()=>({state:'blocked',message:'执行权限不足'})}
  ]){
    const f=fixture(overrides);await assert.rejects(f.direct.create(params('每天9点采集资料')));assert.equal(f.writes.length,0);
  }
  const f=fixture();await assert.rejects(f.direct.create(params('使用不存在的工作方法，每天9点采集资料')));assert.equal(f.writes.length,0);
});
test('identity change during parsing aborts; transport failure after create stays uncertain',async()=>{
  const f=fixture();f.api.parseTaskText=async()=>{f.scope.value='owner-b';return {title:'new'};};
  await assert.rejects(f.direct.create(params('每天9点采集资料')),/账号已变化/);assert.equal(f.writes.length,0);
  const failed=fixture({createSchedule:async()=>{throw Error('network');}});
  const result=await failed.direct.create(params('每天9点采集资料'));assert.equal(result.uncertain,true);assert.equal(result.ok,false);
});
test('unspecified time uses disclosed 18:00 default and waiting preflight is visible in receipt',async()=>{
  const f=fixture({preflightSchedule:async()=>({state:'waiting',message:'执行机离线'})});
  const result=await f.direct.create(params('采集行业资料'));
  assert.equal(result.schedule.every,'daily');assert.equal(result.schedule.atHour,18);assert.equal(result.executionState,'waiting');
  assert.equal(result.message,'执行机离线');
});
test('permission is checked again after parsing/preflight and immediately before creation',async()=>{
  const f=fixture();await assert.rejects(f.direct.create(params('每天9点采集资料'),{authorize:async()=>{throw Error('应用已停用');}}),/停用/);
  assert.equal(f.writes.length,0);
});


test('explicit no-retry automation keeps the next schedule but disables run retries',async()=>{
  for(const policy of ['本次失败不自动重试。','禁止自动重试','No automatic retries.','Do not retry.']){
    const f=fixture();await f.direct.create(params('每天9点采集运营数据。'+policy));
    assert.equal(f.writes[0].retryLimit,0);assert.equal(f.writes[0].enabled,true);
    assert.match(f.writes[0].note,/应用任务上下文/);assert.doesNotMatch(f.writes[0].note,/内容素材知识库任务上下文/);
  }
  const f=fixture();await f.direct.create(params('每天9点采集资料'));assert.equal(f.writes[0].retryLimit,2);
});
